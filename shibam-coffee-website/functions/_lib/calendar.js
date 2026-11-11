// Portal calendar: database layer. Public handlers take a raw booking or manage
// token (routed by functions/api/book.js); authenticated handlers use the
// portal session like every other action.
import { audit, requireRole } from './auth.js';
import { anonymizeExpiredBookingsStatement } from './calendar-retention.js';
import { notifyUser } from './scheduling.js';
import {
  ApiError, clampInt, newId, normalizeDate, nowIso, safeJsonParse, sha256Hex
} from './http.js';
import {
  addDaysToDate, bookingBlock, expandAvailability, generateSlots, isValidTimezone, normalizeEmail,
  redactBooking, canViewBooking, timeOffToIntervals, toIso, wallToUtc
} from './calendar-rules.js';

const MAX_NAME = 120;
const MAX_ANSWER = 1000;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nowMs(now) {
  return now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.now());
}

// Creates a link and returns the raw token. Lookups use the hash; the token itself is
// kept so the owner can view and copy the link again (it is erased on revoke, and
// only the owner and Management are ever sent it).
export async function createLinkRecord(db, { eventTypeId, label = '', expiresAt = null, maxUses = null }) {
  const token = randomToken();
  const id = newId('blink');
  await db.prepare(`INSERT INTO booking_links (id, event_type_id, token_hash, token, label, expires_at, max_uses, use_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
    .bind(id, eventTypeId, await sha256Hex(token), token, String(label).slice(0, 120), expiresAt, maxUses, nowIso()).run();
  return { id, token };
}

const LINK_SELECT = `SELECT l.id AS link_id, l.expires_at, l.max_uses, l.use_count, l.revoked_at,
      e.id AS event_type_id, e.owner_id, e.name, e.description, e.duration_minutes, e.buffer_before_minutes,
      e.buffer_after_minutes, e.min_notice_minutes, e.max_days_ahead, e.slot_interval_minutes, e.questions_json,
      e.active AS event_active, m.id AS location_id, m.name AS location_name, m.address_line1, m.address_line2,
      m.city, m.state, m.postal_code, m.notes AS location_notes, m.active AS location_active, u.name AS owner_name, u.active AS owner_active
    FROM booking_links l
    JOIN event_types e ON e.id = l.event_type_id
    JOIN meeting_locations m ON m.id = e.location_id
    JOIN users u ON u.id = e.owner_id`;

// Unknown, revoked, expired and exhausted links all return the same error so
// a token cannot be probed for its state. Inactive event types and archived
// locations are also "not found" to the public.
export async function resolveLink(env, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new ApiError('link_not_found', 404);
  const row = await env.TEAM_DB.prepare(`${LINK_SELECT} WHERE l.token_hash = ?`).bind(await sha256Hex(token)).first();
  const expired = row?.expires_at && Date.parse(row.expires_at) <= nowMs(now);
  const exhausted = row && row.max_uses !== null && row.use_count >= row.max_uses;
  if (!row || row.revoked_at || expired || exhausted || !row.event_active || !row.location_active || !row.owner_active) {
    throw new ApiError('link_not_found', 404);
  }
  return row;
}

// Someone who already booked may still change or cancel it after the link was
// revoked, expired or used up. Only an archived meeting type, address or owner
// stops a reschedule.
async function linkForBooking(env, booking) {
  const row = await env.TEAM_DB.prepare(`${LINK_SELECT} WHERE l.id = ?`).bind(booking.link_id).first();
  if (!row || !row.event_active || !row.location_active || !row.owner_active) throw new ApiError('reschedule_unavailable', 409);
  return row;
}

export function linkView(link) {
  return {
    name: link.name,
    description: link.description,
    durationMinutes: link.duration_minutes,
    ownerFirstName: String(link.owner_name || '').split(' ')[0],
    location: locationSnapshot(link),
    questions: safeJsonParse(link.questions_json, [])
  };
}

function locationSnapshot(link) {
  return {
    id: link.location_id,
    name: link.location_name,
    addressLine1: link.address_line1,
    addressLine2: link.address_line2,
    city: link.city,
    state: link.state,
    postalCode: link.postal_code,
    notes: link.location_notes
  };
}

async function ownerSettings(env, ownerId) {
  const row = await env.TEAM_DB.prepare('SELECT timezone, avoid_shifts FROM booking_settings WHERE owner_id = ?').bind(ownerId).first();
  const zone = row?.timezone || env.STORE_TIMEZONE || 'America/New_York';
  return { timezone: isValidTimezone(zone) ? zone : 'America/New_York', avoidShifts: !!row?.avoid_shifts };
}

// Published, active work shifts as busy intervals. Shift times are wall-clock
// in the location's timezone; an end at or before the start runs past midnight.
async function shiftIntervals(env, ownerId, fromIso, toIso_) {
  const fromDate = addDaysToDate(fromIso.slice(0, 10), -1);
  const toDate = addDaysToDate(toIso_.slice(0, 10), 1);
  const { results } = await env.TEAM_DB.prepare(`SELECT s.shift_date, s.start_time, s.end_time, l.timezone
    FROM shifts s JOIN schedules sc ON sc.id = s.schedule_id JOIN locations l ON l.id = sc.location_id
    WHERE s.employee_id = ? AND s.status = 'active' AND sc.status = 'published'
      AND s.shift_date >= ? AND s.shift_date <= ?`).bind(ownerId, fromDate, toDate).all();
  const minutes = (value) => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
  const intervals = [];
  for (const shift of results) {
    const zone = isValidTimezone(shift.timezone) ? shift.timezone : 'America/New_York';
    const start = wallToUtc(shift.shift_date, minutes(shift.start_time), zone);
    const endMinutes = minutes(shift.end_time);
    const end = wallToUtc(shift.shift_date, endMinutes <= minutes(shift.start_time) ? endMinutes + 1440 : endMinutes, zone);
    if (start !== null && end !== null && end > start) intervals.push({ start, end });
  }
  return intervals;
}

// Everything that makes an owner busy between two instants.
async function loadBusy(env, ownerId, fromIso, toIso_, timezone, avoidShifts, ignoreBookingId = '') {
  const db = env.TEAM_DB;
  const [bookings, events, timeOff, shifts] = await Promise.all([
    db.prepare(`SELECT blocks_start_utc, blocks_end_utc FROM bookings
      WHERE owner_id = ? AND status = 'confirmed' AND blocks_end_utc > ? AND blocks_start_utc < ? AND id != ?`)
      .bind(ownerId, fromIso, toIso_, ignoreBookingId).all(),
    db.prepare(`SELECT start_utc, end_utc FROM team_events
      WHERE created_by = ? AND blocks_availability = 1 AND end_utc > ? AND start_utc < ?`)
      .bind(ownerId, fromIso, toIso_).all(),
    db.prepare(`SELECT start_date, end_date, start_time, end_time FROM time_off_requests
      WHERE employee_id = ? AND status = 'approved'`).bind(ownerId).all(),
    avoidShifts ? shiftIntervals(env, ownerId, fromIso, toIso_) : []
  ]);
  return [
    ...bookings.results.map((r) => ({ start: Date.parse(r.blocks_start_utc), end: Date.parse(r.blocks_end_utc) })),
    ...events.results.map((r) => ({ start: Date.parse(r.start_utc), end: Date.parse(r.end_utc) })),
    ...timeOffToIntervals(timeOff.results, timezone),
    ...shifts
  ];
}

async function computeSlots(env, link, now, ignoreBookingId = '') {
  const { timezone, avoidShifts } = await ownerSettings(env, link.owner_id);
  const nowTime = nowMs(now);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(nowTime));
  const fromDate = today;
  const toDate = addDaysToDate(today, link.max_days_ahead + 1);
  const [rules, overrides] = await Promise.all([
    env.TEAM_DB.prepare('SELECT weekday, start_time, end_time FROM booking_availability WHERE owner_id = ?').bind(link.owner_id).all(),
    env.TEAM_DB.prepare(`SELECT override_date, start_time, end_time FROM booking_date_overrides
      WHERE owner_id = ? AND override_date >= ? AND override_date <= ?`).bind(link.owner_id, fromDate, toDate).all()
  ]);
  const windows = expandAvailability({ rules: rules.results, overrides: overrides.results, fromDate, toDate, timezone });
  const rangeStart = wallToUtc(fromDate, 0, timezone) ?? nowTime;
  const rangeEnd = wallToUtc(toDate, 1440, timezone) ?? nowTime + (link.max_days_ahead + 2) * 86_400_000;
  const busy = await loadBusy(env, link.owner_id, toIso(rangeStart), toIso(rangeEnd), timezone, avoidShifts, ignoreBookingId);
  return {
    timezone,
    slots: generateSlots({
      windows, busy, durationMinutes: link.duration_minutes, bufferBeforeMinutes: link.buffer_before_minutes,
      bufferAfterMinutes: link.buffer_after_minutes, intervalMinutes: link.slot_interval_minutes, now: nowTime,
      minNoticeMinutes: link.min_notice_minutes, maxDaysAhead: link.max_days_ahead
    })
  };
}

// Public: GET slots for a link. Returns ISO start times.
export async function getAvailableSlots(env, token, now = Date.now()) {
  const link = await resolveLink(env, token, now);
  const { timezone, slots } = await computeSlots(env, link, now);
  return { ok: true, event: linkView(link), ownerTimezone: timezone, slots: slots.map(toIso) };
}

function cleanText(value, max, field, required) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !text) throw new ApiError(`${field}_required`, 400);
  if (text.length > max) throw new ApiError(`${field}_too_long`, 400);
  return text;
}

function cleanAnswers(link, answers) {
  const questions = safeJsonParse(link.questions_json, []);
  const input = answers && typeof answers === 'object' ? answers : {};
  const clean = {};
  for (const question of questions) {
    const value = cleanText(input[question.id], MAX_ANSWER, 'answer', false);
    if (question.required && !value) throw new ApiError('answer_required', 400);
    if (value) clean[question.id] = value;
  }
  return clean;
}

function insertBookingStatement(db, p) {
  // One statement: insert only if the owner has no other overlapping confirmed
  // booking AND this invitee has no other active (confirmed, not yet ended)
  // booking on this link. `excludeId` is the booking being rescheduled.
  return db.prepare(`INSERT INTO bookings
      (id, event_type_id, owner_id, link_id, location_id, location_snapshot_json, title, start_utc, end_utc,
       blocks_start_utc, blocks_end_utc, status, client_name, client_email, client_phone, client_timezone,
       answers_json, manage_token_hash, created_at, rescheduled_from)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE owner_id = ? AND status = 'confirmed' AND id != ?
        AND blocks_start_utc < ? AND blocks_end_utc > ?)
      AND NOT EXISTS (SELECT 1 FROM bookings WHERE link_id = ? AND client_email = ? AND status = 'confirmed' AND id != ?
        AND end_utc > ?)`)
    .bind(p.bookingId, p.link.event_type_id, p.link.owner_id, p.link.link_id, p.link.location_id,
      JSON.stringify(locationSnapshot(p.link)), p.link.name, toIso(p.block.start), toIso(p.block.end),
      toIso(p.block.blocksStart), toIso(p.block.blocksEnd), p.name, p.email, p.phone || null, p.clientTimezone || null,
      JSON.stringify(p.answers), p.manageHash, p.createdAt, p.excludeId || null,
      p.link.owner_id, p.excludeId, toIso(p.block.blocksEnd), toIso(p.block.blocksStart),
      p.link.link_id, p.email, p.excludeId, p.nowIsoValue);
}

function blockFor(link, startMs) {
  return bookingBlock(startMs, {
    durationMinutes: link.duration_minutes,
    bufferBeforeMinutes: link.buffer_before_minutes,
    bufferAfterMinutes: link.buffer_after_minutes
  });
}

// Public: book a slot. The slot is recomputed server-side, then inserted with
// one conditional statement so a stale page, a double click or two clients
// racing can never create an overlapping or duplicate booking.
export async function createBooking(env, token, input, now = Date.now()) {
  const link = await resolveLink(env, token, now);
  const name = cleanText(input.name, MAX_NAME, 'name', true);
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new ApiError('invalid_email', 400);
  const phone = cleanText(input.phone, 40, 'phone', false);
  const clientTimezone = isValidTimezone(input.timezone) ? input.timezone : '';
  const answers = cleanAnswers(link, input.answers);

  const startMs = Date.parse(String(input.start || ''));
  if (!Number.isFinite(startMs)) throw new ApiError('invalid_start', 400);
  const { slots } = await computeSlots(env, link, now);
  if (!slots.includes(startMs)) throw new ApiError('slot_unavailable', 409);

  const block = blockFor(link, startMs);
  const bookingId = newId('booking');
  const manageToken = randomToken();
  const nowIsoValue = toIso(nowMs(now));
  const db = env.TEAM_DB;

  // The link use is claimed first so an exhausted link cannot be oversubscribed.
  const claim = await db.prepare(`UPDATE booking_links SET use_count = use_count + 1
    WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR use_count < max_uses)`).bind(link.link_id).run();
  if (!claim.meta.changes) throw new ApiError('link_not_found', 404);

  let inserted;
  try {
    inserted = await insertBookingStatement(db, {
      bookingId, link, block, name, email, phone, clientTimezone, answers, manageHash: await sha256Hex(manageToken),
      createdAt: nowIso(), nowIsoValue, excludeId: ''
    }).run();
  } catch (error) {
    await releaseClaim(db, link.link_id);
    // The unique index fired: someone took exactly this start between check and write.
    if (/UNIQUE/i.test(String(error?.message))) throw new ApiError('slot_unavailable', 409);
    throw error;
  }

  if (!inserted.meta.changes) {
    await releaseClaim(db, link.link_id);
    const duplicate = await db.prepare(`SELECT 1 AS found FROM bookings WHERE link_id = ? AND client_email = ?
      AND status = 'confirmed' AND end_utc > ?`).bind(link.link_id, email, nowIsoValue).first();
    throw new ApiError(duplicate ? 'already_booked' : 'slot_unavailable', 409);
  }

  await audit(db, null, 'booking.create', 'booking', bookingId, { ownerId: link.owner_id, linkId: link.link_id });
  const emailQueued = await announceBooking(env, { bookingId, link, block, manageToken, template: 'confirmed' });
  return {
    ok: true,
    booking: { id: bookingId, startUtc: toIso(block.start), endUtc: toIso(block.end), title: link.name, location: locationSnapshot(link) },
    manageToken,
    emailQueued,
    owner: { id: link.owner_id, name: link.owner_name }
  };
}

// ---- emails and owner notifications (never allowed to fail a booking) ----

async function queueBookingEmail(env, bookingId, template, extra = {}) {
  if (!env.NOTIFICATIONS?.send) return false;
  try {
    await env.NOTIFICATIONS.send({ kind: 'booking_email', bookingId, template, ...extra, deliveryKey: `booking:${bookingId}:${template}` });
    return true;
  } catch (error) {
    console.error('booking email enqueue failed', String(error));
    return false;
  }
}

function describeInstant(ms, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(new Date(ms));
}

// The owner's portal notification deliberately omits the invitee's name and
// contact details: notification rows are kept long-term, but invitee data is
// anonymised after 12 months. The details live in the booking itself.
async function notifyOwner(env, { bookingId, ownerId, eventName, startMs, kind }) {
  try {
    const { timezone } = await ownerSettings(env, ownerId);
    const when = describeInstant(startMs, timezone);
    const text = {
      new: ['New booking', `${eventName} booked for ${when}. Open the team calendar to review.`],
      cancelled: ['Booking cancelled', `A ${eventName} booking for ${when} was cancelled by the invitee.`],
      rescheduled: ['Booking rescheduled', `A ${eventName} booking was moved to ${when}.`]
    }[kind];
    await notifyUser(env, ownerId, `booking_${kind}`, text[0], text[1], '/team/calendar', `booking:${bookingId}:${kind}`);
  } catch (error) {
    console.error('booking owner notification failed', String(error));
  }
}

async function announceBooking(env, { bookingId, link, block, manageToken, template, kind = 'new' }) {
  const queued = await queueBookingEmail(env, bookingId, template, { manageToken });
  await notifyOwner(env, { bookingId, ownerId: link.owner_id, eventName: link.name, startMs: block.start, kind });
  return queued;
}

// ---- invitee self-service (manage token from the confirmation email) ----

async function loadManaged(env, manageToken) {
  if (typeof manageToken !== 'string' || manageToken.length < 20 || manageToken.length > 100) throw new ApiError('booking_not_found', 404);
  const row = await env.TEAM_DB.prepare('SELECT * FROM bookings WHERE manage_token_hash = ?').bind(await sha256Hex(manageToken)).first();
  if (!row) throw new ApiError('booking_not_found', 404);
  return row;
}

function managedView(row, now) {
  const upcoming = Date.parse(row.start_utc) > nowMs(now);
  return {
    title: row.title,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    status: row.status,
    location: safeJsonParse(row.location_snapshot_json, null),
    clientName: row.client_name,
    canChange: row.status === 'confirmed' && upcoming
  };
}

export async function getManagedBooking(env, manageToken, now = Date.now()) {
  const row = await loadManaged(env, manageToken);
  const owner = await env.TEAM_DB.prepare('SELECT name FROM users WHERE id = ?').bind(row.owner_id).first();
  const { timezone } = await ownerSettings(env, row.owner_id);
  return { ok: true, booking: { ...managedView(row, now), ownerFirstName: String(owner?.name || '').split(' ')[0], ownerTimezone: timezone } };
}

export async function getManagedSlots(env, manageToken, now = Date.now()) {
  const row = await loadManaged(env, manageToken);
  if (row.status !== 'confirmed' || Date.parse(row.start_utc) <= nowMs(now)) throw new ApiError('booking_not_changeable', 409);
  const link = await linkForBooking(env, row);
  const { timezone, slots } = await computeSlots(env, link, now, row.id);
  return { ok: true, ownerTimezone: timezone, slots: slots.map(toIso) };
}

export async function cancelManagedBooking(env, manageToken, reason, now = Date.now()) {
  const row = await loadManaged(env, manageToken);
  if (row.status !== 'confirmed' || Date.parse(row.start_utc) <= nowMs(now)) throw new ApiError('booking_not_changeable', 409);
  const result = await env.TEAM_DB.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'invitee', cancel_reason = ?
    WHERE id = ? AND status = 'confirmed'`).bind(toIso(nowMs(now)), cleanText(reason, 300, 'reason', false) || null, row.id).run();
  if (!result.meta.changes) throw new ApiError('booking_not_changeable', 409);
  await audit(env.TEAM_DB, null, 'booking.cancel_by_invitee', 'booking', row.id, {});
  await queueBookingEmail(env, row.id, 'cancelled_by_invitee');
  await notifyOwner(env, { bookingId: row.id, ownerId: row.owner_id, eventName: row.title, startMs: Date.parse(row.start_utc), kind: 'cancelled' });
  return { ok: true };
}

// Moves a booking: the new booking is inserted and the old one cancelled in a
// single transaction, and the old one is only cancelled if the new one exists.
export async function rescheduleManagedBooking(env, manageToken, start, now = Date.now()) {
  const old = await loadManaged(env, manageToken);
  if (old.status !== 'confirmed' || Date.parse(old.start_utc) <= nowMs(now)) throw new ApiError('booking_not_changeable', 409);
  const link = await linkForBooking(env, old);
  const startMs = Date.parse(String(start || ''));
  if (!Number.isFinite(startMs)) throw new ApiError('invalid_start', 400);
  const { slots } = await computeSlots(env, link, now, old.id);
  if (!slots.includes(startMs)) throw new ApiError('slot_unavailable', 409);

  const block = blockFor(link, startMs);
  const bookingId = newId('booking');
  const newManageToken = randomToken();
  const db = env.TEAM_DB;
  let results;
  try {
    results = await db.batch([
      insertBookingStatement(db, {
        bookingId, link, block, name: old.client_name, email: old.client_email, phone: old.client_phone,
        clientTimezone: old.client_timezone, answers: safeJsonParse(old.answers_json, {}),
        manageHash: await sha256Hex(newManageToken), createdAt: nowIso(), nowIsoValue: toIso(nowMs(now)), excludeId: old.id
      }),
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'invitee', cancel_reason = 'rescheduled'
        WHERE id = ? AND status = 'confirmed' AND EXISTS (SELECT 1 FROM bookings WHERE id = ? AND status = 'confirmed')`)
        .bind(toIso(nowMs(now)), old.id, bookingId)
    ]);
  } catch (error) {
    if (/UNIQUE/i.test(String(error?.message))) throw new ApiError('slot_unavailable', 409);
    throw error;
  }
  if (!results[0].meta.changes || !results[1].meta.changes) throw new ApiError('slot_unavailable', 409);
  await audit(db, null, 'booking.reschedule', 'booking', bookingId, { from: old.id });
  const emailQueued = await announceBooking(env, { bookingId, link, block, manageToken: newManageToken, template: 'rescheduled', kind: 'rescheduled' });
  return {
    ok: true,
    booking: { id: bookingId, startUtc: toIso(block.start), endUtc: toIso(block.end), title: link.name, location: locationSnapshot(link) },
    manageToken: newManageToken,
    emailQueued
  };
}

async function releaseClaim(db, linkId) {
  await db.prepare('UPDATE booking_links SET use_count = MAX(use_count - 1, 0) WHERE id = ?').bind(linkId).run();
}

// Authenticated: team calendar for a range. Team events are shown to every
// signed-in employee; client bookings go through redactBooking, so anyone who
// is not the owner or Management only learns that a time is booked. Cancelled
// bookings are never part of the shared calendar.
export async function getCalendar(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'barista');
  const from = normalizeDate(payload.from, 'from');
  const to = normalizeDate(payload.to, 'to');
  if (to < from) throw new ApiError('invalid_range', 400);
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 100 * 86_400_000) throw new ApiError('range_too_large', 400);
  // Ranges are whole days in the store's timezone, the zone the team works in.
  const timezone = storeTimezone(env);
  const startIso = toIso(wallToUtc(from, 0, timezone) ?? Date.parse(`${from}T00:00:00Z`));
  const endIso = toIso(wallToUtc(to, 1440, timezone) ?? Date.parse(`${addDaysToDate(to, 1)}T00:00:00Z`));
  const [events, bookings] = await Promise.all([
    env.TEAM_DB.prepare(`SELECT te.*, u.name AS creator_name FROM team_events te JOIN users u ON u.id = te.created_by
      WHERE te.end_utc > ? AND te.start_utc < ? ORDER BY te.start_utc LIMIT 500`).bind(startIso, endIso).all(),
    env.TEAM_DB.prepare(`SELECT * FROM bookings WHERE status = 'confirmed' AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc LIMIT 500`).bind(startIso, endIso).all()
  ]);
  return {
    ok: true,
    timezone,
    events: events.results.map((row) => ({
      id: row.id, title: row.title, description: row.description, startUtc: row.start_utc, endUtc: row.end_utc,
      allDay: !!row.all_day, location: row.location, createdBy: row.created_by, creatorName: row.creator_name,
      blocksAvailability: !!row.blocks_availability && row.created_by === actor.id,
      canEdit: actor.role === 'management' || (actor.role !== 'barista' && row.created_by === actor.id)
    })),
    bookings: bookings.results.map((row) => redactBooking(actor, row))
  };
}

export function storeTimezone(env) {
  const zone = env.STORE_TIMEZONE || 'America/New_York';
  return isValidTimezone(zone) ? zone : 'America/New_York';
}

// Authenticated: one booking in full. Anyone who is not the owner or
// Management gets the same 403 whether or not the id exists.
export async function getBooking(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'barista');
  const row = await env.TEAM_DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(String(payload.bookingId || '')).first();
  if (!row || !canViewBooking(actor, row)) throw new ApiError('forbidden', 403);
  return { ok: true, booking: redactBooking(actor, row) };
}

// Authenticated: bookings the actor owns (or, for Management with all:true, everyone's).
export async function getMyBookings(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const limit = clampInt(payload.limit, 1, 500, 200);
  const all = actor.role === 'management' && payload.all === true;
  const statement = all
    ? env.TEAM_DB.prepare('SELECT * FROM bookings ORDER BY start_utc DESC LIMIT ?').bind(limit)
    : env.TEAM_DB.prepare('SELECT * FROM bookings WHERE owner_id = ? ORDER BY start_utc DESC LIMIT ?').bind(actor.id, limit);
  const { results } = await statement.all();
  return { ok: true, bookings: results.map((row) => redactBooking(actor, row)) };
}

// Authenticated: cancel. Owner or Management only; frees the slot immediately.
export async function cancelBooking(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const row = await env.TEAM_DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(String(payload.bookingId || '')).first();
  if (!row || !canViewBooking(actor, row)) throw new ApiError('forbidden', 403);
  const result = await env.TEAM_DB.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?
    WHERE id = ? AND status = 'confirmed'`)
    .bind(nowIso(), actor.id, cleanText(payload.reason, 300, 'reason', false), row.id).run();
  if (!result.meta.changes) throw new ApiError('booking_not_cancellable', 409);
  await audit(env.TEAM_DB, actor.id, 'booking.cancel', 'booking', row.id, {});
  if (row.client_email) await queueBookingEmail(env, row.id, 'cancelled_by_host');
  return { ok: true };
}

// Retention: 12 months after a meeting ends, blank the invitee's personal data.
export async function anonymizeExpiredBookings(env, now = Date.now()) {
  const result = await anonymizeExpiredBookingsStatement(env.TEAM_DB, nowMs(now)).run();
  return { ok: true, anonymized: result.meta.changes };
}

// Management only: erase one person's details on request (the privacy policy
// promises this). Covers every booking row with the same email, including old
// cancelled and rescheduled copies, and cancels any that are still upcoming so
// no ghost meeting is left behind. The meeting times themselves are kept.
export async function eraseBookingData(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const db = env.TEAM_DB;
  const row = await db.prepare('SELECT id, client_email FROM bookings WHERE id = ?').bind(String(payload.bookingId || '')).first();
  if (!row) throw new ApiError('booking_not_found', 404);
  const now = nowIso();
  const where = row.client_email ? 'client_email = ?' : 'id = ?';
  const key = row.client_email || row.id;
  const results = await db.batch([
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = 'erased on request'
      WHERE ${where} AND status = 'confirmed' AND start_utc > ?`).bind(now, actor.id, key, now),
    db.prepare(`UPDATE bookings SET client_name = NULL, client_email = NULL, client_phone = NULL, client_timezone = NULL,
      answers_json = '{}', cancel_reason = CASE WHEN cancel_reason = 'erased on request' THEN cancel_reason ELSE NULL END,
      anonymized_at = COALESCE(anonymized_at, ?) WHERE ${where}`).bind(now, key)
  ]);
  await audit(db, actor.id, 'booking.erase', 'booking', row.id, { rows: results[1].meta.changes });
  return { ok: true, erased: results[1].meta.changes };
}

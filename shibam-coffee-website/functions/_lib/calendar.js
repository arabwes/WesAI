// Portal calendar: database layer (phase 1). Public handlers take a raw booking
// token; authenticated handlers use the portal session like every other action.
// None of these are routed yet; routing and UI arrive in later phases.
import { audit, requireRole } from './auth.js';
import {
  ApiError, clampInt, newId, normalizeDate, nowIso, safeJsonParse, sha256Hex
} from './http.js';
import {
  addDaysToDate, bookingBlock, expandAvailability, generateSlots, isValidTimezone, normalizeEmail,
  redactBooking, canViewBooking, timeOffToIntervals, toIso, wallToUtc
} from './calendar-rules.js';

const RETENTION_MONTHS = 12;
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

// Creates a link and returns the raw token once. Used by owner setup (phase 2)
// and by tests.
export async function createLinkRecord(db, { eventTypeId, label = '', expiresAt = null, maxUses = null }) {
  const token = randomToken();
  const id = newId('blink');
  await db.prepare(`INSERT INTO booking_links (id, event_type_id, token_hash, label, expires_at, max_uses, use_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)`)
    .bind(id, eventTypeId, await sha256Hex(token), String(label).slice(0, 120), expiresAt, maxUses, nowIso()).run();
  return { id, token };
}

// Unknown, revoked, expired and exhausted links all return the same error so
// a token cannot be probed for its state. Inactive event types and archived
// locations are also "not found" to the public.
export async function resolveLink(env, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new ApiError('link_not_found', 404);
  const row = await env.TEAM_DB.prepare(`SELECT l.id AS link_id, l.expires_at, l.max_uses, l.use_count, l.revoked_at,
      e.id AS event_type_id, e.owner_id, e.name, e.description, e.duration_minutes, e.buffer_before_minutes,
      e.buffer_after_minutes, e.min_notice_minutes, e.max_days_ahead, e.slot_interval_minutes, e.questions_json,
      e.active AS event_active, m.id AS location_id, m.name AS location_name, m.address_line1, m.address_line2,
      m.city, m.state, m.postal_code, m.notes AS location_notes, m.active AS location_active, u.name AS owner_name, u.active AS owner_active
    FROM booking_links l
    JOIN event_types e ON e.id = l.event_type_id
    JOIN meeting_locations m ON m.id = e.location_id
    JOIN users u ON u.id = e.owner_id
    WHERE l.token_hash = ?`).bind(await sha256Hex(token)).first();
  const expired = row?.expires_at && Date.parse(row.expires_at) <= nowMs(now);
  const exhausted = row && row.max_uses !== null && row.use_count >= row.max_uses;
  if (!row || row.revoked_at || expired || exhausted || !row.event_active || !row.location_active || !row.owner_active) {
    throw new ApiError('link_not_found', 404);
  }
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

async function ownerTimezone(env, ownerId) {
  const row = await env.TEAM_DB.prepare('SELECT timezone FROM booking_settings WHERE owner_id = ?').bind(ownerId).first();
  const zone = row?.timezone || env.STORE_TIMEZONE || 'America/New_York';
  return isValidTimezone(zone) ? zone : 'America/New_York';
}

// Everything that makes an owner busy between two instants.
async function loadBusy(env, ownerId, fromIso, toIso_, timezone) {
  const db = env.TEAM_DB;
  const [bookings, events, timeOff] = await Promise.all([
    db.prepare(`SELECT blocks_start_utc, blocks_end_utc FROM bookings
      WHERE owner_id = ? AND status = 'confirmed' AND blocks_end_utc > ? AND blocks_start_utc < ?`)
      .bind(ownerId, fromIso, toIso_).all(),
    db.prepare(`SELECT start_utc, end_utc FROM team_events
      WHERE created_by = ? AND blocks_availability = 1 AND end_utc > ? AND start_utc < ?`)
      .bind(ownerId, fromIso, toIso_).all(),
    db.prepare(`SELECT start_date, end_date, start_time, end_time FROM time_off_requests
      WHERE employee_id = ? AND status = 'approved'`).bind(ownerId).all()
  ]);
  return [
    ...bookings.results.map((r) => ({ start: Date.parse(r.blocks_start_utc), end: Date.parse(r.blocks_end_utc) })),
    ...events.results.map((r) => ({ start: Date.parse(r.start_utc), end: Date.parse(r.end_utc) })),
    ...timeOffToIntervals(timeOff.results, timezone)
  ];
}

async function computeSlots(env, link, now) {
  const timezone = await ownerTimezone(env, link.owner_id);
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
  const busy = await loadBusy(env, link.owner_id, toIso(rangeStart), toIso(rangeEnd), timezone);
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

  const block = bookingBlock(startMs, {
    durationMinutes: link.duration_minutes,
    bufferBeforeMinutes: link.buffer_before_minutes,
    bufferAfterMinutes: link.buffer_after_minutes
  });
  const bookingId = newId('booking');
  const manageToken = randomToken();
  const createdAt = nowIso();
  const nowIsoValue = toIso(nowMs(now));
  const db = env.TEAM_DB;

  // The link use is claimed first so an exhausted link cannot be oversubscribed.
  const claim = await db.prepare(`UPDATE booking_links SET use_count = use_count + 1
    WHERE id = ? AND revoked_at IS NULL AND (max_uses IS NULL OR use_count < max_uses)`).bind(link.link_id).run();
  if (!claim.meta.changes) throw new ApiError('link_not_found', 404);

  let inserted;
  try {
    // One statement: insert only if the owner has no overlapping confirmed
    // booking AND this invitee has no other active (confirmed, not yet ended)
    // booking on this link.
    inserted = await db.prepare(`INSERT INTO bookings
        (id, event_type_id, owner_id, link_id, location_id, location_snapshot_json, title, start_utc, end_utc,
         blocks_start_utc, blocks_end_utc, status, client_name, client_email, client_phone, client_timezone,
         answers_json, manage_token_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE owner_id = ? AND status = 'confirmed'
          AND blocks_start_utc < ? AND blocks_end_utc > ?)
        AND NOT EXISTS (SELECT 1 FROM bookings WHERE link_id = ? AND client_email = ? AND status = 'confirmed'
          AND end_utc > ?)`)
      .bind(bookingId, link.event_type_id, link.owner_id, link.link_id, link.location_id,
        JSON.stringify(locationSnapshot(link)), link.name, toIso(block.start), toIso(block.end),
        toIso(block.blocksStart), toIso(block.blocksEnd), name, email, phone || null, clientTimezone || null,
        JSON.stringify(answers), await sha256Hex(manageToken), createdAt,
        link.owner_id, toIso(block.blocksEnd), toIso(block.blocksStart),
        link.link_id, email, nowIsoValue).run();
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
  return {
    ok: true,
    booking: { id: bookingId, startUtc: toIso(block.start), endUtc: toIso(block.end), title: link.name, location: locationSnapshot(link) },
    manageToken,
    owner: { id: link.owner_id, name: link.owner_name }
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
  const startIso = toIso(Date.parse(`${addDaysToDate(from, -1)}T00:00:00Z`));
  const endIso = toIso(Date.parse(`${addDaysToDate(to, 2)}T00:00:00Z`));
  const [events, bookings] = await Promise.all([
    env.TEAM_DB.prepare(`SELECT te.*, u.name AS creator_name FROM team_events te JOIN users u ON u.id = te.created_by
      WHERE te.end_utc > ? AND te.start_utc < ? ORDER BY te.start_utc LIMIT 500`).bind(startIso, endIso).all(),
    env.TEAM_DB.prepare(`SELECT * FROM bookings WHERE status = 'confirmed' AND end_utc > ? AND start_utc < ?
      ORDER BY start_utc LIMIT 500`).bind(startIso, endIso).all()
  ]);
  return {
    ok: true,
    events: events.results.map((row) => ({
      id: row.id, title: row.title, description: row.description, startUtc: row.start_utc, endUtc: row.end_utc,
      allDay: !!row.all_day, location: row.location, createdBy: row.created_by, creatorName: row.creator_name
    })),
    bookings: bookings.results.map((row) => redactBooking(actor, row))
  };
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
  return { ok: true };
}

// Retention: 12 months after a meeting ends, blank the invitee's personal data.
// The meeting row and its time stay, so history and counts survive.
export async function anonymizeExpiredBookings(env, now = Date.now()) {
  const cutoff = new Date(nowMs(now));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  const result = await env.TEAM_DB.prepare(`UPDATE bookings SET client_name = NULL, client_email = NULL, client_phone = NULL,
      client_timezone = NULL, answers_json = '{}', cancel_reason = NULL, anonymized_at = ?
    WHERE anonymized_at IS NULL AND end_utc < ?`).bind(toIso(nowMs(now)), cutoff.toISOString()).run();
  return { ok: true, anonymized: result.meta.changes };
}

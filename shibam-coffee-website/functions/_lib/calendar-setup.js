// Calendar phase 2: owner setup. Everything here is Lead+ and scoped to the
// caller; Management can additionally see and manage other people's event
// types and links. Meeting addresses are a shared list any Lead can extend.
import { audit, requireRole } from './auth.js';
import {
  ApiError, availabilityWindow, newId, normalizeDate, nowIso, safeJsonParse
} from './http.js';
import { createLinkRecord } from './calendar.js';
import { isValidTimezone } from './calendar-rules.js';

const MAX_WINDOWS_PER_DAY = 5;

function text(value, max, field, required = true) {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !clean) throw new ApiError(`${field}_required`, 400);
  if (clean.length > max) throw new ApiError(`${field}_too_long`, 400);
  return clean;
}

function flag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function canManage(actor, ownerId) {
  return actor.role === 'management' || actor.id === ownerId;
}

// ---- meeting addresses ----

function locationRow(row) {
  return {
    id: row.id, name: row.name, addressLine1: row.address_line1, addressLine2: row.address_line2, city: row.city,
    state: row.state, postalCode: row.postal_code, notes: row.notes, active: !!row.active
  };
}

export async function listMeetingLocations(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const where = flag(payload.includeArchived) ? '' : 'WHERE active = 1';
  const { results } = await env.TEAM_DB.prepare(`SELECT * FROM meeting_locations ${where} ORDER BY active DESC, name COLLATE NOCASE`).all();
  return { ok: true, locations: results.map(locationRow) };
}

export async function saveMeetingLocation(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const fields = {
    name: text(payload.name, 80, 'name'),
    line1: text(payload.addressLine1, 120, 'address'),
    line2: text(payload.addressLine2, 120, 'address_line2', false),
    city: text(payload.city, 80, 'city'),
    state: text(payload.state, 2, 'state').toUpperCase(),
    postal: text(payload.postalCode, 10, 'postal_code'),
    notes: text(payload.notes, 300, 'notes', false)
  };
  if (!/^[A-Z]{2}$/.test(fields.state)) throw new ApiError('invalid_state', 400);
  if (!/^\d{5}(-\d{4})?$/.test(fields.postal)) throw new ApiError('invalid_postal_code', 400);
  const now = nowIso();
  if (payload.id) {
    const result = await env.TEAM_DB.prepare(`UPDATE meeting_locations SET name = ?, address_line1 = ?, address_line2 = ?, city = ?,
        state = ?, postal_code = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .bind(fields.name, fields.line1, fields.line2, fields.city, fields.state, fields.postal, fields.notes, now, String(payload.id)).run();
    if (!result.meta.changes) throw new ApiError('location_not_found', 404);
    await audit(env.TEAM_DB, actor.id, 'meeting_location.update', 'meeting_location', payload.id, {});
    return { ok: true, id: payload.id };
  }
  const id = newId('mloc');
  await env.TEAM_DB.prepare(`INSERT INTO meeting_locations (id, name, address_line1, address_line2, city, state, postal_code, notes,
      active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .bind(id, fields.name, fields.line1, fields.line2, fields.city, fields.state, fields.postal, fields.notes, actor.id, now, now).run();
  await audit(env.TEAM_DB, actor.id, 'meeting_location.create', 'meeting_location', id, {});
  return { ok: true, id };
}

// Archiving takes links that use the address offline, so it is refused while
// an active event type still uses it.
export async function archiveMeetingLocation(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const id = String(payload.id || '');
  const archived = payload.archived !== false;
  if (archived) {
    const inUse = await env.TEAM_DB.prepare('SELECT COUNT(*) AS n FROM event_types WHERE location_id = ? AND active = 1').bind(id).first();
    if (inUse.n) throw new ApiError('location_in_use', 409, { eventTypes: inUse.n });
  }
  const result = await env.TEAM_DB.prepare('UPDATE meeting_locations SET active = ?, updated_at = ? WHERE id = ?')
    .bind(archived ? 0 : 1, nowIso(), id).run();
  if (!result.meta.changes) throw new ApiError('location_not_found', 404);
  await audit(env.TEAM_DB, actor.id, archived ? 'meeting_location.archive' : 'meeting_location.restore', 'meeting_location', id, {});
  return { ok: true };
}

// ---- event types ----

function slugify(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'meeting';
}

function cleanQuestions(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length > 5) throw new ApiError('too_many_questions', 400);
  const seen = new Set();
  return list.map((question) => {
    // Ids are derived from the label when not supplied, so any label yields a valid id.
    const derived = slugify(question?.label || '').replace(/-/g, '_');
    const id = text(question?.id || (/^[a-z]/.test(derived) ? derived : `q_${derived}`).slice(0, 30), 30, 'question_id');
    if (!/^[a-z][a-z0-9_]*$/.test(id) || seen.has(id)) throw new ApiError('invalid_question_id', 400);
    seen.add(id);
    return { id, label: text(question.label, 120, 'question_label'), required: flag(question.required) };
  });
}

function eventTypeRow(row) {
  return {
    id: row.id, ownerId: row.owner_id, ownerName: row.owner_name, name: row.name, slug: row.slug, description: row.description,
    durationMinutes: row.duration_minutes, bufferBeforeMinutes: row.buffer_before_minutes, bufferAfterMinutes: row.buffer_after_minutes,
    locationId: row.location_id, locationName: row.location_name, locationActive: !!row.location_active,
    minNoticeMinutes: row.min_notice_minutes, maxDaysAhead: row.max_days_ahead, slotIntervalMinutes: row.slot_interval_minutes,
    questions: safeJsonParse(row.questions_json, []), active: !!row.active, activeLinks: row.active_links ?? 0
  };
}

export async function listEventTypes(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const all = actor.role === 'management' && flag(payload.all);
  const { results } = await env.TEAM_DB.prepare(`SELECT e.*, u.name AS owner_name, m.name AS location_name, m.active AS location_active,
      (SELECT COUNT(*) FROM booking_links l WHERE l.event_type_id = e.id AND l.revoked_at IS NULL) AS active_links
    FROM event_types e JOIN users u ON u.id = e.owner_id JOIN meeting_locations m ON m.id = e.location_id
    ${all ? '' : 'WHERE e.owner_id = ?'} ORDER BY e.active DESC, e.name COLLATE NOCASE`)
    .bind(...(all ? [] : [actor.id])).all();
  return { ok: true, eventTypes: results.map(eventTypeRow) };
}

async function ownedEventType(db, actor, id) {
  const row = await db.prepare('SELECT * FROM event_types WHERE id = ?').bind(String(id || '')).first();
  if (!row || !canManage(actor, row.owner_id)) throw new ApiError('event_type_not_found', 404);
  return row;
}

export async function saveEventType(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const db = env.TEAM_DB;
  const range = (value, min, max, field) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new ApiError(`invalid_${field}`, 400);
    return number;
  };
  const fields = {
    name: text(payload.name, 80, 'name'),
    description: text(payload.description, 500, 'description', false),
    duration: range(payload.durationMinutes, 5, 480, 'duration'),
    before: range(payload.bufferBeforeMinutes ?? 0, 0, 240, 'buffer'),
    after: range(payload.bufferAfterMinutes ?? 0, 0, 240, 'buffer'),
    notice: range(payload.minNoticeMinutes ?? 240, 0, 60 * 24 * 60, 'min_notice'),
    ahead: range(payload.maxDaysAhead ?? 60, 1, 365, 'max_days_ahead'),
    interval: range(payload.slotIntervalMinutes ?? 30, 5, 60, 'slot_interval'),
    questions: cleanQuestions(payload.questions)
  };
  if (![5, 10, 15, 20, 30, 60].includes(fields.interval)) throw new ApiError('invalid_slot_interval', 400);
  const location = await db.prepare('SELECT id FROM meeting_locations WHERE id = ? AND active = 1').bind(String(payload.locationId || '')).first();
  if (!location) throw new ApiError('location_required', 400);
  const now = nowIso();

  if (payload.id) {
    const existing = await ownedEventType(db, actor, payload.id);
    await db.prepare(`UPDATE event_types SET name = ?, description = ?, duration_minutes = ?, buffer_before_minutes = ?,
        buffer_after_minutes = ?, location_id = ?, min_notice_minutes = ?, max_days_ahead = ?, slot_interval_minutes = ?,
        questions_json = ?, updated_at = ? WHERE id = ?`)
      .bind(fields.name, fields.description, fields.duration, fields.before, fields.after, location.id, fields.notice, fields.ahead,
        fields.interval, JSON.stringify(fields.questions), now, existing.id).run();
    await audit(db, actor.id, 'event_type.update', 'event_type', existing.id, {});
    return { ok: true, id: existing.id, slug: existing.slug };
  }

  const base = slugify(payload.slug || fields.name);
  let slug = base;
  for (let attempt = 2; await db.prepare('SELECT 1 AS taken FROM event_types WHERE owner_id = ? AND slug = ?').bind(actor.id, slug).first(); attempt += 1) {
    slug = `${base}-${attempt}`;
  }
  const id = newId('etype');
  await db.prepare(`INSERT INTO event_types (id, owner_id, name, slug, description, duration_minutes, buffer_before_minutes,
      buffer_after_minutes, location_id, min_notice_minutes, max_days_ahead, slot_interval_minutes, questions_json, active,
      created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .bind(id, actor.id, fields.name, slug, fields.description, fields.duration, fields.before, fields.after, location.id,
      fields.notice, fields.ahead, fields.interval, JSON.stringify(fields.questions), now, now).run();
  await audit(db, actor.id, 'event_type.create', 'event_type', id, {});
  return { ok: true, id, slug };
}

// Archiving takes every link for the event type offline; bookings are kept.
export async function archiveEventType(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const existing = await ownedEventType(env.TEAM_DB, actor, payload.id);
  const archived = payload.archived !== false;
  await env.TEAM_DB.prepare('UPDATE event_types SET active = ?, updated_at = ? WHERE id = ?').bind(archived ? 0 : 1, nowIso(), existing.id).run();
  await audit(env.TEAM_DB, actor.id, archived ? 'event_type.archive' : 'event_type.restore', 'event_type', existing.id, {});
  return { ok: true };
}

// ---- the caller's own booking hours ----

function cleanWindow(window) {
  let parsed;
  try {
    parsed = availabilityWindow(window?.startTime, window?.endTime);
  } catch (error) {
    throw new ApiError('invalid_hours', 400);
  }
  return parsed;
}

function cleanWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (list.length > MAX_WINDOWS_PER_DAY) throw new ApiError('too_many_windows', 400);
  const parsed = list.map(cleanWindow).sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < parsed.length; i += 1) {
    if (parsed[i].startMinutes < parsed[i - 1].endMinutes) throw new ApiError('overlapping_hours', 400);
  }
  return parsed;
}

export async function getBookingAvailability(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const db = env.TEAM_DB;
  const [settings, weekly, overrides] = await Promise.all([
    db.prepare('SELECT timezone, avoid_shifts FROM booking_settings WHERE owner_id = ?').bind(actor.id).first(),
    db.prepare('SELECT weekday, start_time, end_time FROM booking_availability WHERE owner_id = ? ORDER BY weekday, start_time').bind(actor.id).all(),
    db.prepare(`SELECT override_date, start_time, end_time FROM booking_date_overrides WHERE owner_id = ? AND override_date >= ?
      ORDER BY override_date, start_time`).bind(actor.id, nowIso().slice(0, 10)).all()
  ]);
  const byDate = new Map();
  for (const row of overrides.results) {
    if (!byDate.has(row.override_date)) byDate.set(row.override_date, { date: row.override_date, blocked: true, windows: [] });
    if (row.start_time) {
      const entry = byDate.get(row.override_date);
      entry.blocked = false;
      entry.windows.push({ startTime: row.start_time, endTime: row.end_time });
    }
  }
  return {
    ok: true,
    timezone: settings?.timezone || env.STORE_TIMEZONE || 'America/New_York',
    avoidShifts: !!settings?.avoid_shifts,
    weekly: weekly.results.map((row) => ({ weekday: row.weekday, startTime: row.start_time, endTime: row.end_time })),
    overrides: [...byDate.values()]
  };
}

// Replaces the weekly hours and settings in one transaction.
export async function saveBookingAvailability(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const db = env.TEAM_DB;
  const timezone = String(payload.timezone || '');
  if (!isValidTimezone(timezone)) throw new ApiError('invalid_timezone', 400);
  const byDay = Array.from({ length: 7 }, () => []);
  for (const entry of Array.isArray(payload.weekly) ? payload.weekly : []) {
    const weekday = Number(entry?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new ApiError('invalid_weekday', 400);
    byDay[weekday].push(entry);
  }
  const statements = [
    db.prepare(`INSERT INTO booking_settings (owner_id, timezone, avoid_shifts, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET timezone = excluded.timezone, avoid_shifts = excluded.avoid_shifts, updated_at = excluded.updated_at`)
      .bind(actor.id, timezone, flag(payload.avoidShifts) ? 1 : 0, nowIso()),
    db.prepare('DELETE FROM booking_availability WHERE owner_id = ?').bind(actor.id)
  ];
  byDay.forEach((entries, weekday) => {
    for (const window of cleanWindows(entries)) {
      statements.push(db.prepare('INSERT INTO booking_availability (id, owner_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
        .bind(newId('bav'), actor.id, weekday, window.startTime, window.endTime));
    }
  });
  await db.batch(statements);
  await audit(db, actor.id, 'booking_availability.save', 'user', actor.id, { timezone });
  return { ok: true };
}

// One date's hours: blocked (no windows) or replacement windows.
export async function saveDateOverride(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const db = env.TEAM_DB;
  const date = normalizeDate(payload.date, 'date');
  if (date < nowIso().slice(0, 10) || date > new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10)) throw new ApiError('invalid_date', 400);
  const blocked = flag(payload.blocked);
  const windows = blocked ? [] : cleanWindows(payload.windows);
  if (!blocked && !windows.length) throw new ApiError('hours_required', 400);
  const statements = [db.prepare('DELETE FROM booking_date_overrides WHERE owner_id = ? AND override_date = ?').bind(actor.id, date)];
  if (blocked) {
    statements.push(db.prepare('INSERT INTO booking_date_overrides (id, owner_id, override_date, start_time, end_time) VALUES (?, ?, ?, NULL, NULL)')
      .bind(newId('bov'), actor.id, date));
  } else {
    for (const window of windows) {
      statements.push(db.prepare('INSERT INTO booking_date_overrides (id, owner_id, override_date, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
        .bind(newId('bov'), actor.id, date, window.startTime, window.endTime));
    }
  }
  await db.batch(statements);
  return { ok: true };
}

export async function deleteDateOverride(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  await env.TEAM_DB.prepare('DELETE FROM booking_date_overrides WHERE owner_id = ? AND override_date = ?')
    .bind(actor.id, normalizeDate(payload.date, 'date')).run();
  return { ok: true };
}

// ---- links ----

function linkUrl(request, env, token) {
  const origin = env.PUBLIC_SITE_URL ? String(env.PUBLIC_SITE_URL).replace(/\/+$/, '') : new URL(request.url).origin;
  return `${origin}/book/${token}`;
}

function linkStatus(row, now) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && Date.parse(row.expires_at) <= now) return 'expired';
  if (row.max_uses !== null && row.use_count >= row.max_uses) return 'used_up';
  return 'active';
}

// The full URL is returned once. Only a hash is kept, so a lost link cannot be
// recovered; create another instead (links are cheap and reusable).
export async function createBookingLink(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const eventType = await ownedEventType(env.TEAM_DB, actor, payload.eventTypeId);
  if (!eventType.active) throw new ApiError('event_type_archived', 409);
  let expiresAt = null;
  if (payload.expiresOn) {
    const day = normalizeDate(payload.expiresOn, 'expires_on');
    expiresAt = new Date(`${day}T23:59:59.999Z`).toISOString();
    if (Date.parse(expiresAt) <= Date.now()) throw new ApiError('invalid_expiry', 400);
  }
  let maxUses = null;
  if (payload.maxUses !== undefined && payload.maxUses !== null && payload.maxUses !== '') {
    maxUses = Number(payload.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) throw new ApiError('invalid_max_uses', 400);
  }
  const { id, token } = await createLinkRecord(env.TEAM_DB, {
    eventTypeId: eventType.id, label: text(payload.label, 120, 'label', false), expiresAt, maxUses
  });
  await audit(env.TEAM_DB, actor.id, 'booking_link.create', 'booking_link', id, { eventTypeId: eventType.id });
  return { ok: true, id, url: linkUrl(request, env, token) };
}

export async function listBookingLinks(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const eventType = await ownedEventType(env.TEAM_DB, actor, payload.eventTypeId);
  const { results } = await env.TEAM_DB.prepare(`SELECT id, label, expires_at, max_uses, use_count, revoked_at, created_at
    FROM booking_links WHERE event_type_id = ? ORDER BY created_at DESC LIMIT 200`).bind(eventType.id).all();
  const now = Date.now();
  return {
    ok: true,
    links: results.map((row) => ({
      id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, maxUses: row.max_uses,
      useCount: row.use_count, status: linkStatus(row, now)
    }))
  };
}

export async function revokeBookingLink(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const row = await env.TEAM_DB.prepare(`SELECT l.id, e.owner_id FROM booking_links l JOIN event_types e ON e.id = l.event_type_id
    WHERE l.id = ?`).bind(String(payload.linkId || '')).first();
  if (!row || !canManage(actor, row.owner_id)) throw new ApiError('link_not_found', 404);
  await env.TEAM_DB.prepare('UPDATE booking_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').bind(nowIso(), row.id).run();
  await audit(env.TEAM_DB, actor.id, 'booking_link.revoke', 'booking_link', row.id, {});
  return { ok: true };
}

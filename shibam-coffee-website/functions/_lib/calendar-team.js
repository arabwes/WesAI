// Team calendar events: shared with every signed-in employee, created and
// edited by Lead+ (Management can edit any). Times are entered in the store's
// timezone and stored as UTC.
import { audit, requireRole } from './auth.js';
import { ApiError, newId, normalizeDate, normalizeTime, nowIso } from './http.js';
import { addDaysToDate, wallToUtc, toIso } from './calendar-rules.js';
import { storeTimezone } from './calendar.js';

function text(value, max, field, required = false) {
  const clean = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (required && !clean) throw new ApiError(`${field}_required`, 400);
  if (clean.length > max) throw new ApiError(`${field}_too_long`, 400);
  return clean;
}

function minutes(value, field) {
  const [hour, minute] = normalizeTime(value, field).split(':').map(Number);
  return hour * 60 + minute;
}

export async function saveTeamEvent(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const db = env.TEAM_DB;
  const timezone = storeTimezone(env);
  const title = text(payload.title, 120, 'title', true);
  const description = text(payload.description, 1000, 'description');
  const location = text(payload.location, 200, 'location');
  const allDay = payload.allDay === true;
  const date = normalizeDate(payload.date, 'date');
  let startMs;
  let endMs;
  if (allDay) {
    const endDate = payload.endDate ? normalizeDate(payload.endDate, 'end_date') : date;
    if (endDate < date) throw new ApiError('invalid_range', 400);
    startMs = wallToUtc(date, 0, timezone);
    endMs = wallToUtc(addDaysToDate(endDate, 1), 0, timezone);
  } else {
    const startMinutes = minutes(payload.startTime, 'start_time');
    const endMinutes = minutes(payload.endTime, 'end_time');
    if (endMinutes <= startMinutes) throw new ApiError('invalid_range', 400);
    startMs = wallToUtc(date, startMinutes, timezone);
    endMs = wallToUtc(date, endMinutes, timezone);
  }
  // A wall time that does not exist (the spring-forward gap) cannot be saved.
  if (startMs === null || endMs === null || endMs <= startMs) throw new ApiError('invalid_range', 400);
  if (endMs - startMs > 31 * 86_400_000) throw new ApiError('invalid_range', 400);
  const blocks = payload.blocksAvailability === true ? 1 : 0;
  const now = nowIso();

  if (payload.id) {
    const existing = await db.prepare('SELECT * FROM team_events WHERE id = ?').bind(String(payload.id)).first();
    if (!existing) throw new ApiError('event_not_found', 404);
    if (actor.role !== 'management' && existing.created_by !== actor.id) throw new ApiError('forbidden', 403);
    await db.prepare(`UPDATE team_events SET title = ?, description = ?, start_utc = ?, end_utc = ?, all_day = ?, location = ?,
        blocks_availability = ?, updated_at = ? WHERE id = ?`)
      .bind(title, description, toIso(startMs), toIso(endMs), allDay ? 1 : 0, location, blocks, now, existing.id).run();
    await audit(db, actor.id, 'team_event.update', 'team_event', existing.id, {});
    return { ok: true, id: existing.id };
  }
  const id = newId('tevent');
  await db.prepare(`INSERT INTO team_events (id, created_by, title, description, start_utc, end_utc, all_day, location,
      blocks_availability, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, actor.id, title, description, toIso(startMs), toIso(endMs), allDay ? 1 : 0, location, blocks, now, now).run();
  await audit(db, actor.id, 'team_event.create', 'team_event', id, {});
  return { ok: true, id };
}

export async function deleteTeamEvent(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const existing = await env.TEAM_DB.prepare('SELECT * FROM team_events WHERE id = ?').bind(String(payload.id || '')).first();
  if (!existing) throw new ApiError('event_not_found', 404);
  if (actor.role !== 'management' && existing.created_by !== actor.id) throw new ApiError('forbidden', 403);
  await env.TEAM_DB.prepare('DELETE FROM team_events WHERE id = ?').bind(existing.id).run();
  await audit(env.TEAM_DB, actor.id, 'team_event.delete', 'team_event', existing.id, { title: existing.title });
  return { ok: true };
}

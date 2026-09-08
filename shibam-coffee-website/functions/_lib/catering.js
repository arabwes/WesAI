import { requireRole } from './auth.js';
import { ApiError, clampInt, newId, nowIso } from './http.js';

const VALID_STATUSES = new Set(['new', 'reviewed', 'closed']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cateringRequestDto(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    eventType: row.event_type,
    eventDate: row.event_date || '',
    guestCount: row.guest_count === null ? null : Number(row.guest_count),
    details: row.details || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || ''
  };
}

// Public, unauthenticated: visitors submit this from catering-events.html.
export async function submitCateringRequest(request, payload, env) {
  // Honeypot — legitimate visitors never fill a field hidden from view.
  if (String(payload.website || '').trim()) {
    return { ok: true, requestId: newId('catering') };
  }

  const name = String(payload.name || '').trim().slice(0, 160);
  const email = String(payload.email || '').trim().slice(0, 200);
  const phone = String(payload.phone || '').trim().slice(0, 40);
  const eventType = String(payload.eventType || '').trim().slice(0, 60);
  if (!name) throw new ApiError('missing_name', 400);
  if (!EMAIL_PATTERN.test(email)) throw new ApiError('invalid_email', 400);
  if (!phone) throw new ApiError('missing_phone', 400);
  if (!eventType) throw new ApiError('missing_event_type', 400);

  const eventDateRaw = String(payload.eventDate || '').trim();
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(eventDateRaw) ? eventDateRaw : '';
  const guestCount = payload.guestCount === '' || payload.guestCount == null
    ? null
    : clampInt(payload.guestCount, 1, 5000, null);
  const details = String(payload.details || '').trim().slice(0, 2000);

  const id = newId('catering');
  const now = nowIso();
  await env.TEAM_DB.prepare(`INSERT INTO catering_requests
    (id, name, email, phone, event_type, event_date, guest_count, details, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`)
    .bind(id, name, email, phone, eventType, eventDate || null, guestCount, details, now)
    .run();

  return { ok: true, requestId: id };
}

// Team-portal only, from here down.
export async function getCateringRequests(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const status = String(payload.status || '').trim();
  const query = VALID_STATUSES.has(status)
    ? { sql: 'SELECT * FROM catering_requests WHERE status = ? ORDER BY created_at DESC', args: [status] }
    : { sql: 'SELECT * FROM catering_requests ORDER BY created_at DESC', args: [] };
  const { results } = await env.TEAM_DB.prepare(query.sql).bind(...query.args).all();
  return { ok: true, requests: results.map(cateringRequestDto) };
}

export async function updateCateringRequestStatus(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const id = String(payload.requestId || '').trim();
  const status = String(payload.status || '').trim();
  if (!id) throw new ApiError('missing_requestId', 400);
  if (!VALID_STATUSES.has(status)) throw new ApiError('invalid_status', 400);

  const result = await env.TEAM_DB.prepare(
    'UPDATE catering_requests SET status = ?, updated_at = ? WHERE id = ?'
  ).bind(status, nowIso(), id).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);

  return { ok: true };
}

import { requireRole } from './auth.js';
import { ApiError, newId, nowIso } from './http.js';

const STATUSES = new Set(['new', 'reviewed', 'closed']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function submitContactRequest(request, payload, env) {
  if (String(payload.website || '').trim()) return { ok: true };

  const name = String(payload.name || '').trim().slice(0, 160);
  const email = String(payload.email || '').trim().slice(0, 200);
  const phone = String(payload.phone || '').trim().slice(0, 40);
  const message = String(payload.message || '').trim().slice(0, 4000);
  if (!name) throw new ApiError('missing_name', 400);
  if (!EMAIL_PATTERN.test(email)) throw new ApiError('invalid_email', 400);
  if (!message) throw new ApiError('missing_message', 400);

  const id = newId('contact');
  await env.TEAM_DB.prepare(`INSERT INTO contact_requests
    (id, name, email, phone, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'new', ?)`)
    .bind(id, name, email, phone, message, nowIso()).run();
  return { ok: true, requestId: id };
}

export async function getContactRequests(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const status = String(payload.status || '').trim();
  const filtered = STATUSES.has(status);
  const { results } = await env.TEAM_DB.prepare(`SELECT * FROM contact_requests
    ${filtered ? 'WHERE status = ?' : ''} ORDER BY created_at DESC`)
    .bind(...(filtered ? [status] : [])).all();
  return { ok: true, requests: results.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    message: row.message,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || ''
  })) };
}

export async function updateContactRequestStatus(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const id = String(payload.requestId || '').trim();
  const status = String(payload.status || '').trim();
  if (!id) throw new ApiError('missing_requestId', 400);
  if (!STATUSES.has(status)) throw new ApiError('invalid_status', 400);
  const result = await env.TEAM_DB.prepare(
    'UPDATE contact_requests SET status = ?, updated_at = ? WHERE id = ?'
  ).bind(status, nowIso(), id).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  return { ok: true };
}

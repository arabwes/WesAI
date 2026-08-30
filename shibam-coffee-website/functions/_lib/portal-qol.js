import { audit, makePassword, requireRole } from './auth.js';
import { ApiError, asBoolean, clampInt, newId, nowIso } from './http.js';

const VALID_LOG_TYPES = new Set(['inventory', 'dessert-daily', 'dessert-order', 'local-order']);

function localDate(value, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function documentDto(row) {
  return {
    documentId: row.id,
    title: row.title,
    description: row.description || '',
    category: row.category || '',
    driveFileId: row.drive_file_id || '',
    status: row.status,
    addedBy: row.added_by,
    addedAt: row.created_at
  };
}

function documentIds(payload) {
  const ids = Array.isArray(payload.documentIds) ? payload.documentIds : payload.documentId ? [payload.documentId] : [];
  return ids.slice(0, 100).map(String).filter(Boolean);
}

export async function updateItem(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const existing = await env.TEAM_DB.prepare('SELECT * FROM catalog WHERE id = ?').bind(payload.catalogId).first();
  if (!existing) throw new ApiError('not_found', 404);
  const changes = payload.changes || {};
  const name = String(changes.name === undefined ? existing.name : changes.name).trim().slice(0, 160);
  if (!name) throw new ApiError('missing_name', 400);
  const duplicate = await env.TEAM_DB.prepare(`SELECT id FROM catalog WHERE form_type = ? AND id != ?
    AND status != 'discontinued' AND name = ? COLLATE NOCASE`).bind(existing.form_type, existing.id, name).first();
  if (duplicate) throw new ApiError('duplicate_name', 409);
  await env.TEAM_DB.prepare(`UPDATE catalog SET name = ?, group_name = ?, unit = ?, threshold = ?, location = ?, target = ?
    WHERE id = ?`).bind(name,
      String(changes.group === undefined ? existing.group_name : changes.group).trim().slice(0, 160),
      String(changes.unit === undefined ? existing.unit : changes.unit).trim().slice(0, 80),
      String(changes.threshold === undefined ? existing.threshold : changes.threshold).trim().slice(0, 80),
      String(changes.location === undefined ? existing.location : changes.location).trim().slice(0, 160),
      String(changes.target === undefined ? existing.target : changes.target).trim().slice(0, 80), existing.id).run();
  await audit(env.TEAM_DB, actor.id, 'catalog.update', 'catalog', existing.id, changes);
  return { ok: true };
}

export async function getDocuments(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const includeAll = asBoolean(payload.includeAll) && actor.role === 'management';
  const query = `SELECT * FROM portal_documents ${includeAll ? '' : "WHERE status = 'active'"} ORDER BY category, title`;
  const { results } = await env.TEAM_DB.prepare(query).all();
  return { ok: true, documents: results.map(documentDto) };
}

export async function addDocument(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const input = payload.document || {};
  const title = String(input.title || '').trim().slice(0, 160);
  if (!title) throw new ApiError('missing_title', 400);
  const id = newId('document');
  const now = nowIso();
  await env.TEAM_DB.prepare(`INSERT INTO portal_documents
    (id, title, description, category, drive_file_id, status, added_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .bind(id, title, String(input.description || '').trim().slice(0, 500), String(input.category || '').trim().slice(0, 100),
      String(input.driveFileId || '').trim().slice(0, 250), actor.username, now, actor.id, now).run();
  await audit(env.TEAM_DB, actor.id, 'document.add', 'portal_document', id, { title });
  return { ok: true, documentId: id };
}

export async function updateDocument(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const existing = await env.TEAM_DB.prepare('SELECT * FROM portal_documents WHERE id = ?').bind(payload.documentId).first();
  if (!existing) throw new ApiError('not_found', 404);
  const changes = payload.changes || {};
  const title = String(changes.title === undefined ? existing.title : changes.title).trim().slice(0, 160);
  if (!title) throw new ApiError('missing_title', 400);
  await env.TEAM_DB.prepare(`UPDATE portal_documents SET title = ?, description = ?, category = ?, drive_file_id = ?,
    updated_by = ?, updated_at = ? WHERE id = ?`).bind(title,
      String(changes.description === undefined ? existing.description : changes.description).trim().slice(0, 500),
      String(changes.category === undefined ? existing.category : changes.category).trim().slice(0, 100),
      String(changes.driveFileId === undefined ? existing.drive_file_id : changes.driveFileId).trim().slice(0, 250),
      actor.id, nowIso(), existing.id).run();
  await audit(env.TEAM_DB, actor.id, 'document.update', 'portal_document', existing.id, changes);
  return { ok: true };
}

async function setDocumentStatus(request, payload, env, status) {
  const actor = await requireRole(request, payload, env, 'management');
  const ids = documentIds(payload);
  if (!ids.length) throw new ApiError('not_found', 404);
  const now = nowIso();
  const results = await env.TEAM_DB.batch(ids.map((id) => env.TEAM_DB.prepare(
    'UPDATE portal_documents SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(status, actor.id, now, id)));
  const updated = ids.filter((id, index) => Number(results[index].meta?.changes) > 0);
  await audit(env.TEAM_DB, actor.id, `document.${status}`, 'portal_document', updated.join(','), { count: updated.length });
  return { ok: true, updated, notFound: ids.filter((id) => !updated.includes(id)) };
}

export function discontinueDocument(request, payload, env) {
  return setDocumentStatus(request, payload, env, 'discontinued');
}

export function restoreDocument(request, payload, env) {
  return setDocumentStatus(request, payload, env, 'active');
}

export async function resetPassword(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const username = String(payload.username || '').trim();
  const target = await env.TEAM_DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
  if (!target) throw new ApiError('not_found', 404);
  const password = await makePassword(payload.newPassword);
  const now = nowIso();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, password_algorithm = ?, updated_at = ? WHERE id = ?`)
      .bind(password.hash, password.salt, password.algorithm, now, target.id),
    env.TEAM_DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, target.id)
  ]);
  await audit(env.TEAM_DB, actor.id, 'user.password_reset', 'user', target.id, {});
  return { ok: true };
}

export async function getChangelog(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  const limit = clampInt(payload.limit, 1, 500, 200);
  const { results } = await env.TEAM_DB.prepare(`SELECT ae.*, u.username, u.role FROM audit_events ae
    LEFT JOIN users u ON u.id = ae.actor_user_id ORDER BY ae.created_at DESC LIMIT ?`).bind(limit).all();
  return { ok: true, entries: results.map((row) => ({
    timestamp: row.created_at,
    username: row.username || 'System',
    role: row.role || '',
    action: row.action,
    target: row.entity_id || row.entity_type,
    details: row.details_json || '{}'
  })) };
}

export async function getMyEntries(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  if (!VALID_LOG_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const today = localDate(new Date(), env.STORE_TIMEZONE);
  const { results } = await env.TEAM_DB.prepare(`SELECT * FROM form_entries WHERE form_type = ? AND employee_id = ?
    AND submission_id IS NOT NULL ORDER BY submitted_at DESC LIMIT 500`).bind(payload.formType, actor.id).all();
  const grouped = new Map();
  results.filter((row) => localDate(row.submitted_at, env.STORE_TIMEZONE) === today && row.details_json !== '{"removed":true}')
    .forEach((row) => {
      if (!grouped.has(row.submission_id)) grouped.set(row.submission_id, {
        submissionId: row.submission_id, submittedAt: row.submitted_at, date: row.entry_date, items: []
      });
      grouped.get(row.submission_id).items.push({ entryId: row.id, product: row.product, details: row.details_json });
    });
  return { ok: true, submissions: Array.from(grouped.values()) };
}

function inputRows(payload) {
  const rows = [];
  (Array.isArray(payload.items) ? payload.items : []).forEach((item) => {
    const product = String(item.product || '').trim();
    if (product) rows.push({ product, details: JSON.stringify(item) });
  });
  (Array.isArray(payload.unlistedItems) ? payload.unlistedItems : []).forEach((item) => {
    const name = String(item.name || '').trim();
    if (name) rows.push({ product: `${name} (not on list)`, details: JSON.stringify(item) });
  });
  return rows;
}

export async function updateMyEntries(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  if (!VALID_LOG_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const submissionId = String(payload.submissionId || '');
  if (!submissionId) throw new ApiError('missing_submissionId', 400);
  const { results: existing } = await env.TEAM_DB.prepare(`SELECT * FROM form_entries
    WHERE form_type = ? AND submission_id = ? ORDER BY submitted_at, id`).bind(payload.formType, submissionId).all();
  const today = localDate(new Date(), env.STORE_TIMEZONE);
  if (!existing.length || existing.some((row) => row.employee_id !== actor.id || localDate(row.submitted_at, env.STORE_TIMEZONE) !== today)) {
    throw new ApiError('not_found', 404);
  }
  const incoming = inputRows(payload);
  if (!incoming.length) throw new ApiError('empty_submission', 400);
  const now = nowIso();
  const entryDate = String(payload.weekOf || payload.date || payload.orderDate || existing[0].entry_date || '');
  const available = [...existing];
  const statements = [];
  incoming.forEach((item) => {
    const index = available.findIndex((row) => row.product === item.product);
    if (index >= 0) {
      const row = available.splice(index, 1)[0];
      statements.push(env.TEAM_DB.prepare(`UPDATE form_entries SET entry_date = ?, details_json = ?, last_edited_by = ?,
        last_edited_at = ? WHERE id = ?`).bind(entryDate, item.details, actor.name, now, row.id));
    } else {
      statements.push(env.TEAM_DB.prepare(`INSERT INTO form_entries
        (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json, last_edited_by, last_edited_at, submission_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(newId('entry'), payload.formType, existing[0].submitted_at, actor.id, actor.name, entryDate, item.product,
          item.details, actor.name, now, submissionId));
    }
  });
  available.forEach((row) => statements.push(env.TEAM_DB.prepare(`UPDATE form_entries SET details_json = '{"removed":true}',
    last_edited_by = ?, last_edited_at = ? WHERE id = ?`).bind(actor.name, now, row.id)));
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, actor.id, 'form.update_own_submission', 'form_submission', submissionId, { formType: payload.formType });
  return { ok: true };
}

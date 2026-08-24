import { audit, hasRole, makePassword, requireRole } from './auth.js';
import { ApiError, asBoolean, clampInt, newId, nowIso, publicUser } from './http.js';

const VALID_FORM_TYPES = new Set(['inventory', 'dessert', 'local-order']);
const VALID_LOG_TYPES = new Set(['inventory', 'dessert-daily', 'dessert-order', 'local-order']);

export async function getCatalog(request, payload, env) {
  const user = await requireRole(request, payload, env);
  if (!VALID_FORM_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const includeAll = asBoolean(payload.includeAll) && hasRole(user, 'management');
  const query = `SELECT * FROM catalog WHERE form_type = ? ${includeAll ? '' : "AND status != 'discontinued'"} ORDER BY created_at, name`;
  const { results } = await env.TEAM_DB.prepare(query).bind(payload.formType).all();
  return { ok: true, items: results.map((row) => ({
    catalogId: row.id,
    formType: row.form_type,
    group: row.group_name,
    name: row.name,
    unit: row.unit,
    threshold: row.threshold,
    location: row.location,
    target: row.target,
    status: row.status,
    addedBy: row.added_by,
    addedAt: row.created_at
  })) };
}

export async function addItem(request, payload, env) {
  const user = await requireRole(request, payload, env, 'lead');
  if (!VALID_FORM_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const item = payload.item || {};
  const name = String(item.name || '').trim();
  if (!name) throw new ApiError('missing_name', 400);
  const id = newId('catalog');
  await env.TEAM_DB.prepare(`INSERT INTO catalog
    (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .bind(id, payload.formType, item.group || '', name, item.unit || '', String(item.threshold || ''), item.location || '', item.target || '', user.username, nowIso()).run();
  await audit(env.TEAM_DB, user.id, 'catalog.add', 'catalog', id, { formType: payload.formType, name });
  return { ok: true, catalogId: id };
}

export async function setItemStatus(request, payload, env, status) {
  const user = await requireRole(request, payload, env, status === 'flagged' ? 'lead' : 'management');
  const result = await env.TEAM_DB.prepare('UPDATE catalog SET status = ? WHERE id = ?')
    .bind(status, payload.catalogId).run();
  if (!result.meta.changes) throw new ApiError('not_found', 404);
  await audit(env.TEAM_DB, user.id, `catalog.${status}`, 'catalog', payload.catalogId, {});
  return { ok: true };
}

export async function submitForm(request, payload, env) {
  const user = await requireRole(request, payload, env);
  if (!VALID_LOG_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const submittedAt = String(payload.submittedAt || nowIso());
  const entryDate = String(payload.weekOf || payload.date || payload.orderDate || '');
  const items = Array.isArray(payload.items) ? payload.items : [];
  const unlisted = Array.isArray(payload.unlistedItems) ? payload.unlistedItems : [];
  if (!items.length && !unlisted.length) throw new ApiError('empty_submission', 400);
  const statements = [];
  for (const item of items) {
    const product = String(item.product || '').trim();
    if (!product) continue;
    statements.push(env.TEAM_DB.prepare(`INSERT INTO form_entries
      (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('entry'), payload.formType, submittedAt, user.id, user.name, entryDate, product, JSON.stringify(item)));
  }
  for (const item of unlisted) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    statements.push(env.TEAM_DB.prepare(`INSERT INTO form_entries
      (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('entry'), payload.formType, submittedAt, user.id, user.name, entryDate, `${name} (not on list)`, JSON.stringify(item)));
  }
  if (!statements.length) throw new ApiError('empty_submission', 400);
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, user.id, 'form.submit', 'form_submission', submittedAt, { formType: payload.formType, rows: statements.length });
  return { ok: true };
}

export async function getEntries(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  if (!VALID_LOG_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const limit = clampInt(payload.limit, 1, 500, 200);
  const { results } = await env.TEAM_DB.prepare(`SELECT * FROM form_entries
    WHERE form_type = ? ORDER BY submitted_at DESC LIMIT ?`).bind(payload.formType, limit).all();
  return { ok: true, entries: results.map((row) => ({
    submittedAt: row.submitted_at,
    employeeName: row.employee_name,
    date: row.entry_date,
    product: row.product,
    details: row.details_json,
    entryId: row.id,
    lastEditedBy: row.last_edited_by || '',
    lastEditedAt: row.last_edited_at || ''
  })) };
}

export async function updateEntry(request, payload, env) {
  const user = await requireRole(request, payload, env, 'management');
  const existing = await env.TEAM_DB.prepare('SELECT * FROM form_entries WHERE id = ? AND form_type = ?')
    .bind(payload.entryId, payload.formType).first();
  if (!existing) throw new ApiError('not_found', 404);
  const changes = payload.changes || {};
  const date = changes.date === undefined ? existing.entry_date : String(changes.date);
  const product = changes.product === undefined ? existing.product : String(changes.product);
  const details = changes.details === undefined ? existing.details_json : String(changes.details);
  try { JSON.parse(details); } catch { throw new ApiError('invalid_details_json', 400); }
  await env.TEAM_DB.prepare(`UPDATE form_entries SET entry_date = ?, product = ?, details_json = ?,
    last_edited_by = ?, last_edited_at = ? WHERE id = ?`)
    .bind(date, product, details, user.username, nowIso(), existing.id).run();
  await audit(env.TEAM_DB, user.id, 'form.update', 'form_entry', existing.id, { date, product });
  return { ok: true };
}

export async function getUsers(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  const { results } = await env.TEAM_DB.prepare('SELECT * FROM users ORDER BY active DESC, name').all();
  return { ok: true, users: results.map(publicUser) };
}

export async function addUser(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const input = payload.newUser || {};
  const username = String(input.username || '').trim();
  const name = String(input.name || username).trim();
  const role = String(input.role || 'barista');
  const email = String(input.email || '').trim() || null;
  if (!username || !name || !['barista', 'lead', 'management'].includes(role)) throw new ApiError('invalid_user', 400);
  const exists = await env.TEAM_DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
  if (exists) throw new ApiError('username_taken', 409);
  const password = await makePassword(input.password);
  const id = newId('usr');
  const now = nowIso();
  const positionId = role === 'management' ? 'position-management' : role === 'lead' ? 'position-lead' : 'position-barista';
  try {
    await env.TEAM_DB.batch([
      env.TEAM_DB.prepare(`INSERT INTO users
        (id, username, name, email, role, password_hash, password_salt, password_algorithm,
         max_weekly_minutes, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, username, name, email, role, password.hash, password.salt, password.algorithm,
          clampInt(input.maxWeeklyMinutes, 0, 10080, 2400), now, now),
      env.TEAM_DB.prepare('INSERT INTO employee_positions (user_id, position_id) VALUES (?, ?)').bind(id, positionId)
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('email_or_username_taken', 409);
    throw error;
  }
  await audit(env.TEAM_DB, actor.id, 'user.add', 'user', id, { username, role });
  return { ok: true, userId: id };
}

export async function removeUser(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const target = await env.TEAM_DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').bind(payload.username).first();
  if (!target) throw new ApiError('not_found', 404);
  if (target.id === actor.id) throw new ApiError('cannot_remove_self', 409);
  if (target.role === 'management' && asBoolean(target.active)) {
    const count = await env.TEAM_DB.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'management' AND active = 1").first();
    if (Number(count.total) <= 1) throw new ApiError('cannot_remove_last_management', 409);
  }
  const now = nowIso();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').bind(now, target.id),
    env.TEAM_DB.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now, target.id)
  ]);
  await audit(env.TEAM_DB, actor.id, 'user.remove', 'user', target.id, { username: target.username });
  return { ok: true };
}

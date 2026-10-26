import { audit, hasRole, makePassword, requireRole } from './auth.js';
import { ApiError, asBoolean, clampInt, newId, nowIso, publicUser, safeJsonParse } from './http.js';
import { diffFields, editNeedsReason, parseQuantity } from './inventory-rules.js';

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
    maxQty: row.max_qty === null || row.max_qty === undefined ? null : Number(row.max_qty),
    sectionId: row.section_id || '',
    sortOrder: Number(row.sort_order || 0),
    addedBy: row.added_by,
    addedAt: row.created_at
  })) };
}

export function optionalMaxQty(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new ApiError('invalid_max_qty', 400);
  return number;
}

export async function addItem(request, payload, env) {
  const user = await requireRole(request, payload, env, 'lead');
  if (!VALID_FORM_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const item = payload.item || {};
  const name = String(item.name || '').trim();
  if (!name) throw new ApiError('missing_name', 400);
  // Every counted item needs the unit it's counted in (matching how it's bought).
  if (payload.formType === 'inventory' && !String(item.unit || '').trim()) throw new ApiError('missing_unit', 400);
  const duplicate = await env.TEAM_DB.prepare(`SELECT id FROM catalog WHERE form_type = ? AND status != 'discontinued'
    AND name = ? COLLATE NOCASE`).bind(payload.formType, name).first();
  if (duplicate) throw new ApiError('duplicate_name', 409);
  const id = newId('catalog');
  const sectionId = payload.formType === 'inventory' && item.sectionId ? String(item.sectionId) : null;
  const last = sectionId
    ? await env.TEAM_DB.prepare('SELECT MAX(sort_order) AS last FROM catalog WHERE section_id = ?').bind(sectionId).first()
    : null;
  await env.TEAM_DB.prepare(`INSERT INTO catalog
    (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at, max_qty, section_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
    .bind(id, payload.formType, item.group || '', name, String(item.unit || '').trim(), String(item.threshold || ''), item.location || '',
      item.target || '', user.username, nowIso(), optionalMaxQty(item.maxQty), sectionId, Number(last?.last || 0) + 10).run();
  await audit(env.TEAM_DB, user.id, 'catalog.add', 'catalog', id, { formType: payload.formType, name });
  return { ok: true, catalogId: id };
}

export async function setItemStatus(request, payload, env, status) {
  const user = await requireRole(request, payload, env, status === 'flagged' ? 'lead' : 'management');
  const ids = (Array.isArray(payload.catalogIds) ? payload.catalogIds : payload.catalogId ? [payload.catalogId] : [])
    .slice(0, 100).map(String).filter(Boolean);
  if (!ids.length) throw new ApiError('not_found', 404);
  const results = await env.TEAM_DB.batch(ids.map((id) => env.TEAM_DB.prepare('UPDATE catalog SET status = ? WHERE id = ?')
    .bind(status, id)));
  const updated = ids.filter((id, index) => Number(results[index].meta?.changes) > 0);
  await audit(env.TEAM_DB, user.id, `catalog.${status}`, 'catalog', updated.join(','), { count: updated.length });
  return { ok: true, updated, notFound: ids.filter((id) => !updated.includes(id)) };
}

export async function submitForm(request, payload, env) {
  const user = await requireRole(request, payload, env);
  if (!VALID_LOG_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  // The weekly count goes through the draft workflow (see inventory.js),
  // which enforces completeness, dates, and outlier confirmation.
  if (payload.formType === 'inventory') throw new ApiError('use_inventory_count', 400);
  const submittedAt = nowIso();
  const entryDate = String(payload.weekOf || payload.date || payload.orderDate || '');
  const items = Array.isArray(payload.items) ? payload.items : [];
  const unlisted = Array.isArray(payload.unlistedItems) ? payload.unlistedItems : [];
  if (!items.length && !unlisted.length) throw new ApiError('empty_submission', 400);
  if (payload.formType === 'dessert-daily') validateDessertDaily(items);
  const submissionId = newId('submission');
  const statements = [];
  for (const item of items) {
    const product = String(item.product || '').trim();
    if (!product) continue;
    statements.push(env.TEAM_DB.prepare(`INSERT INTO form_entries
      (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json, submission_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('entry'), payload.formType, submittedAt, user.id, user.name, entryDate, product, JSON.stringify(item), submissionId));
  }
  for (const item of unlisted) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    statements.push(env.TEAM_DB.prepare(`INSERT INTO form_entries
      (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json, submission_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId('entry'), payload.formType, submittedAt, user.id, user.name, entryDate, `${name} (not on list)`, JSON.stringify(item), submissionId));
  }
  if (!statements.length) throw new ApiError('empty_submission', 400);
  await env.TEAM_DB.batch(statements);
  await audit(env.TEAM_DB, user.id, 'form.submit', 'form_submission', submissionId, { formType: payload.formType, rows: statements.length });
  return { ok: true, submissionId };
}

// A blank dessert count means nobody checked; 0 has to be entered on purpose.
export function validateDessertDaily(items) {
  const blank = items.filter((item) => ['countOnHand', 'deliveryReceived'].some((key) => {
    const value = item[key];
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0;
  }));
  if (blank.length) {
    throw new ApiError('incomplete', 400, { missingCount: blank.length, missing: blank.slice(0, 100).map((item) => ({ name: item.product })) });
  }
}

export async function getEntries(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  if (!VALID_LOG_TYPES.has(payload.formType)) throw new ApiError('invalid_formType', 400);
  const limit = clampInt(payload.limit, 1, 500, 500);
  const offset = clampInt(payload.offset, 0, 2_147_483_647, 0);
  // Voided inventory counts (blank duplicates, merged halves) stay in the
  // database for the record but are left out of the list and the export.
  const { results } = await env.TEAM_DB.prepare(`SELECT e.* FROM form_entries e
    LEFT JOIN inventory_counts ic ON ic.id = e.submission_id
    WHERE e.form_type = ? AND (ic.status IS NULL OR ic.status != 'void')
    ORDER BY e.submitted_at DESC, e.id DESC LIMIT ? OFFSET ?`).bind(payload.formType, limit + 1, offset).all();
  const page = results.slice(0, limit);
  const edits = new Map();
  if (page.length) {
    const { results: editRows } = await env.TEAM_DB.prepare(`SELECT * FROM form_entry_edits
      WHERE entry_id IN (SELECT value FROM json_each(?)) ORDER BY edited_at`).bind(JSON.stringify(page.map((row) => row.id))).all();
    editRows.forEach((edit) => {
      if (!edits.has(edit.entry_id)) edits.set(edit.entry_id, []);
      edits.get(edit.entry_id).push({ field: edit.field, oldValue: edit.old_value ?? '', newValue: edit.new_value ?? '',
        editedBy: edit.edited_by_name, editedAt: edit.edited_at, reason: edit.reason || '' });
    });
  }
  return { ok: true, hasMore: results.length > limit, entries: page.map((row) => ({
    submittedAt: row.submitted_at,
    employeeName: row.employee_name,
    date: row.entry_date,
    product: row.product,
    details: row.details_json,
    entryId: row.id,
    submissionId: row.submission_id || '',
    lastEditedBy: row.last_edited_by || '',
    lastEditedAt: row.last_edited_at || '',
    catalogId: row.catalog_id || '',
    edits: edits.get(row.id) || []
  })) };
}

// One form_entry_edits row per changed field, so the record shows exactly
// what changed, from what, to what, by whom, and why.
export function editLogStatements(env, existing, changes, actor, reason, now) {
  return changes.map((change) => env.TEAM_DB.prepare(`INSERT INTO form_entry_edits
      (id, entry_id, submission_id, form_type, field, old_value, new_value, edited_by, edited_by_name, edited_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId('edit'), existing.id, existing.submission_id || null, existing.form_type, change.field,
      change.oldValue, change.newValue, actor.id, actor.name, now, reason || null));
}

// Flattens a row into comparable fields: date, product, and each details key.
export function entryFields(row, details) {
  const parsed = safeJsonParse(details, {});
  const fields = { date: row.entry_date, product: row.product };
  Object.entries(parsed).forEach(([key, value]) => {
    if (key === 'product') return;
    fields[key] = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
  });
  return fields;
}

export async function updateEntry(request, payload, env) {
  const user = await requireRole(request, payload, env, 'management');
  const existing = await env.TEAM_DB.prepare('SELECT * FROM form_entries WHERE id = ? AND form_type = ?')
    .bind(payload.entryId, payload.formType).first();
  if (!existing) throw new ApiError('not_found', 404);
  const changes = payload.changes || {};
  const date = changes.date === undefined ? existing.entry_date : String(changes.date);
  // Inventory rows are tied to their item by catalog_id; the name shown is
  // the catalog's, so it isn't edited per row.
  const product = changes.product === undefined || existing.form_type === 'inventory' ? existing.product : String(changes.product);
  const details = changes.details === undefined ? existing.details_json : String(changes.details);
  let parsedDetails;
  try { parsedDetails = JSON.parse(details); } catch { throw new ApiError('invalid_details_json', 400); }
  if (existing.form_type === 'inventory') {
    ['qtyKitchen', 'qtyStorage'].forEach((key) => {
      const value = parseQuantity(parsedDetails[key]);
      if (value === null || Number.isNaN(value)) throw new ApiError('invalid_quantity', 400, { field: key });
      parsedDetails[key] = value;
    });
  }
  const normalizedDetails = existing.form_type === 'inventory' ? JSON.stringify(parsedDetails) : details;
  const now = nowIso();
  const diff = diffFields(entryFields(existing, existing.details_json), entryFields({ entry_date: date, product }, normalizedDetails));
  if (!diff.length) return { ok: true, unchanged: true };
  const reason = String(payload.reason || '').trim().slice(0, 300);
  if (!reason && editNeedsReason(existing.submitted_at, now)) throw new ApiError('edit_reason_required', 400);
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`UPDATE form_entries SET entry_date = ?, product = ?, details_json = ?,
      last_edited_by = ?, last_edited_at = ? WHERE id = ?`)
      .bind(date, product, normalizedDetails, user.username, now, existing.id),
    ...editLogStatements(env, existing, diff, user, reason, now)
  ]);
  await audit(env.TEAM_DB, user.id, 'form.update', 'form_entry', existing.id, { changes: diff, reason });
  return { ok: true };
}

export async function getUsers(request, payload, env) {
  await requireRole(request, payload, env, 'management');
  const { results } = await env.TEAM_DB.prepare(`SELECT u.*, COALESCE(GROUP_CONCAT(ep.position_id), '') AS position_ids
    FROM users u LEFT JOIN employee_positions ep ON ep.user_id = u.id
    GROUP BY u.id ORDER BY u.active DESC, u.name`).all();
  return { ok: true, users: results.map((row) => ({ ...publicUser(row), preferredName: row.preferred_name || '',
    phone: row.phone_e164 || '', phoneVerified: !!row.phone_verified_at,
    positionIds: row.position_ids ? row.position_ids.split(',') : [] })) };
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
  const positionIds = Array.isArray(input.positionIds) ? input.positionIds.slice(0, 20).filter(Boolean) : [];
  if (!positionIds.length) positionIds.push(role === 'management' ? 'position-management' : role === 'lead' ? 'position-lead' : 'position-barista');
  try {
    const statements = [
      env.TEAM_DB.prepare(`INSERT INTO users
        (id, username, name, email, role, password_hash, password_salt, password_algorithm,
         max_weekly_minutes, active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .bind(id, username, name, email, role, password.hash, password.salt, password.algorithm,
          clampInt(input.maxWeeklyMinutes, 0, 10080, 2400), now, now)
    ];
    positionIds.forEach((positionId) => statements.push(env.TEAM_DB.prepare(
      'INSERT INTO employee_positions (user_id, position_id) VALUES (?, ?)').bind(id, positionId)));
    await env.TEAM_DB.batch(statements);
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

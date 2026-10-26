import { audit, hasRole, requireRole } from './auth.js';
import { ApiError, newId, nowIso, safeJsonParse } from './http.js';
import {
  checkCountDate, isItemComplete, outlierReasons, parseQuantity, previousDate, storeDate
} from './inventory-rules.js';

// Weekly inventory count: one shared server-side draft for the whole store,
// filled in over time by anyone, then submitted exactly once. Submitted
// rows land in form_entries (keyed by catalog_id) so the existing admin
// Submissions view and CSV export keep working.

const UNASSIGNED_SECTION = { id: '', name: 'Unassigned items', sortOrder: 1_000_000 };

function draftDto(row) {
  if (!row) return null;
  const draft = safeJsonParse(row.draft_json, {});
  return {
    draftId: row.id,
    countDate: row.count_date,
    dateReason: row.date_reason || '',
    items: draft.items || {},
    contributors: safeJsonParse(row.contributors_json, []),
    startedByName: row.started_by_name || '',
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    version: Number(row.version || 1)
  };
}

async function activeItems(env) {
  const { results } = await env.TEAM_DB.prepare(`SELECT c.*, s.name AS section_name, s.sort_order AS section_order,
      s.status AS section_status
    FROM catalog c LEFT JOIN inventory_sections s ON s.id = c.section_id
    WHERE c.form_type = 'inventory' AND c.status != 'discontinued'`).all();
  return results.map((row) => {
    const assigned = row.section_id && row.section_status === 'active';
    return {
      catalogId: row.id,
      name: row.name,
      unit: row.unit || '',
      category: row.group_name || '',
      maxQty: row.max_qty === null || row.max_qty === undefined ? null : Number(row.max_qty),
      sectionId: assigned ? row.section_id : UNASSIGNED_SECTION.id,
      sectionName: assigned ? row.section_name : UNASSIGNED_SECTION.name,
      sectionOrder: assigned ? Number(row.section_order || 0) : UNASSIGNED_SECTION.sortOrder,
      sortOrder: Number(row.sort_order || 0),
      status: row.status
    };
  }).sort((a, b) => a.sectionOrder - b.sectionOrder || a.sectionName.localeCompare(b.sectionName)
    || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

// The most recent submitted (non-void) count of each item before `beforeDate`.
async function previousCounts(env, beforeDate) {
  const { results } = await env.TEAM_DB.prepare(`SELECT e.catalog_id, ic.count_date, e.details_json
    FROM form_entries e JOIN inventory_counts ic ON ic.id = e.submission_id
    WHERE e.form_type = 'inventory' AND ic.status = 'submitted' AND ic.count_date < ?
      AND e.catalog_id IS NOT NULL AND e.details_json != '{"removed":true}'
    ORDER BY ic.count_date DESC, ic.submitted_at DESC LIMIT 2000`).bind(beforeDate).all();
  const byItem = new Map();
  results.forEach((row) => {
    if (byItem.has(row.catalog_id)) return;
    const details = safeJsonParse(row.details_json, {});
    const kitchen = Number(details.qtyKitchen ?? details.qtyOnHand ?? 0) || 0;
    const storage = Number(details.qtyStorage ?? 0) || 0;
    byItem.set(row.catalog_id, { date: row.count_date, kitchen, storage, total: kitchen + storage });
  });
  return byItem;
}

function groupSections(items, previous) {
  const sections = [];
  const byId = new Map();
  items.forEach((item) => {
    if (!byId.has(item.sectionId)) {
      const section = { sectionId: item.sectionId, name: item.sectionName, items: [] };
      byId.set(item.sectionId, section);
      sections.push(section);
    }
    byId.get(item.sectionId).items.push({ ...item, previous: previous.get(item.catalogId) || null });
  });
  return sections;
}

async function openDraft(env) {
  return env.TEAM_DB.prepare("SELECT * FROM inventory_counts WHERE status = 'draft' LIMIT 1").first();
}

export async function getInventoryCount(request, payload, env) {
  await requireRole(request, payload, env);
  const draftRow = await openDraft(env);
  const today = storeDate(new Date(), env.STORE_TIMEZONE);
  const countDate = draftRow?.count_date || today;
  const [items, previous, submitted] = await Promise.all([
    activeItems(env),
    previousCounts(env, countDate),
    env.TEAM_DB.prepare(`SELECT count_date FROM inventory_counts WHERE status = 'submitted' AND count_date >= ?`)
      .bind(previousDate(today)).all()
  ]);
  return {
    ok: true,
    today,
    yesterday: previousDate(today),
    submittedDates: submitted.results.map((row) => row.count_date),
    sections: groupSections(items, previous),
    draft: draftDto(draftRow)
  };
}

function validateChanges(changes, knownIds) {
  const clean = {};
  Object.entries(changes || {}).slice(0, 500).forEach(([catalogId, input]) => {
    if (!knownIds.has(catalogId)) return;
    const qtyKitchen = parseQuantity(input?.qtyKitchen);
    const qtyStorage = parseQuantity(input?.qtyStorage);
    if (Number.isNaN(qtyKitchen) || Number.isNaN(qtyStorage)) {
      throw new ApiError('invalid_quantity', 400, { catalogId });
    }
    clean[catalogId] = { qtyKitchen, qtyStorage, note: String(input?.note || '').trim().slice(0, 300) };
  });
  return clean;
}

export async function saveInventoryDraft(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const dates = checkCountDate(String(payload.countDate || ''), 'n/a', new Date(), env.STORE_TIMEZONE);
  if (!dates.ok) throw new ApiError('count_date_not_allowed', 400, { today: dates.today, yesterday: dates.yesterday });
  const items = await activeItems(env);
  const changes = validateChanges(payload.changes, new Set(items.map((item) => item.catalogId)));
  const requestedDraftId = String(payload.draftId || '');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = nowIso();
    let row = await openDraft(env);
    if (requestedDraftId && (!row || row.id !== requestedDraftId)) {
      // Someone else submitted or discarded the draft this device was editing.
      throw new ApiError('draft_closed', 409, { draft: draftDto(row) });
    }
    if (!row) {
      const id = newId('submission');
      try {
        await env.TEAM_DB.prepare(`INSERT INTO inventory_counts
          (id, status, count_date, date_reason, draft_json, contributors_json, started_by, started_by_name, started_at, updated_at, version)
          VALUES (?, 'draft', ?, ?, '{"items":{}}', '[]', ?, ?, ?, ?, 1)`)
          .bind(id, payload.countDate, String(payload.dateReason || '').trim().slice(0, 300), actor.id, actor.name, now, now).run();
        await audit(env.TEAM_DB, actor.id, 'inventory.draft_start', 'inventory_count', id, { countDate: payload.countDate });
      } catch (error) {
        if (!String(error).includes('UNIQUE')) throw error;
      }
      row = await openDraft(env);
      if (!row) continue;
    }

    const draft = safeJsonParse(row.draft_json, {});
    const merged = { ...(draft.items || {}) };
    Object.entries(changes).forEach(([catalogId, values]) => {
      merged[catalogId] = { ...values, updatedBy: actor.name, updatedAt: now };
    });
    const contributors = safeJsonParse(row.contributors_json, []);
    if (Object.keys(changes).length && !contributors.includes(actor.name)) contributors.push(actor.name);

    const result = await env.TEAM_DB.prepare(`UPDATE inventory_counts
      SET draft_json = ?, count_date = ?, date_reason = ?, contributors_json = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'draft' AND version = ?`)
      .bind(JSON.stringify({ items: merged }), payload.countDate, String(payload.dateReason || '').trim().slice(0, 300),
        JSON.stringify(contributors), now, row.id, row.version).run();
    if (Number(result.meta?.changes) > 0) {
      return { ok: true, draft: draftDto(await openDraft(env)) };
    }
    // Another device saved between our read and write — re-read and re-merge.
  }
  throw new ApiError('draft_busy', 409);
}

export async function submitInventoryCount(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const draftId = String(payload.draftId || '');
  const row = await env.TEAM_DB.prepare('SELECT * FROM inventory_counts WHERE id = ?').bind(draftId).first();
  if (!row) throw new ApiError('draft_not_found', 404);
  if (row.status !== 'draft') throw new ApiError('already_submitted', 409);

  const countDate = String(payload.countDate || row.count_date);
  const dateReason = String(payload.dateReason ?? row.date_reason ?? '').trim().slice(0, 300);
  const dates = checkCountDate(countDate, dateReason, new Date(), env.STORE_TIMEZONE);
  if (!dates.ok) throw new ApiError(dates.error, 400, { today: dates.today, yesterday: dates.yesterday });

  const existing = await env.TEAM_DB.prepare(`SELECT id FROM inventory_counts WHERE status = 'submitted' AND count_date = ?`)
    .bind(countDate).first();
  if (existing) throw new ApiError('count_exists_for_date', 409, { countDate });

  const items = await activeItems(env);
  const entries = safeJsonParse(row.draft_json, {}).items || {};
  const missing = items.filter((item) => !isItemComplete(entries[item.catalogId]));
  if (missing.length) {
    throw new ApiError('incomplete', 400, {
      missingCount: missing.length,
      missing: missing.slice(0, 200).map((item) => ({ catalogId: item.catalogId, name: item.name, sectionName: item.sectionName }))
    });
  }

  const previous = await previousCounts(env, countDate);
  const confirmed = new Set(Array.isArray(payload.confirmedOutliers) ? payload.confirmedOutliers.map(String) : []);
  const outliers = [];
  const rows = items.map((item) => {
    const entry = entries[item.catalogId];
    const qtyKitchen = parseQuantity(entry.qtyKitchen);
    const qtyStorage = parseQuantity(entry.qtyStorage);
    if (Number.isNaN(qtyKitchen) || Number.isNaN(qtyStorage)) throw new ApiError('invalid_quantity', 400, { catalogId: item.catalogId });
    const prior = previous.get(item.catalogId) || null;
    const reasons = outlierReasons(qtyKitchen + qtyStorage, prior ? prior.total : null, item.maxQty);
    if (reasons.length && !confirmed.has(item.catalogId)) {
      outliers.push({
        catalogId: item.catalogId, name: item.name, unit: item.unit, newTotal: qtyKitchen + qtyStorage,
        previousTotal: prior ? prior.total : null, previousDate: prior ? prior.date : null, maxQty: item.maxQty, reasons
      });
    }
    const details = {
      product: item.name, category: item.category, unit: item.unit,
      qtyKitchen, qtyStorage, notes: entry.note || ''
    };
    if (reasons.length) { details.outlierConfirmed = true; details.outlierReasons = reasons; }
    return { id: newId('entry'), catalogId: item.catalogId, product: item.name, details: JSON.stringify(details) };
  });
  if (outliers.length) throw new ApiError('outliers_need_confirmation', 409, { outliers });

  const now = nowIso();
  const token = crypto.randomUUID();
  const contributors = safeJsonParse(row.contributors_json, []);
  if (!contributors.includes(actor.name)) contributors.push(actor.name);
  let results;
  try {
    results = await env.TEAM_DB.batch([
      env.TEAM_DB.prepare(`UPDATE inventory_counts SET status = 'submitted', count_date = ?, date_reason = ?,
          contributors_json = ?, submitted_by = ?, submitted_at = ?, submit_token = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'draft'`)
        .bind(countDate, dateReason || null, JSON.stringify(contributors), actor.id, now, token, now, row.id),
      // Guarded by the token: if a double-tap already submitted this draft,
      // the UPDATE above matched nothing and no duplicate rows are written.
      env.TEAM_DB.prepare(`INSERT INTO form_entries
          (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json, submission_id, catalog_id)
        SELECT json_extract(value, '$.id'), 'inventory', ?, ?, ?, ?, json_extract(value, '$.product'),
          json_extract(value, '$.details'), ?, json_extract(value, '$.catalogId')
        FROM json_each(?)
        WHERE EXISTS (SELECT 1 FROM inventory_counts WHERE id = ? AND submit_token = ?)`)
        .bind(now, actor.id, actor.name, countDate, row.id, JSON.stringify(rows), row.id, token)
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new ApiError('count_exists_for_date', 409, { countDate });
    throw error;
  }
  if (!Number(results[0].meta?.changes)) throw new ApiError('already_submitted', 409);
  await audit(env.TEAM_DB, actor.id, 'inventory.submit', 'inventory_count', row.id,
    { countDate, items: rows.length, contributors, confirmedOutliers: Array.from(confirmed) });
  return { ok: true, submissionId: row.id, itemCount: rows.length, countDate };
}

export async function discardInventoryDraft(request, payload, env) {
  const actor = await requireRole(request, payload, env);
  const row = await openDraft(env);
  if (!row || row.id !== String(payload.draftId || '')) throw new ApiError('draft_not_found', 404);
  if (row.started_by !== actor.id && !hasRole(actor, 'lead')) throw new ApiError('forbidden', 403);
  await env.TEAM_DB.prepare("DELETE FROM inventory_counts WHERE id = ? AND status = 'draft'").bind(row.id).run();
  await audit(env.TEAM_DB, actor.id, 'inventory.draft_discard', 'inventory_count', row.id,
    { countedItems: Object.keys(safeJsonParse(row.draft_json, {}).items || {}).length });
  return { ok: true };
}

// --- Count sections (Management) -------------------------------------------

export async function getInventorySections(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const { results } = await env.TEAM_DB.prepare(`SELECT s.*, (SELECT COUNT(*) FROM catalog c
      WHERE c.section_id = s.id AND c.form_type = 'inventory' AND c.status != 'discontinued') AS item_count
    FROM inventory_sections s ORDER BY s.status, s.sort_order, s.name`).all();
  return { ok: true, sections: results.map((row) => ({
    sectionId: row.id, name: row.name, sortOrder: Number(row.sort_order || 0), status: row.status,
    itemCount: Number(row.item_count || 0)
  })) };
}

export async function saveInventorySection(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'management');
  const input = payload.section || {};
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw new ApiError('missing_name', 400);
  const status = input.status === 'inactive' ? 'inactive' : 'active';
  const sortOrder = Math.round(Number(input.sortOrder) || 0);
  const now = nowIso();
  if (input.sectionId) {
    const result = await env.TEAM_DB.prepare(`UPDATE inventory_sections SET name = ?, sort_order = ?, status = ?, updated_at = ?
      WHERE id = ?`).bind(name, sortOrder, status, now, input.sectionId).run();
    if (!Number(result.meta?.changes)) throw new ApiError('not_found', 404);
    await audit(env.TEAM_DB, actor.id, 'inventory.section_update', 'inventory_section', input.sectionId, { name, sortOrder, status });
    return { ok: true, sectionId: input.sectionId };
  }
  const id = newId('section');
  await env.TEAM_DB.prepare(`INSERT INTO inventory_sections (id, name, sort_order, status, created_at)
    VALUES (?, ?, ?, ?, ?)`).bind(id, name, sortOrder, status, now).run();
  await audit(env.TEAM_DB, actor.id, 'inventory.section_add', 'inventory_section', id, { name, sortOrder });
  return { ok: true, sectionId: id };
}

// Weekly inventory count: outlier check, draft/resume, blank-submission
// blocking, date rules, double-submit protection, audited edits, and
// rename-safe history. Handlers run unmodified against every migration
// via a node:sqlite stand-in for D1 (tests/helpers/d1-sqlite.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import {
  checkCountDate, diffFields, editNeedsReason, isQuarterQuantity, outlierReasons, parseQuantity, previousDate, storeDate
} from '../functions/_lib/inventory-rules.js';
import {
  discardInventoryDraft, getInventoryCount, saveInventoryDraft, submitInventoryCount
} from '../functions/_lib/inventory.js';
import { getEntries, submitForm, updateEntry } from '../functions/_lib/legacy.js';
import { updateItem } from '../functions/_lib/portal-qol.js';
import { buildMigration } from '../scripts/build-inventory-units-migration.mjs';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const TZ = 'America/New_York';
const ITEMS = ['catalog_seed_0001', 'catalog_seed_0039', 'catalog_seed_0049', 'catalog_seed_0064'];

function setup() {
  const db = createTestDatabase(MIGRATIONS);
  // Keep the count to four items so each test can complete it quickly.
  db.raw.prepare(`UPDATE catalog SET status = 'discontinued' WHERE form_type = 'inventory' AND id NOT IN (${ITEMS.map(() => '?').join(',')})`)
    .run(...ITEMS);
  const env = { TEAM_DB: db, STORE_TIMEZONE: TZ };
  return {
    db,
    env,
    barista: addUserWithSession(db, { id: 'usr_barista', username: 'barista', name: 'Bea Barista', role: 'barista' }),
    barista2: addUserWithSession(db, { id: 'usr_barista2', username: 'barista2', name: 'Bo Barista', role: 'barista' }),
    manager: addUserWithSession(db, { id: 'usr_manager', username: 'manager', name: 'Mo Manager', role: 'management' })
  };
}

async function rejects(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return error.details || {};
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

const today = () => storeDate(new Date(), TZ);
const fullChanges = (values = {}) => Object.fromEntries(ITEMS.map((id) => [id, { qtyKitchen: 1, qtyStorage: 2, note: '', ...(values[id] || {}) }]));

// A submitted count from last week, so outlier comparisons have a baseline.
function addPreviousCount(db, totals) {
  const date = previousDate(previousDate(previousDate(today())));
  db.raw.prepare(`INSERT INTO inventory_counts (id, status, count_date, started_at, updated_at, submitted_at)
    VALUES ('submission_prev', 'submitted', ?, ?, ?, ?)`).run(date, `${date}T15:00:00Z`, `${date}T15:00:00Z`, `${date}T15:00:00Z`);
  Object.entries(totals).forEach(([id, [kitchen, storage]], index) => {
    db.raw.prepare(`INSERT INTO form_entries (id, form_type, submitted_at, employee_name, entry_date, product, details_json, submission_id, catalog_id)
      VALUES (?, 'inventory', ?, 'Earlier', ?, ?, ?, 'submission_prev', ?)`)
      .run(`entry_prev_${index}`, `${date}T15:00:00Z`, date, `Old name ${index}`, JSON.stringify({ qtyKitchen: kitchen, qtyStorage: storage }), id);
  });
  return date;
}

// --- Pure rules -------------------------------------------------------------

test('outlier check flags >3x, <1/3, and above-maximum totals only', () => {
  assert.deepEqual(outlierReasons(116, 25), ['over_3x'], 'Pistachio Sauce 116 after ~20');
  assert.deepEqual(outlierReasons(73, 9), ['over_3x'], 'Vanilla Syrup 73 after ~7');
  assert.deepEqual(outlierReasons(4, 30), ['under_third'], 'Mango Pulp 30 → 4 unit flip');
  assert.deepEqual(outlierReasons(0, 20), ['under_third'], 'a skipped section reads as a drop to 0');
  assert.deepEqual(outlierReasons(30, 10), [], 'exactly 3x is allowed');
  assert.deepEqual(outlierReasons(10, 30), [], 'exactly 1/3 is allowed');
  assert.deepEqual(outlierReasons(50, 0), [], 'no ratio check without a non-zero previous count');
  assert.deepEqual(outlierReasons(50, null), [], 'no ratio check for a first count');
  assert.deepEqual(outlierReasons(25, 20, 24), ['above_max']);
  assert.deepEqual(outlierReasons(100, 20, 24), ['above_max', 'over_3x']);
});

test('quantities accept whole numbers plus quarters, and blank stays blank', () => {
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity(null), null);
  assert.equal(parseQuantity(4.75), 4.75);
  assert.equal(parseQuantity('2.5'), 2.5);
  assert.equal(parseQuantity(0), 0);
  assert.ok(Number.isNaN(parseQuantity(0.3)), 'free-typed 0.3 is rejected');
  assert.ok(Number.isNaN(parseQuantity(4.2)));
  assert.ok(Number.isNaN(parseQuantity(-1)));
  assert.equal(isQuarterQuantity(0.75), true);
});

test('count date allows today, or yesterday with a reason', () => {
  const now = new Date('2026-10-21T17:00:00Z');
  assert.equal(checkCountDate('2026-10-21', '', now, TZ).ok, true);
  assert.equal(checkCountDate('2026-10-20', '', now, TZ).error, 'date_reason_required');
  assert.equal(checkCountDate('2026-10-20', 'Finished after midnight', now, TZ).ok, true);
  assert.equal(checkCountDate('2026-10-15', 'Backdating', now, TZ).error, 'count_date_not_allowed');
  // 11:30 PM Eastern is still the 21st even though UTC has rolled over.
  assert.equal(checkCountDate('2026-10-21', '', new Date('2026-10-22T03:30:00Z'), TZ).ok, true);
});

test('edits more than an hour after submission need a reason; diffs list each changed field', () => {
  assert.equal(editNeedsReason('2026-10-21T13:00:00Z', '2026-10-21T13:59:00Z'), false);
  assert.equal(editNeedsReason('2026-10-21T13:00:00Z', '2026-10-22T16:13:00Z'), true);
  assert.deepEqual(diffFields({ qtyStorage: 70, notes: '' }, { qtyStorage: 7, notes: '' }), [{ field: 'qtyStorage', oldValue: '70', newValue: '7' }]);
});

// --- Draft / resume ---------------------------------------------------------

test('a count can be saved as a draft, resumed by someone else, and shows progress', async () => {
  const { env, barista, barista2 } = setup();
  const empty = await getInventoryCount(barista, {}, env);
  assert.equal(empty.draft, null);
  assert.equal(empty.sections.flatMap((s) => s.items).length, 4);

  const first = await saveInventoryDraft(barista, {
    countDate: today(), changes: { catalog_seed_0001: { qtyKitchen: 1, qtyStorage: 0 }, catalog_seed_0039: { qtyKitchen: 2.5, qtyStorage: null } }
  }, env);
  assert.ok(first.draft.draftId);

  // A second person on another device picks up the same draft.
  const resumed = await getInventoryCount(barista2, {}, env);
  assert.equal(resumed.draft.draftId, first.draft.draftId);
  assert.equal(resumed.draft.items.catalog_seed_0039.qtyKitchen, 2.5);
  assert.equal(resumed.draft.items.catalog_seed_0039.qtyStorage, null, 'half-counted items stay incomplete');

  const second = await saveInventoryDraft(barista2, {
    draftId: first.draft.draftId, countDate: today(), changes: { catalog_seed_0049: { qtyKitchen: 0, qtyStorage: 7 } }
  }, env);
  const items = second.draft.items;
  assert.equal(Object.keys(items).length, 3, 'changes from both people are merged, not overwritten');
  const complete = Object.values(items).filter((entry) => entry.qtyKitchen !== null && entry.qtyStorage !== null).length;
  assert.equal(complete, 2, 'progress: 2 of 4 items counted');
  assert.deepEqual(second.draft.contributors, ['Bea Barista', 'Bo Barista']);
});

test('only one draft exists at a time and a discarded draft cannot be saved to', async () => {
  const { env, barista, barista2, manager } = setup();
  const a = await saveInventoryDraft(barista, { countDate: today(), changes: {} }, env);
  const b = await saveInventoryDraft(barista2, { countDate: today(), changes: { catalog_seed_0001: { qtyKitchen: 1, qtyStorage: 1 } } }, env);
  assert.equal(a.draft.draftId, b.draft.draftId, 'a second person joins the open draft instead of starting another');

  await rejects(discardInventoryDraft(barista2, { draftId: a.draft.draftId }, env), 'forbidden');
  await discardInventoryDraft(manager, { draftId: a.draft.draftId }, env);
  const details = await rejects(saveInventoryDraft(barista, { draftId: a.draft.draftId, countDate: today(), changes: {} }, env), 'draft_closed');
  assert.equal(details.draft, null);
});

test('draft saves reject free-typed decimals and dates other than today or yesterday', async () => {
  const { env, barista } = setup();
  await rejects(saveInventoryDraft(barista, { countDate: today(), changes: { catalog_seed_0001: { qtyKitchen: 0.3, qtyStorage: 0 } } }, env), 'invalid_quantity');
  await rejects(saveInventoryDraft(barista, { countDate: '2026-01-01', changes: {} }, env), 'count_date_not_allowed');
});

// --- Blank-submission blocking ---------------------------------------------

test('an incomplete or blank count cannot be submitted', async () => {
  const { env, barista } = setup();
  const blank = await saveInventoryDraft(barista, { countDate: today(), changes: {} }, env);
  const none = await rejects(submitInventoryCount(barista, { draftId: blank.draft.draftId }, env), 'incomplete');
  assert.equal(none.missingCount, 4, 'nothing entered → every item is missing');

  await saveInventoryDraft(barista, {
    draftId: blank.draft.draftId, countDate: today(),
    changes: { ...fullChanges(), catalog_seed_0064: { qtyKitchen: 3, qtyStorage: null } }
  }, env);
  const partial = await rejects(submitInventoryCount(barista, { draftId: blank.draft.draftId }, env), 'incomplete');
  assert.deepEqual(partial.missing.map((item) => item.catalogId), ['catalog_seed_0064']);
});

test('explicit zeros count as checked and allow submission', async () => {
  const { env, db, barista } = setup();
  const zeros = Object.fromEntries(ITEMS.map((id) => [id, { qtyKitchen: 0, qtyStorage: 0 }]));
  const draft = await saveInventoryDraft(barista, { countDate: today(), changes: zeros }, env);
  const result = await submitInventoryCount(barista, { draftId: draft.draft.draftId }, env);
  assert.equal(result.itemCount, 4);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM form_entries WHERE submission_id = ?").get(result.submissionId).n, 4);
});

test('the legacy one-shot submit path is closed for inventory, and dessert blanks are rejected', async () => {
  const { env, barista } = setup();
  await rejects(submitForm(barista, { formType: 'inventory', items: [{ product: 'Dark Roast', qtyKitchen: 0, qtyStorage: 0 }] }, env), 'use_inventory_count');
  await rejects(submitForm(barista, {
    formType: 'dessert-daily', date: today(),
    items: [{ product: 'Honeycomb', countOnHand: 3, deliveryReceived: 0 }, { product: 'Sabaya', countOnHand: null, deliveryReceived: 0 }]
  }, env), 'incomplete');
  const ok = await submitForm(barista, { formType: 'dessert-daily', date: today(), items: [{ product: 'Honeycomb', countOnHand: 0, deliveryReceived: 0 }] }, env);
  assert.equal(ok.ok, true);
});

test('a double-tapped submit writes the count once', async () => {
  const { env, db, barista } = setup();
  const draft = await saveInventoryDraft(barista, { countDate: today(), changes: fullChanges() }, env);
  const results = await Promise.allSettled([
    submitInventoryCount(barista, { draftId: draft.draft.draftId }, env),
    submitInventoryCount(barista, { draftId: draft.draft.draftId }, env)
  ]);
  // Either tap may win; exactly one succeeds and the other is turned away.
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'already_submitted');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM form_entries WHERE form_type = 'inventory'").get().n, 4);
});

test('a second count for the same date is rejected; yesterday needs a reason', async () => {
  const { env, barista } = setup();
  const one = await saveInventoryDraft(barista, { countDate: today(), changes: fullChanges() }, env);
  await submitInventoryCount(barista, { draftId: one.draft.draftId }, env);
  const two = await saveInventoryDraft(barista, { countDate: today(), changes: fullChanges() }, env);
  await rejects(submitInventoryCount(barista, { draftId: two.draft.draftId }, env), 'count_exists_for_date');

  const yesterday = previousDate(today());
  await rejects(submitInventoryCount(barista, { draftId: two.draft.draftId, countDate: yesterday }, env), 'date_reason_required');
  const ok = await submitInventoryCount(barista, { draftId: two.draft.draftId, countDate: yesterday, dateReason: 'Count finished after midnight' }, env);
  assert.equal(ok.countDate, yesterday);
});

// --- Outlier confirmation on submit ----------------------------------------

test('outliers against the previous count must be confirmed before submitting', async () => {
  const { env, db, barista } = setup();
  addPreviousCount(db, { catalog_seed_0039: [5, 20], catalog_seed_0049: [2, 7], catalog_seed_0001: [3, 3], catalog_seed_0064: [1, 1] });
  db.raw.prepare("UPDATE catalog SET max_qty = 10 WHERE id = 'catalog_seed_0064'").run();

  const draft = await saveInventoryDraft(barista, {
    countDate: today(),
    changes: fullChanges({
      catalog_seed_0039: { qtyKitchen: 44, qtyStorage: 72 }, // 116 vs 25
      catalog_seed_0049: { qtyKitchen: 3, qtyStorage: 70 }, // 73 vs 9
      catalog_seed_0001: { qtyKitchen: 3, qtyStorage: 2 }, // 5 vs 6 — fine
      catalog_seed_0064: { qtyKitchen: 11, qtyStorage: 0 } // above max 10
    })
  }, env);

  const details = await rejects(submitInventoryCount(barista, { draftId: draft.draft.draftId }, env), 'outliers_need_confirmation');
  const flagged = Object.fromEntries(details.outliers.map((item) => [item.catalogId, item.reasons]));
  assert.deepEqual(flagged, {
    catalog_seed_0039: ['over_3x'],
    catalog_seed_0049: ['over_3x'],
    catalog_seed_0064: ['above_max', 'over_3x']
  });
  assert.equal(details.outliers.find((item) => item.catalogId === 'catalog_seed_0039').previousTotal, 25);

  const partly = await rejects(submitInventoryCount(barista, {
    draftId: draft.draft.draftId, confirmedOutliers: ['catalog_seed_0039', 'catalog_seed_0049']
  }, env), 'outliers_need_confirmation');
  assert.deepEqual(partly.outliers.map((item) => item.catalogId), ['catalog_seed_0064']);

  const result = await submitInventoryCount(barista, {
    draftId: draft.draft.draftId, confirmedOutliers: ['catalog_seed_0039', 'catalog_seed_0049', 'catalog_seed_0064']
  }, env);
  const saved = JSON.parse(db.raw.prepare("SELECT details_json FROM form_entries WHERE submission_id = ? AND catalog_id = 'catalog_seed_0039'")
    .get(result.submissionId).details_json);
  assert.equal(saved.outlierConfirmed, true);
  assert.deepEqual(saved.outlierReasons, ['over_3x']);
});

// --- Audit trail and renames -----------------------------------------------

test('every edit logs old and new values; late edits need a reason and show in getEntries', async () => {
  const { env, db, barista, manager } = setup();
  const draft = await saveInventoryDraft(barista, { countDate: today(), changes: fullChanges() }, env);
  const { submissionId } = await submitInventoryCount(barista, { draftId: draft.draft.draftId }, env);
  const entry = db.raw.prepare("SELECT * FROM form_entries WHERE submission_id = ? AND catalog_id = 'catalog_seed_0049'").get(submissionId);
  const details = JSON.parse(entry.details_json);

  await updateEntry(manager, { formType: 'inventory', entryId: entry.id, changes: { details: JSON.stringify({ ...details, qtyStorage: 7 }) } }, env);

  // Pretend the count was submitted yesterday.
  db.raw.prepare("UPDATE form_entries SET submitted_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(entry.id);
  await rejects(updateEntry(manager, { formType: 'inventory', entryId: entry.id, changes: { details: JSON.stringify({ ...details, qtyStorage: 6 }) } }, env), 'edit_reason_required');
  await updateEntry(manager, {
    formType: 'inventory', entryId: entry.id, reason: 'Recount after delivery', changes: { details: JSON.stringify({ ...details, qtyStorage: 6 }) }
  }, env);

  const { entries } = await getEntries(manager, { formType: 'inventory' }, env);
  const edited = entries.find((row) => row.entryId === entry.id);
  assert.deepEqual(edited.edits.map((edit) => [edit.field, edit.oldValue, edit.newValue, edit.reason]), [
    ['qtyStorage', '2', '7', ''],
    ['qtyStorage', '7', '6', 'Recount after delivery']
  ]);
  assert.equal(edited.edits[0].editedBy, 'Mo Manager');
});

test('void counts are left out of the submissions list and export', async () => {
  const { env, db, barista, manager } = setup();
  const draft = await saveInventoryDraft(barista, { countDate: today(), changes: fullChanges() }, env);
  const { submissionId } = await submitInventoryCount(barista, { draftId: draft.draft.draftId }, env);
  db.raw.prepare("UPDATE inventory_counts SET status = 'void' WHERE id = ?").run(submissionId);
  const { entries } = await getEntries(manager, { formType: 'inventory' }, env);
  assert.equal(entries.length, 0);
});

test('renaming an item keeps its history and its previous count', async () => {
  const { env, db, barista, manager } = setup();
  addPreviousCount(db, { catalog_seed_0039: [5, 20] });
  await updateItem(manager, { catalogId: 'catalog_seed_0039', changes: { name: 'Pistachio Sauce (950 g bottle)', unit: '950 g bottles' } }, env);
  const count = await getInventoryCount(barista, {}, env);
  const item = count.sections.flatMap((section) => section.items).find((row) => row.catalogId === 'catalog_seed_0039');
  assert.equal(item.name, 'Pistachio Sauce (950 g bottle)');
  assert.equal(item.unit, '950 g bottles');
  assert.equal(item.previous.total, 25, 'last week was recorded under the old name but follows the permanent ID');
  await rejects(updateItem(manager, { catalogId: 'catalog_seed_0039', changes: { unit: '' } }, env), 'missing_unit');
});

test('the units worksheet becomes a migration that sets units, maximums, and walk-order sections', async () => {
  const { db, env, barista } = setup();
  const csv = [
    '"catalog_id","current_group","current_location","name","current_unit","recent_totals","flag","count_unit (FILL IN)","max_qty (FILL IN)","section (FILL IN)","walk_order (FILL IN)","suggested_max"',
    '"catalog_seed_0039","Sauce / Syrup","Storage","Pistachio Sauce","Box","25 19 116","","950 g bottles","30","Under-bar fridge","5","60"',
    '"catalog_seed_0049","Sauce / Syrup","Storage","Vanilla Syrup","Bottle","7 73 9","","750 mL bottles","","Under-bar fridge","6",""',
    '"catalog_seed_0001","Coffee Beans","Kitchen","Dark Roast","lb","5 5","","5 lb bags","","Back storage, left shelf","1",""',
    '"catalog_seed_0064","Warehouse","Storage","Hot Lids","Box 1000","","","","","Back storage, left shelf","2",""'
  ].join('\n');
  db.raw.exec(buildMigration(csv));

  const count = await getInventoryCount(barista, {}, env);
  assert.deepEqual(count.sections.map((section) => section.name), ['Back storage, left shelf', 'Under-bar fridge'], 'walk order: lowest walk_order first');
  const items = Object.fromEntries(count.sections.flatMap((section) => section.items).map((item) => [item.catalogId, item]));
  assert.equal(items.catalog_seed_0039.unit, '950 g bottles');
  assert.equal(items.catalog_seed_0039.maxQty, 30);
  assert.equal(items.catalog_seed_0064.unit, 'Box 1000', 'a blank count_unit leaves the current unit');
  assert.deepEqual(count.sections[0].items.map((item) => item.catalogId), ['catalog_seed_0001', 'catalog_seed_0064']);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM inventory_sections WHERE status = 'active'").get().n, 2, 'emptied interim sections are retired');
  assert.throws(() => buildMigration(csv.replace('"30"', '"lots"')), /max_qty "lots"/);
});

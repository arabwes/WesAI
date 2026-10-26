PRAGMA foreign_keys = ON;

-- Weekly inventory data-integrity overhaul. Approved plan (Oct 2026):
--   * permanent item IDs on submitted rows (renames no longer split history)
--   * walk-order count sections and per-item maximums
--   * one shared server-side draft per count, submitted exactly once
--   * an old/new value audit trail for every edit
--   * cleanup of the 10/13 blank duplicate and the split 10/21 count
-- The existing catalog.unit column is the required count unit and the
-- existing 'discontinued' status is the "inactive" flag, so neither needs a
-- new column.

-- 1. Walk-order sections ----------------------------------------------------
CREATE TABLE inventory_sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

ALTER TABLE catalog ADD COLUMN max_qty REAL;
ALTER TABLE catalog ADD COLUMN section_id TEXT REFERENCES inventory_sections(id);
ALTER TABLE catalog ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Interim sections mirror the current groups, in their existing order, so
-- the page keeps working until real walk-order sections are assigned from
-- docs/inventory-cleanup/inventory-units-worksheet.csv.
INSERT INTO inventory_sections (id, name, sort_order, status, created_at)
SELECT 'section-' || printf('%02d', ROW_NUMBER() OVER (ORDER BY MIN(created_at), group_name)),
  group_name,
  ROW_NUMBER() OVER (ORDER BY MIN(created_at), group_name) * 10,
  'active',
  '2026-10-26T00:00:00.000Z'
FROM catalog
WHERE form_type = 'inventory'
GROUP BY group_name;

UPDATE catalog
SET section_id = (SELECT s.id FROM inventory_sections s WHERE s.name = catalog.group_name),
  sort_order = 10 * (
    SELECT COUNT(*) FROM catalog c2
    WHERE c2.form_type = 'inventory' AND c2.group_name = catalog.group_name
      AND (c2.created_at < catalog.created_at OR (c2.created_at = catalog.created_at AND c2.id <= catalog.id))
  )
WHERE form_type = 'inventory';

CREATE INDEX idx_catalog_section_order ON catalog (form_type, section_id, sort_order);

-- 2. Permanent item IDs on submitted rows ----------------------------------
ALTER TABLE form_entries ADD COLUMN catalog_id TEXT;

UPDATE form_entries
SET catalog_id = (
  SELECT c.id FROM catalog c
  WHERE c.form_type = 'inventory' AND c.name = form_entries.product COLLATE NOCASE
  ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'flagged' THEN 1 ELSE 2 END, c.created_at
  LIMIT 1
)
WHERE form_type = 'inventory';

-- Items renamed in place after they were counted. The catalog row kept its
-- ID; only the submitted rows still carry the old name. Merged per owner
-- approval, including the four that changed more than wording.
UPDATE form_entries SET catalog_id = CASE product
    WHEN 'Matcha' THEN 'catalog_seed_0006'
    WHEN '1883 Blackberry' THEN 'catalog_seed_0022'
    WHEN '1883 Blueberry' THEN 'catalog_seed_0023'
    WHEN 'Brown Sugar Sauce' THEN 'catalog_seed_0024'
    WHEN 'Hazelnut' THEN 'catalog_seed_0033'
    WHEN '16oz Non-Branded Hot Cup' THEN 'catalog_seed_0059'
    WHEN '16oz Non-Branded Paper Cup' THEN 'catalog_seed_0060'
    WHEN '16oz & 20oz Poly Cup' THEN 'catalog_seed_0062'
    WHEN '12–20oz Paper Cup Hot Lids' THEN 'catalog_seed_0064'
    WHEN 'Almudhesh Evaporated Milk' THEN 'catalog_seed_0106'
    WHEN '50g Dragon Fruit Diced' THEN 'catalog_seed_0116'
    WHEN 'Hoodies' THEN 'catalog_seed_0124'
  END
WHERE form_type = 'inventory' AND catalog_id IS NULL AND product IN (
  'Matcha', '1883 Blackberry', '1883 Blueberry', 'Brown Sugar Sauce', 'Hazelnut',
  '16oz Non-Branded Hot Cup', '16oz Non-Branded Paper Cup', '16oz & 20oz Poly Cup',
  '12–20oz Paper Cup Hot Lids', 'Almudhesh Evaporated Milk', '50g Dragon Fruit Diced', 'Hoodies'
);

CREATE INDEX idx_form_entries_catalog_date ON form_entries (catalog_id, entry_date);

-- 3. Edit audit trail -------------------------------------------------------
CREATE TABLE form_entry_edits (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES form_entries(id),
  submission_id TEXT,
  form_type TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT,
  edited_by_name TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  reason TEXT
);

CREATE INDEX idx_form_entry_edits_entry ON form_entry_edits (entry_id, edited_at);
CREATE INDEX idx_form_entry_edits_submission ON form_entry_edits (submission_id, edited_at);

-- 4. One row per count: shared draft, then submitted exactly once ---------
CREATE TABLE inventory_counts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'void')),
  count_date TEXT NOT NULL,
  date_reason TEXT,
  draft_json TEXT NOT NULL DEFAULT '{}',
  contributors_json TEXT NOT NULL DEFAULT '[]',
  started_by TEXT,
  started_by_name TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at TEXT,
  submit_token TEXT,
  void_reason TEXT,
  voided_by TEXT,
  voided_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO inventory_counts
  (id, status, count_date, contributors_json, started_by, started_by_name, started_at, updated_at, submitted_by, submitted_at)
SELECT submission_id, 'submitted', MIN(entry_date), json_array(MIN(employee_name)), MIN(employee_id), MIN(employee_name),
  MIN(submitted_at), MAX(COALESCE(last_edited_at, submitted_at)), MIN(employee_id), MIN(submitted_at)
FROM form_entries
WHERE form_type = 'inventory' AND submission_id IS NOT NULL
GROUP BY submission_id;

-- 5. Historical cleanup -----------------------------------------------------
-- 10/13: every item was 0, submitted 7 seconds before the real count.
UPDATE inventory_counts
SET status = 'void', voided_by = 'system-migration', voided_at = '2026-10-26T00:00:00.000Z',
  void_reason = 'Blank duplicate: all items 0, submitted 7 seconds before the real 10/13 count (6fa3ff3c).'
WHERE id LIKE 'submission_f9d31be0%';

-- 10/21: one count entered as two partial submissions 29 minutes apart, the
-- first mis-dated 10/15. Copy the items only the first part counted onto the
-- second part (logged as edits), then re-date and void the first part.
INSERT INTO form_entry_edits (id, entry_id, submission_id, form_type, field, old_value, new_value, edited_by, edited_by_name, edited_at, reason)
SELECT 'edit_merge_k_' || b.id, b.id, b.submission_id, 'inventory', 'qtyKitchen',
  CAST(COALESCE(json_extract(b.details_json, '$.qtyKitchen'), 0) AS TEXT),
  CAST(COALESCE(json_extract(a.details_json, '$.qtyKitchen'), 0) AS TEXT),
  NULL, 'System migration', '2026-10-26T00:00:00.000Z',
  'Merged from split submission e595d598 (same 10/21 count, mis-dated 10/15)'
FROM form_entries b
JOIN form_entries a ON a.catalog_id = b.catalog_id AND a.form_type = 'inventory' AND a.submission_id LIKE 'submission_e595d598%'
WHERE b.form_type = 'inventory' AND b.submission_id LIKE 'submission_dd769915%'
  AND COALESCE(json_extract(b.details_json, '$.qtyKitchen'), 0) + COALESCE(json_extract(b.details_json, '$.qtyStorage'), 0) = 0
  AND COALESCE(json_extract(a.details_json, '$.qtyKitchen'), 0) + COALESCE(json_extract(a.details_json, '$.qtyStorage'), 0) > 0
  AND COALESCE(json_extract(a.details_json, '$.qtyKitchen'), 0) != 0;

INSERT INTO form_entry_edits (id, entry_id, submission_id, form_type, field, old_value, new_value, edited_by, edited_by_name, edited_at, reason)
SELECT 'edit_merge_s_' || b.id, b.id, b.submission_id, 'inventory', 'qtyStorage',
  CAST(COALESCE(json_extract(b.details_json, '$.qtyStorage'), 0) AS TEXT),
  CAST(COALESCE(json_extract(a.details_json, '$.qtyStorage'), 0) AS TEXT),
  NULL, 'System migration', '2026-10-26T00:00:00.000Z',
  'Merged from split submission e595d598 (same 10/21 count, mis-dated 10/15)'
FROM form_entries b
JOIN form_entries a ON a.catalog_id = b.catalog_id AND a.form_type = 'inventory' AND a.submission_id LIKE 'submission_e595d598%'
WHERE b.form_type = 'inventory' AND b.submission_id LIKE 'submission_dd769915%'
  AND COALESCE(json_extract(b.details_json, '$.qtyKitchen'), 0) + COALESCE(json_extract(b.details_json, '$.qtyStorage'), 0) = 0
  AND COALESCE(json_extract(a.details_json, '$.qtyKitchen'), 0) + COALESCE(json_extract(a.details_json, '$.qtyStorage'), 0) > 0
  AND COALESCE(json_extract(a.details_json, '$.qtyStorage'), 0) != 0;

UPDATE form_entries
SET details_json = (
    SELECT json_set(form_entries.details_json,
      '$.qtyKitchen', COALESCE(json_extract(a.details_json, '$.qtyKitchen'), 0),
      '$.qtyStorage', COALESCE(json_extract(a.details_json, '$.qtyStorage'), 0))
    FROM form_entries a
    WHERE a.catalog_id = form_entries.catalog_id AND a.form_type = 'inventory' AND a.submission_id LIKE 'submission_e595d598%'
  ),
  last_edited_by = 'System migration',
  last_edited_at = '2026-10-26T00:00:00.000Z'
WHERE form_type = 'inventory' AND submission_id LIKE 'submission_dd769915%'
  AND id IN (SELECT entry_id FROM form_entry_edits WHERE id LIKE 'edit_merge_%');

UPDATE form_entries SET entry_date = '2026-10-21'
WHERE form_type = 'inventory' AND submission_id LIKE 'submission_e595d598%';

UPDATE inventory_counts
SET count_date = '2026-10-21', status = 'void', voided_by = 'system-migration', voided_at = '2026-10-26T00:00:00.000Z',
  void_reason = 'First half of the split 10/21 count (was mis-dated 10/15); its counted items were merged into dd769915.'
WHERE id LIKE 'submission_e595d598%';

-- 6. Integrity rules the database enforces ---------------------------------
-- At most one open draft for the whole store, and one submitted count per date.
CREATE UNIQUE INDEX idx_inventory_counts_one_draft ON inventory_counts (status) WHERE status = 'draft';
CREATE UNIQUE INDEX idx_inventory_counts_one_per_date ON inventory_counts (count_date) WHERE status = 'submitted';
CREATE INDEX idx_inventory_counts_date ON inventory_counts (count_date, status);

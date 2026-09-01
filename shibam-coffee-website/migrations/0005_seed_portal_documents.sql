-- Restore the two document entries that existed before documents became
-- database-managed. Existing documents are preserved and matching titles
-- are not duplicated.

INSERT INTO portal_documents
  (id, title, description, category, drive_file_id, status, added_by, created_at, updated_by, updated_at)
SELECT
  'document_seed_employee_handbook',
  'Employee Handbook',
  'Company policies, conduct, and general employment info.',
  'Handbook',
  '',
  'active',
  'system-seed',
  '2026-09-01T00:00:00.001Z',
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM portal_documents WHERE title = 'Employee Handbook' COLLATE NOCASE
);

INSERT INTO portal_documents
  (id, title, description, category, drive_file_id, status, added_by, created_at, updated_by, updated_at)
SELECT
  'document_seed_guidelines',
  'Guidelines',
  'Other operating guidelines.',
  'Other Guidelines',
  '',
  'active',
  'system-seed',
  '2026-09-01T00:00:00.002Z',
  NULL,
  NULL
WHERE NOT EXISTS (
  SELECT 1 FROM portal_documents WHERE title = 'Guidelines' COLLATE NOCASE
);

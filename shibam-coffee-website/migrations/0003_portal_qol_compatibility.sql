ALTER TABLE form_entries ADD COLUMN submission_id TEXT;

CREATE INDEX idx_form_entries_submission ON form_entries (submission_id);
CREATE INDEX idx_form_entries_employee_submitted ON form_entries (employee_id, submitted_at DESC);

CREATE TABLE portal_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  drive_file_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discontinued')),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);

CREATE INDEX idx_portal_documents_status_created ON portal_documents (status, created_at);

PRAGMA foreign_keys = ON;

-- Add a staged workflow to corrective-action records. Existing records were
-- created by the earlier one-step form, so they remain completed by default.
ALTER TABLE employee_write_ups ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'completed'
  CHECK (workflow_status IN ('draft', 'sent', 'completed'));
ALTER TABLE employee_write_ups ADD COLUMN sent_at TEXT;
ALTER TABLE employee_write_ups ADD COLUMN employee_completed_at TEXT;
ALTER TABLE employee_write_ups ADD COLUMN updated_at TEXT;
ALTER TABLE employee_write_ups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_employee_write_ups_recipient_status
ON employee_write_ups (employee_id, workflow_status, sent_at DESC);

CREATE INDEX idx_employee_write_ups_creator_status
ON employee_write_ups (created_by, workflow_status, updated_at DESC);

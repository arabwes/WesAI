PRAGMA foreign_keys = ON;

-- Confidential employee corrective-action records. Names and positions are
-- snapshotted so a submitted record remains historically accurate if a user
-- later changes roles, positions, or display name.
CREATE TABLE employee_write_ups (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  employee_name TEXT NOT NULL,
  employee_position TEXT NOT NULL DEFAULT '',
  write_up_date TEXT NOT NULL,
  supervisor_user_id TEXT NOT NULL REFERENCES users(id),
  supervisor_name TEXT NOT NULL,
  warning_level TEXT NOT NULL CHECK (warning_level IN ('verbal', 'strike_1', 'strike_2', 'strike_3')),
  infractions_json TEXT NOT NULL DEFAULT '[]',
  other_infraction TEXT NOT NULL DEFAULT '',
  incident_description TEXT NOT NULL,
  corrective_action_plan TEXT NOT NULL,
  follow_up_review_date TEXT,
  employee_comments TEXT NOT NULL DEFAULT '',
  employee_signature TEXT,
  employee_signature_date TEXT,
  employee_declined_to_sign INTEGER NOT NULL DEFAULT 0 CHECK (employee_declined_to_sign IN (0, 1)),
  manager_signature TEXT NOT NULL,
  manager_signature_date TEXT NOT NULL,
  witness_name TEXT,
  witness_date TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_employee_write_ups_employee_date
ON employee_write_ups (employee_id, write_up_date DESC, created_at DESC);

CREATE INDEX idx_employee_write_ups_creator_date
ON employee_write_ups (created_by, created_at DESC);

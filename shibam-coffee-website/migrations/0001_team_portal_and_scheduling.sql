PRAGMA foreign_keys = ON;

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

INSERT INTO locations (id, name, timezone, created_at)
VALUES ('atlanta', 'Shibam Coffee Atlanta', 'America/New_York', CURRENT_TIMESTAMP);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('barista', 'lead', 'management')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_algorithm TEXT NOT NULL DEFAULT 'pbkdf2-sha256',
  max_weekly_minutes INTEGER NOT NULL DEFAULT 2400 CHECK (max_weekly_minutes >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_users_active_role ON users (active, role);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip_hash TEXT
);

CREATE INDEX idx_sessions_user_expiry ON sessions (user_id, expires_at);

CREATE TABLE login_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT NOT NULL DEFAULT '#A56A24',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

INSERT INTO positions (id, name, color, created_at) VALUES
  ('position-barista', 'Barista', '#A56A24', CURRENT_TIMESTAMP),
  ('position-lead', 'Shift Lead', '#6F4E37', CURRENT_TIMESTAMP),
  ('position-management', 'Management', '#1F5D42', CURRENT_TIMESTAMP);

CREATE TABLE employee_positions (
  user_id TEXT NOT NULL REFERENCES users(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  PRIMARY KEY (user_id, position_id)
);

CREATE TABLE catalog (
  id TEXT PRIMARY KEY,
  form_type TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  threshold TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'flagged', 'discontinued')),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_catalog_form_status ON catalog (form_type, status, created_at);

CREATE TABLE form_entries (
  id TEXT PRIMARY KEY,
  form_type TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  employee_id TEXT REFERENCES users(id),
  employee_name TEXT NOT NULL,
  entry_date TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL,
  details_json TEXT NOT NULL,
  last_edited_by TEXT,
  last_edited_at TEXT
);

CREATE INDEX idx_form_entries_type_submitted ON form_entries (form_type, submitted_at DESC);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  week_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  version INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  published_by TEXT REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (location_id, week_start)
);

CREATE INDEX idx_schedules_location_week ON schedules (location_id, week_start);

CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  employee_id TEXT REFERENCES users(id),
  position_id TEXT REFERENCES positions(id),
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  override_reason TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_shifts_schedule_date ON shifts (schedule_id, shift_date, start_time);
CREATE INDEX idx_shifts_employee_date ON shifts (employee_id, shift_date, start_time);
CREATE INDEX idx_shifts_open ON shifts (schedule_id, employee_id, status);

CREATE TABLE availability_rules (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  preference TEXT NOT NULL CHECK (preference IN ('preferred', 'unavailable')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_availability_employee_weekday ON availability_rules (employee_id, weekday);

CREATE TABLE availability_exceptions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  exception_date TEXT NOT NULL,
  preference TEXT NOT NULL CHECK (preference IN ('preferred', 'unavailable')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_availability_exception_employee_date ON availability_exceptions (employee_id, exception_date);

CREATE TABLE time_off_requests (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  request_type TEXT NOT NULL DEFAULT 'unpaid' CHECK (request_type IN ('unpaid', 'pto', 'sick', 'other')),
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_time_off_status_dates ON time_off_requests (status, start_date, end_date);
CREATE INDEX idx_time_off_employee ON time_off_requests (employee_id, submitted_at DESC);

CREATE TABLE shift_requests (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  employee_id TEXT NOT NULL REFERENCES users(id),
  request_type TEXT NOT NULL DEFAULT 'open_pickup' CHECK (request_type IN ('open_pickup')),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX idx_shift_request_one_pending
ON shift_requests (shift_id, employee_id)
WHERE status = 'pending';

CREATE INDEX idx_shift_requests_status ON shift_requests (status, submitted_at);

CREATE TABLE shift_confirmations (
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  employee_id TEXT NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (shift_id, employee_id)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  read_at TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'queued', 'sent', 'failed', 'skipped')),
  email_attempts INTEGER NOT NULL DEFAULT 0,
  email_last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_events (entity_type, entity_id, created_at DESC);

CREATE TABLE app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES
  ('scheduling', '{"weekStartsOn":1,"employeesSeeCoworkers":true,"requireShiftConfirmation":true,"openShiftRequiresApproval":true}', CURRENT_TIMESTAMP);

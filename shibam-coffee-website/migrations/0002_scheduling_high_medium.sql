PRAGMA foreign_keys = ON;

-- Employee profiles and onboarding.
ALTER TABLE users ADD COLUMN preferred_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone_e164 TEXT;
ALTER TABLE users ADD COLUMN phone_verified_at TEXT;

CREATE TABLE user_invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('barista', 'lead', 'management')),
  position_ids_json TEXT NOT NULL DEFAULT '[]',
  max_weekly_minutes INTEGER NOT NULL DEFAULT 2400,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  email_sent_at TEXT,
  email_last_error TEXT,
  accepted_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_user_invitations_email_status ON user_invitations (email, status, created_at DESC);

CREATE TABLE phone_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  phone_e164 TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_phone_verifications_user ON phone_verifications (user_id, created_at DESC);

CREATE TABLE sms_opt_outs (
  phone_e164 TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'STOP',
  opted_out_at TEXT NOT NULL,
  opted_in_at TEXT
);

CREATE TABLE user_notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'push', 'sms')),
  category TEXT NOT NULL CHECK (category IN ('schedule', 'requests', 'open_shifts', 'account')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  quiet_start TEXT,
  quiet_end TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, channel, category)
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device_label TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_push_subscriptions_user_active ON push_subscriptions (user_id, active);

-- Channel-specific notification delivery. Existing email columns remain for
-- backwards compatibility while the Queue Worker transitions to this table.
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'push', 'sms')),
  destination TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (notification_id, channel, destination)
);

CREATE INDEX idx_notification_deliveries_status ON notification_deliveries (status, created_at);

-- Employee shift drops and direct swaps. Assignments are not changed until
-- Management approves a request.
CREATE TABLE shift_exchange_requests (
  id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL CHECK (request_type IN ('drop', 'swap')),
  offered_shift_id TEXT NOT NULL REFERENCES shifts(id),
  offered_shift_version INTEGER NOT NULL,
  requester_id TEXT NOT NULL REFERENCES users(id),
  requested_shift_id TEXT REFERENCES shifts(id),
  requested_shift_version INTEGER,
  target_employee_id TEXT REFERENCES users(id),
  selected_candidate_id TEXT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'employee_accepted', 'approved', 'declined', 'cancelled', 'expired')),
  submitted_at TEXT NOT NULL,
  responded_at TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_shift_exchange_status ON shift_exchange_requests (status, submitted_at);
CREATE INDEX idx_shift_exchange_requester ON shift_exchange_requests (requester_id, submitted_at DESC);
CREATE UNIQUE INDEX idx_shift_exchange_one_active
ON shift_exchange_requests (offered_shift_id)
WHERE status IN ('open', 'employee_accepted');

CREATE TABLE shift_exchange_candidates (
  request_id TEXT NOT NULL REFERENCES shift_exchange_requests(id),
  employee_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'volunteered' CHECK (status IN ('volunteered', 'withdrawn', 'selected', 'declined')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (request_id, employee_id)
);

-- Reusable weekly templates and multi-week rotations.
CREATE TABLE schedule_templates (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  UNIQUE (location_id, name)
);

CREATE TABLE schedule_template_shifts (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES schedule_templates(id),
  day_offset INTEGER NOT NULL CHECK (day_offset BETWEEN 0 AND 6),
  employee_id TEXT REFERENCES users(id),
  position_id TEXT REFERENCES positions(id),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_template_shifts_template_day ON schedule_template_shifts (template_id, day_offset, start_time);

CREATE TABLE schedule_rotations (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (location_id, name)
);

CREATE TABLE schedule_rotation_weeks (
  rotation_id TEXT NOT NULL REFERENCES schedule_rotations(id),
  week_index INTEGER NOT NULL CHECK (week_index BETWEEN 0 AND 7),
  template_id TEXT NOT NULL REFERENCES schedule_templates(id),
  PRIMARY KEY (rotation_id, week_index)
);

-- Versioned recurring availability. Legacy rules are grouped into one default
-- set per employee so no existing data is lost.
CREATE TABLE availability_rule_sets (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL DEFAULT 'Regular availability',
  effective_from TEXT,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_availability_sets_employee_dates ON availability_rule_sets (employee_id, effective_from, effective_to);

ALTER TABLE availability_rules ADD COLUMN rule_set_id TEXT REFERENCES availability_rule_sets(id);

INSERT INTO availability_rule_sets (id, employee_id, label, effective_from, effective_to, created_at, updated_at)
SELECT 'availability_set_legacy_' || employee_id, employee_id, 'Regular availability',
       MIN(effective_from), MAX(effective_to), MIN(created_at), MAX(updated_at)
FROM availability_rules GROUP BY employee_id;

UPDATE availability_rules
SET rule_set_id = 'availability_set_legacy_' || employee_id
WHERE rule_set_id IS NULL;

CREATE TABLE availability_exception_series (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES users(id),
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly')),
  interval_weeks INTEGER NOT NULL DEFAULT 1 CHECK (interval_weeks BETWEEN 1 AND 12),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  preference TEXT NOT NULL CHECK (preference IN ('preferred', 'unavailable')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE availability_exceptions ADD COLUMN series_id TEXT REFERENCES availability_exception_series(id);
ALTER TABLE availability_exceptions ADD COLUMN occurrence_index INTEGER;
CREATE INDEX idx_availability_exception_series ON availability_exceptions (series_id, occurrence_index);

-- Immutable schedule snapshots used for history and restoration.
CREATE TABLE schedule_versions (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  version_number INTEGER NOT NULL,
  reason TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (schedule_id, version_number)
);

CREATE INDEX idx_schedule_versions_schedule ON schedule_versions (schedule_id, version_number DESC);

-- Private calendar subscriptions. Only a SHA-256 hash of the bearer token is
-- stored; calendar clients receive the raw token once.
CREATE TABLE calendar_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT 'My schedule',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_calendar_tokens_user ON calendar_tokens (user_id, revoked_at);

INSERT OR REPLACE INTO app_settings (setting_key, value_json, updated_at)
VALUES ('scheduling_features',
  '{"requestCancellation":true,"shiftExchanges":true,"templates":true,"calendarFeeds":true,"availabilityPeriods":true,"coverageHeatmap":true,"scheduleHistory":true,"profiles":true,"invitations":true,"push":true,"sms":true}',
  CURRENT_TIMESTAMP);

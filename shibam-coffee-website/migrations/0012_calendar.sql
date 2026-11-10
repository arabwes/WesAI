-- Portal calendar and booking links (phase 1: schema).
-- See docs/calendar-plan.md. All instants are stored as UTC ISO-8601 strings
-- (always `YYYY-MM-DDTHH:MM:SS.sssZ`, so text comparison orders correctly).
-- Wall-clock availability is stored as dates/times in the owner's timezone.

-- Saved in-person addresses. Archived, never deleted, so old bookings keep
-- a valid reference (bookings also snapshot the address at booking time).
CREATE TABLE meeting_locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-owner booking settings. Timezone is an IANA name (e.g. America/New_York).
CREATE TABLE booking_settings (
  owner_id TEXT PRIMARY KEY REFERENCES users(id),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  updated_at TEXT NOT NULL
);

-- Meetings are in person only, so a location is required.
CREATE TABLE event_types (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  location_id TEXT NOT NULL REFERENCES meeting_locations(id),
  min_notice_minutes INTEGER NOT NULL DEFAULT 240 CHECK (min_notice_minutes >= 0),
  max_days_ahead INTEGER NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
  slot_interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK (slot_interval_minutes IN (5, 10, 15, 20, 30, 60)),
  questions_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, slug)
);

CREATE INDEX idx_event_types_owner ON event_types (owner_id, active);

-- Weekly bookable hours. weekday uses 0 = Sunday .. 6 = Saturday, matching
-- availability_rules. Windows are same-day; an end of 00:00 means midnight.
CREATE TABLE booking_availability (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

CREATE INDEX idx_booking_availability_owner ON booking_availability (owner_id, weekday);

-- A date with override rows REPLACES the weekly hours for that date.
-- A row with NULL times means the whole day is unavailable.
CREATE TABLE booking_date_overrides (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  override_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  CHECK ((start_time IS NULL) = (end_time IS NULL))
);

CREATE INDEX idx_booking_overrides_owner_date ON booking_date_overrides (owner_id, override_date);

-- Reusable invitation links. Only a SHA-256 hash of the token is stored; the
-- raw token is shown to the creator once. max_uses NULL means unlimited.
CREATE TABLE booking_links (
  id TEXT PRIMARY KEY,
  event_type_id TEXT NOT NULL REFERENCES event_types(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_booking_links_event_type ON booking_links (event_type_id, revoked_at);

-- Client/candidate bookings. blocks_start_utc / blocks_end_utc are the meeting
-- plus its buffers, so overlap checks are a plain interval comparison.
-- client_* and answers_json are blanked by the retention job (anonymized_at).
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  event_type_id TEXT NOT NULL REFERENCES event_types(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  link_id TEXT NOT NULL REFERENCES booking_links(id),
  location_id TEXT NOT NULL REFERENCES meeting_locations(id),
  location_snapshot_json TEXT NOT NULL,
  title TEXT NOT NULL,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  blocks_start_utc TEXT NOT NULL,
  blocks_end_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  client_name TEXT,
  client_email TEXT COLLATE NOCASE,
  client_phone TEXT,
  client_timezone TEXT,
  answers_json TEXT NOT NULL DEFAULT '{}',
  manage_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  anonymized_at TEXT,
  CHECK (end_utc > start_utc),
  CHECK (blocks_start_utc <= start_utc AND blocks_end_utc >= end_utc)
);

-- Backstop for the conditional insert: two confirmed bookings can never share
-- the same start for one owner, even if application checks are bypassed.
CREATE UNIQUE INDEX idx_bookings_owner_start_confirmed
ON bookings (owner_id, start_utc) WHERE status = 'confirmed';

CREATE INDEX idx_bookings_owner_start ON bookings (owner_id, start_utc);
CREATE INDEX idx_bookings_status_start ON bookings (status, start_utc);
CREATE INDEX idx_bookings_link_email ON bookings (link_id, client_email, status);
CREATE INDEX idx_bookings_retention ON bookings (end_utc) WHERE anonymized_at IS NULL;

-- Team-wide events, visible with full details to every signed-in employee.
-- blocks_availability only affects the creator's own booking slots.
CREATE TABLE team_events (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  location TEXT NOT NULL DEFAULT '',
  blocks_availability INTEGER NOT NULL DEFAULT 0 CHECK (blocks_availability IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_utc > start_utc)
);

CREATE INDEX idx_team_events_start ON team_events (start_utc);
CREATE INDEX idx_team_events_creator ON team_events (created_by, start_utc);

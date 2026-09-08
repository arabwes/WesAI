PRAGMA foreign_keys = ON;

-- Public catering/event quote requests submitted from catering-events.html.
-- Unauthenticated visitors can insert; only team members can read/update.
CREATE TABLE catering_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_date TEXT,
  guest_count INTEGER,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX idx_catering_requests_status_created
ON catering_requests (status, created_at DESC);

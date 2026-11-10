-- Calendar phase 3: public booking flow.

-- A reschedule cancels the old booking and creates a new one; keep the link.
ALTER TABLE bookings ADD COLUMN rescheduled_from TEXT REFERENCES bookings(id);

-- Per-IP request counters for the public booking endpoints. Rows are keyed by
-- a hash of (scope, IP, time bucket), so no raw IP address is stored.
CREATE TABLE public_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_public_rate_limits_expiry ON public_rate_limits (expires_at);

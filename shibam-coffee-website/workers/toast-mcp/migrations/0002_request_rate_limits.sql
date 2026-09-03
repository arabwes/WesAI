CREATE TABLE request_rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 0),
  expires_at TEXT NOT NULL
);

CREATE INDEX request_rate_buckets_expiry_idx ON request_rate_buckets(expires_at);

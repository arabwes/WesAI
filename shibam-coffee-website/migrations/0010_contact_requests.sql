CREATE TABLE contact_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX idx_contact_requests_status_created
ON contact_requests (status, created_at DESC);

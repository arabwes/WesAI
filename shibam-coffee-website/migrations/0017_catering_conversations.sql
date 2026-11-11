-- Catering request conversations: staff and the customer message each other inside the
-- portal and on a private page, instead of through personal email and phone.
--
-- thread_token is the customer's private link (/inquiry/<token>). It is created the first
-- time staff reply, so only people we have written to ever get one. Lookups use the hash;
-- the token itself is kept so follow-up notification emails can include the link, and so
-- staff can copy it if an email does not arrive. It is only ever sent to Lead+ staff.
ALTER TABLE catering_requests ADD COLUMN thread_token TEXT;
ALTER TABLE catering_requests ADD COLUMN thread_token_hash TEXT;
-- The staff member who first replied. Customer replies notify them first.
ALTER TABLE catering_requests ADD COLUMN assigned_to TEXT REFERENCES users(id);
ALTER TABLE catering_requests ADD COLUMN last_message_at TEXT;

CREATE UNIQUE INDEX idx_catering_thread_hash ON catering_requests (thread_token_hash)
WHERE thread_token_hash IS NOT NULL;

-- kind 'staff'    : a message from the team, visible to the customer
-- kind 'customer' : a reply from the customer
-- kind 'note'     : an internal note, visible to staff only and never sent to the customer
CREATE TABLE catering_messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES catering_requests(id),
  kind TEXT NOT NULL CHECK (kind IN ('staff', 'customer', 'note')),
  author_user_id TEXT REFERENCES users(id),
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- customer messages: when a staff member first opened them (NULL = unread)
  read_at TEXT,
  -- staff messages: when the customer was emailed a notification
  emailed_at TEXT
);

CREATE INDEX idx_catering_messages_request ON catering_messages (request_id, created_at);
CREATE INDEX idx_catering_messages_unread ON catering_messages (request_id)
WHERE kind = 'customer' AND read_at IS NULL;

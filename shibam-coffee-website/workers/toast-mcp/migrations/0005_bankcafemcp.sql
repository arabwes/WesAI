-- BankCafeMCP: read-only Plaid bank data. Additive only; no existing Toast table is modified.

CREATE TABLE bank_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bank_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  label TEXT NOT NULL,
  institution_name TEXT,
  client_id TEXT,
  encrypted_client_secret TEXT,
  client_secret_nonce TEXT,
  encrypted_access_token TEXT,
  access_token_nonce TEXT,
  secret_key_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid', 'removed')),
  last_verified_at TEXT,
  last_error_code TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (status = 'removed' AND client_id IS NULL AND encrypted_client_secret IS NULL AND client_secret_nonce IS NULL
      AND encrypted_access_token IS NULL AND access_token_nonce IS NULL AND secret_key_version IS NULL)
    OR
    (status != 'removed' AND client_id IS NOT NULL AND encrypted_client_secret IS NOT NULL AND client_secret_nonce IS NOT NULL
      AND encrypted_access_token IS NOT NULL AND access_token_nonce IS NOT NULL AND secret_key_version IS NOT NULL)
  )
);

CREATE INDEX bank_connections_org_status_idx ON bank_connections(organization_id, status);

CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  plaid_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mask TEXT,
  type TEXT,
  subtype TEXT,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, plaid_account_id)
);

CREATE INDEX bank_accounts_org_status_idx ON bank_accounts(organization_id, status);

CREATE TABLE bank_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  connection_id TEXT REFERENCES bank_connections(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX bank_audit_events_created_idx ON bank_audit_events(created_at);
CREATE INDEX bank_audit_events_org_created_idx ON bank_audit_events(organization_id, created_at);

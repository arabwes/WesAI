PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth0_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  external_group_ref TEXT NOT NULL UNIQUE,
  sensitive_pii_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sensitive_pii_enabled IN (0, 1)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (organization_id, user_id)
);

CREATE INDEX memberships_user_status_idx ON memberships(user_id, status);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  location_ids_json TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES users(id),
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX invitations_org_status_idx ON invitations(organization_id, status);
CREATE INDEX invitations_email_status_idx ON invitations(email_normalized, status);

CREATE TABLE organization_scopes (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, scope)
);

CREATE TABLE member_scopes (
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (membership_id, scope)
);

CREATE TABLE toast_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('byo', 'partner')),
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  label TEXT NOT NULL,
  client_id TEXT,
  encrypted_client_secret TEXT,
  secret_nonce TEXT,
  secret_key_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid', 'disconnected', 'removed')),
  last_verified_at TEXT,
  last_error_code TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (
    (kind = 'partner' AND client_id IS NULL AND encrypted_client_secret IS NULL)
    OR
    (kind = 'byo' AND (
      (status = 'removed' AND client_id IS NULL AND encrypted_client_secret IS NULL AND secret_nonce IS NULL AND secret_key_version IS NULL)
      OR
      (status != 'removed' AND client_id IS NOT NULL AND encrypted_client_secret IS NOT NULL AND secret_nonce IS NOT NULL AND secret_key_version IS NOT NULL)
    ))
  )
);

CREATE INDEX toast_connections_org_status_idx ON toast_connections(organization_id, status);

CREATE TABLE toast_locations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES toast_connections(id) ON DELETE CASCADE,
  toast_guid TEXT NOT NULL,
  management_group_guid TEXT,
  restaurant_name TEXT NOT NULL,
  location_name TEXT,
  timezone TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid', 'disconnected', 'removed', 'pending_migration')),
  pending_connection_id TEXT REFERENCES toast_connections(id),
  external_restaurant_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (organization_id, toast_guid)
);

CREATE INDEX toast_locations_org_status_idx ON toast_locations(organization_id, status);
CREATE INDEX toast_locations_connection_idx ON toast_locations(connection_id);

CREATE TABLE member_locations (
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES toast_locations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (membership_id, location_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX sessions_user_expiry_idx ON sessions(user_id, expires_at);

CREATE TABLE partner_events (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('partner_added', 'partner_removed', 'partner_updated')),
  external_group_ref TEXT,
  external_restaurant_ref TEXT,
  restaurant_guid TEXT NOT NULL,
  management_group_guid TEXT,
  restaurant_name TEXT NOT NULL,
  location_name TEXT,
  restaurant_timezone TEXT,
  event_timestamp TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processed', 'quarantined', 'failed')),
  error_code TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX partner_events_status_idx ON partner_events(status, received_at);

CREATE TABLE oauth_grant_audit (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX oauth_grant_audit_user_idx ON oauth_grant_audit(user_id, created_at);

CREATE TABLE result_objects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  location_id TEXT NOT NULL REFERENCES toast_locations(id) ON DELETE CASCADE,
  chunk_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  key_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX result_objects_owner_expiry_idx ON result_objects(user_id, organization_id, expires_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  location_id TEXT REFERENCES toast_locations(id) ON DELETE SET NULL,
  operation_id TEXT,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_created_idx ON audit_events(created_at);
CREATE INDEX audit_events_org_created_idx ON audit_events(organization_id, created_at);

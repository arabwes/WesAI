-- 003_tenant_identities.sql — Google/Facebook sign-in identities and
-- portal sessions, for the persistent tenant login (no API keys entered).
CREATE TABLE IF NOT EXISTS tenant_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'facebook')),
  provider_user_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS tenant_identities_tenant_idx ON tenant_identities (tenant_id);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES tenant_identities ON DELETE CASCADE,
  session_hash bytea UNIQUE NOT NULL,   -- sha256(raw session cookie value)
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip text
);
CREATE INDEX IF NOT EXISTS portal_sessions_tenant_idx ON portal_sessions (tenant_id);

INSERT INTO schema_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;

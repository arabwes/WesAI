-- 001_init.sql — tenant store for WesAI MCP servers
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid on older PG

CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One keyspace shared by both servers; a key authenticates a tenant everywhere.
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  key_hash bytea UNIQUE NOT NULL,          -- sha256(raw key)
  label text,
  scopes text[] NOT NULL DEFAULT '{read}', -- 'read', 'mutate'
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  service text NOT NULL,                   -- 'toast','google','google_ads','meta','instagram','wheniwork','openai'
  key_id text NOT NULL,                    -- master-key version used to encrypt
  ciphertext bytea NOT NULL,               -- Fernet(json secret bundle)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service)
);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  server text NOT NULL,                    -- 'financial' | 'marketing'
  tenant_id uuid,
  api_key_id uuid,
  tool text NOT NULL,
  args_digest text,
  args_summary jsonb,
  outcome text NOT NULL,                   -- 'ok' | 'error' | 'denied'
  correlation_id text,
  latency_ms int
);
CREATE INDEX IF NOT EXISTS audit_tenant_ts_idx ON audit_log (tenant_id, ts DESC);

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;

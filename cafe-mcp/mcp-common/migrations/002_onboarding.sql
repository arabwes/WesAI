-- 002_onboarding.sql — one-time self-service onboarding links
CREATE TABLE IF NOT EXISTS onboarding_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,          -- sha256(raw link token)
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_links_tenant_idx ON onboarding_links (tenant_id);

INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;

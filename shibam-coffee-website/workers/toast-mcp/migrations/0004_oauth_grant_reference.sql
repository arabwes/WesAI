ALTER TABLE oauth_grant_audit ADD COLUMN provider_grant_id TEXT;

CREATE UNIQUE INDEX oauth_grant_audit_provider_id_idx
  ON oauth_grant_audit(provider_grant_id)
  WHERE provider_grant_id IS NOT NULL;

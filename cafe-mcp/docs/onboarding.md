# Tenant Onboarding Runbook

How to add a new customer to the cafe-mcp server (multi-tenant mode).

All commands below assume your working directory is `cafe-mcp/` (where
`scripts/`, `mcp-common/`, and the unified server live together).

## Prerequisites (one-time platform setup)

1. Railway Postgres addon provisioned; `DATABASE_URL` set on the cafe-mcp service.
2. `TENANT_MASTER_KEY` set on the service. Generate with:
   ```bash
   python scripts/tenant_admin.py gen-master-key --key-id v1
   ```
3. Schema applied:
   ```bash
   railway run python scripts/tenant_admin.py migrate
   ```

## Per-tenant steps

### 1. Create the tenant

```bash
python scripts/tenant_admin.py create-tenant acme --name "Acme Coffee Co"
```

### 2. Enroll credentials (encrypted at rest)

Each service gets one JSON bundle. Only enroll what the customer uses.

```bash
# Toast POS
python scripts/tenant_admin.py set-credential acme toast \
  --json '{"client_id":"...","client_secret":"...","restaurant_guid":"...","environment":"production"}'

# Financial services
python scripts/tenant_admin.py set-credential acme google \
  --json '{"client_id":"...","client_secret":"...","refresh_token":"..."}'
python scripts/tenant_admin.py set-credential acme quickbooks \
  --json '{"client_id":"...","client_secret":"...","refresh_token":"...","realm_id":"...","environment":"production"}'
python scripts/tenant_admin.py set-credential acme wheniwork \
  --json '{"api_key":"...","account_id":"..."}'
python scripts/tenant_admin.py set-credential acme openai --json '{"api_key":"..."}'
python scripts/tenant_admin.py set-credential acme anthropic --json '{"api_key":"..."}'

# Marketing services
python scripts/tenant_admin.py set-credential acme google_ads \
  --json '{"developer_token":"...","client_id":"...","client_secret":"...","refresh_token":"..."}'
python scripts/tenant_admin.py set-credential acme meta \
  --json '{"access_token":"...","app_id":"...","app_secret":"..."}'
python scripts/tenant_admin.py set-credential acme instagram --json '{"access_token":"..."}'
python scripts/tenant_admin.py set-credential acme gbp --json '{"places_api_key":"..."}'
```

Google/Meta refresh tokens are minted with the existing consent scripts
(`scripts/get_google_token.py` for Gmail/Sheets,
`scripts/get_refresh_token.py` for Google Ads/GBP) run against the
customer's OAuth client, signing in as the customer's account.

### 3. Set tenant settings (non-secret identifiers & preferences)

```bash
python scripts/tenant_admin.py set-setting acme --json '{
  "business_name": "Acme Coffee Co",
  "gmail_address": "owner@acmecoffee.com",
  "google_ads_customer_id": "1234567890",
  "meta_ad_account_id": "act_123456789",
  "instagram_business_account_id": "17841400000000000",
  "gbp_account_id": "...", "gbp_location_id": "...",
  "sheets_inventory_id": "...", "sheets_ledger_id": "...",
  "financial_dashboard_sheet_id": "...",
  "vendor_domains": {"Sysco": "sysco.com"},
  "toast_api_pending": false,
  "instagram_follower_baseline": 1000,
  "kpi_max_cpc": 1.50,
  "top_performer_items": ["latte", "cold brew"]
}'
```

All settings are optional; tools degrade gracefully or use generic defaults.

### 4. Mint API key(s)

```bash
# Read-only key for the customer's AI connector
python scripts/tenant_admin.py mint-key acme --scopes read --label "acme claude connector"

# Separate mutate-capable key only if the customer needs employee CRUD / sheet writes
python scripts/tenant_admin.py mint-key acme --scopes read,mutate --label "acme admin"
```

The raw key is printed ONCE. Deliver it over a secure channel.

### 5. Connect their AI client

**If their client supports a custom header** (e.g. ChatGPT custom connectors):
- URL: `https://<server>.up.railway.app/mcp`
- Auth header: `Authorization: Bearer wes_...`

**If their client is OAuth-only** (e.g. Claude.ai's connector picker on
personal plans — no custom header field): make sure `OAUTH_PUBLIC_URL` is
set on the deployment (see `docs/oauth.md`), then they add the connector
with just the URL above (no header). Claude redirects them to a login page
on your server where they paste the same `wes_...` key once to authorize —
after that it's a normal OAuth session, auto-refreshed.

### 6. Smoke test

Call a read tool with the new key and verify a row appears:
```sql
SELECT ts, tool, outcome FROM audit_log WHERE tenant_id =
  (SELECT id FROM tenants WHERE slug='acme') ORDER BY ts DESC LIMIT 5;
```

## Key rotation / revocation

```bash
python scripts/tenant_admin.py revoke-key <raw-key>       # immediate (60s cache TTL)
python scripts/tenant_admin.py mint-key acme --scopes read
```

Master-key rotation: prepend a new `key_id:fernet_key` to `TENANT_MASTER_KEY`,
redeploy, run `python scripts/tenant_admin.py rotate-master-key`, then remove
the old entry from the env var.

## Offboarding

```sql
UPDATE tenants SET status='suspended' WHERE slug='acme';  -- immediate lockout
-- or hard delete (cascades to keys/credentials/settings):
DELETE FROM tenants WHERE slug='acme';
```

# Tenant Onboarding — operator guide

Adding a new business is now three commands; the customer does the rest
themselves on the self-service portal.

## Prerequisites (one-time platform setup)

1. Railway Postgres addon; `DATABASE_URL` + `TENANT_MASTER_KEY` set on the
   service (schema auto-migrates at boot — look for `Auto-migration
   applied` / `Schema is up to date` in deploy logs).
2. `OAUTH_PUBLIC_URL` set to the server's public HTTPS URL.
3. For "log in with Google/Facebook" on the portal: platform OAuth apps
   configured per **docs/platform-apps.md** (`PLATFORM_GOOGLE_*`,
   `PLATFORM_META_*` env vars). Without them the portal still works —
   customers get form fields instead of login buttons.
4. `PRODUCT_NAME` and `OPERATOR_EMAIL` set (shown on the public pages).

Local admin CLI needs: `pip install -r requirements.txt -e ./mcp-common`,
plus `DATABASE_URL` (use the Postgres service's **public** connection URL,
not the `.railway.internal` one) and the same `TENANT_MASTER_KEY` exported
in your shell.

## Per-tenant flow

```bash
# 1. Create the tenant
python scripts/tenant_admin.py create-tenant acme --name "Acme Coffee Co"

# 2. Mint a one-time onboarding link (valid 7 days, shown once)
python scripts/tenant_admin.py onboard-link acme

# 3. Send the link to the customer (any private channel)
```

The customer opens the link and, on the portal:
- **Connect Google** / **Connect Google Ads** — signs into their Google
  account; refresh tokens, and Ads customer ID (auto-discovered, with a
  picker if they have several) are stored encrypted automatically. This
  also links their Google identity so they can sign back in later — see
  below.
- **Connect Facebook** — signs into Facebook; long-lived token stored,
  ad account + Instagram business account auto-discovered/picked. Links
  their Facebook identity the same way.
- **Toast / When I Work** — short forms (Toast credentials are
  live-verified against Toast's auth API before saving).
- **Business details** — name, invoice inbox, sheet IDs, vendor domains.
- **Finish setup** — the portal mints their read-scope API key (for AI
  assistants that need a manual header key, like ChatGPT), shows it once
  with the connector URL, and the link permanently expires. Claude and
  other OAuth-capable assistants don't need this key at all — see below.

Everything the customer submits is Fernet-encrypted at rest and audited
(`audit_log` rows `onboarding.*`). Secrets are never displayed back.

## The persistent portal (no API keys)

Once a customer has connected at least one Google or Facebook account,
they can come back anytime at `https://<domain>/login` and sign in with
that same account — no password, no key. This lands them on `/portal`,
where they can:
- See which services are connected.
- Click **Manage connections** to reconnect/add services or edit business
  details (mints a fresh short-lived onboarding link behind the scenes and
  hands them to the same flow above — invisible to them).
- Generate a new access key on demand, for assistants that require one.
- Sign out.

**Claude and other OAuth-capable MCP clients use this same sign-in** when
connecting — when Claude redirects to the authorization page, it offers
"Continue with Google"/"Continue with Facebook" as the primary option, with
pasting an access key as a fallback. Nobody needs to see a key to use
Claude.

## Verify a new tenant

```sql
SELECT service FROM tenant_credentials c JOIN tenants t ON t.id=c.tenant_id WHERE t.slug='acme';
SELECT ts, tool, outcome FROM audit_log WHERE tenant_id=(SELECT id FROM tenants WHERE slug='acme') ORDER BY ts DESC LIMIT 10;
```

## Manual fallback (CLI)

The portal wraps these — they still work directly for corrections or
services the portal doesn't cover:

```bash
python scripts/tenant_admin.py set-credential acme toast \
  --json '{"client_id":"...","client_secret":"...","restaurant_guid":"...","environment":"production"}'
python scripts/tenant_admin.py set-credential acme google \
  --json '{"client_id":"...","client_secret":"...","refresh_token":"..."}'
python scripts/tenant_admin.py set-credential acme google_ads \
  --json '{"developer_token":"...","client_id":"...","client_secret":"...","refresh_token":"..."}'
python scripts/tenant_admin.py set-credential acme meta \
  --json '{"access_token":"...","app_id":"...","app_secret":"..."}'
python scripts/tenant_admin.py set-credential acme instagram --json '{"access_token":"..."}'
python scripts/tenant_admin.py set-credential acme wheniwork --json '{"api_key":"...","account_id":"..."}'
python scripts/tenant_admin.py set-credential acme gbp --json '{"places_api_key":"..."}'
python scripts/tenant_admin.py set-credential acme openai --json '{"api_key":"..."}'
python scripts/tenant_admin.py set-credential acme quickbooks \
  --json '{"client_id":"...","client_secret":"...","refresh_token":"...","realm_id":"...","environment":"production"}'
python scripts/tenant_admin.py set-setting acme --json '{"google_ads_customer_id":"1234567890"}'
python scripts/tenant_admin.py mint-key acme --scopes read,mutate --label "acme admin"
```

## Reconnection & key management

- **Meta tokens expire ~60 days**: the customer can now self-serve this —
  sign in at `/login` → `/portal` → **Manage connections** → Connect
  Facebook again. You only need to mint a fresh onboard link yourself
  (`onboard-link acme`) for a customer who hasn't linked a sign-in identity
  yet, or who's lost access to their Google/Facebook account.
- Keys: customers can generate their own from `/portal`, or you can run
  `mint-key` / `revoke-key <raw-key>` (revocation effective within the 60s
  auth cache).
- Master-key rotation: prepend a new `key_id:fernet_key` to
  `TENANT_MASTER_KEY`, redeploy, run `rotate-master-key`, remove the old
  entry.

## Offboarding (also the data-deletion procedure referenced by /privacy)

```sql
UPDATE tenants SET status='suspended' WHERE slug='acme';  -- immediate lockout
DELETE FROM tenants WHERE slug='acme';  -- permanent: cascades credentials, keys, links, audit refs
```

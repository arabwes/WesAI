# Deployment

## 1. External prerequisites

Create separate Auth0 production and staging applications using Universal Login and the database (email/password) connection. Require email verification and disable social connections for the first release. Configure exact callback and logout URLs:

- Production callback: `https://shibamatlanta.com/toast-mcp/auth/callback`
- Production logout: `https://shibamatlanta.com/toast-mcp/`
- Staging callback: `https://cafe-mcp-staging.<account-subdomain>.workers.dev/toast-mcp/auth/callback`
- Staging logout: the corresponding staging portal URL

Do not add wildcard callback, logout, or web-origin entries. Update staging `PUBLIC_ORIGIN` if the assigned `workers.dev` hostname differs from the placeholder.

Create/verify the Resend sending domain and have privacy, terms, security, support, and deletion text reviewed by independent legal/security reviewers. Record their approval outside this repository.

## 2. Cloudflare resources

Wrangler configuration defines isolated production/staging D1, KV, R2, Durable Object, queue, DLQ, static assets, and cron bindings. It does not reference the website's `TEAM_DB` or notification queue.

Authenticate Wrangler, set the staging `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and exact
`PUBLIC_ORIGIN` in `wrangler.jsonc`, then provision/deploy staging first. The R2
bindings intentionally use fixed bucket names, so create those buckets explicitly.
Wrangler's automatic provisioning creates the missing D1, KV, and Queue resources
from their draft bindings and writes generated IDs back to the configuration file.

Create a secret file outside the repository (for example,
`C:\\secure\\cafe-mcp-staging.env`) containing:

```dotenv
AUTH0_CLIENT_SECRET=...
SESSION_SIGNING_KEY=...
CREDENTIAL_KEK_V1=...
RESULT_KEK_V1=...
RESEND_API_KEY=...
```

Generate `SESSION_SIGNING_KEY` from at least 32 random bytes. Both KEK values must
be exactly 32 random bytes encoded with standard base64. Protect and securely
remove the deployment file after use.

```sh
npm ci
npm run cf-typegen
npx wrangler r2 bucket create cafe-mcp-results-staging
npx wrangler d1 migrations apply TOAST_MCP_DB --env staging --remote
npx wrangler deploy --env staging --secrets-file C:\secure\cafe-mcp-staging.env
npx wrangler r2 bucket lifecycle add cafe-mcp-results-staging expire-results results/ --expire-days 1
```

Do not put secrets in `wrangler.jsonc` or commit a deployment secret file.

For production, first set the production Auth0 values in `wrangler.jsonc`, then
create `cafe-mcp-results` and repeat the migration and single-deploy sequence
without `--env staging`, using a different secret file and different generated key
values. Add the same `expire-results` lifecycle rule to the production bucket. The
production deploy attaches the path routes, so run it only after staging
acceptance. The scheduled Worker also deletes expired chunks.

## 3. Rollout gates

Keep `TOAST_BYO_MODE=disabled` until Toast confirms the applicable hosted credential-custody terms. Then enable it first for a controlled pilot deployment. Keep `TOAST_PARTNER_MODE=disabled` until Toast approves the integration and supplies credentials.

Partner activation additionally requires:

```sh
npx wrangler secret put TOAST_PARTNER_CLIENT_ID
npx wrangler secret put TOAST_PARTNER_CLIENT_SECRET
npx wrangler secret put TOAST_PARTNER_WEBHOOK_SECRET
```

## 4. Production path routes

Only these route patterns are attached:

- `shibamatlanta.com/toast-mcp*`
- `shibamatlanta.com/.well-known/oauth-protected-resource/toast-mcp*`
- `shibamatlanta.com/.well-known/oauth-authorization-server/toast-mcp*`

All unmatched requests continue to the existing Pages project. Before production deploy, export the existing zone route list and compare it after deployment. Smoke-test an existing homepage/static asset and the three Cafe MCP route families.

## 5. Verification

```sh
npm run catalog:check
npm run typecheck
npm test
npm run deploy:dry-run
```

Then use Auth0 test users and MCP Inspector to validate signup, email verification, multi-organization selection, consent, refresh, revocation, member scope/location denial, a small read, an oversized operational read, and cross-tenant denial. Production deployment is intentionally not performed by the repository test suite.

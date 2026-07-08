# OAuth bridge (for OAuth-only connector UIs)

Some MCP client UIs — notably Claude.ai's connector picker on personal
plans — only support OAuth-style connectors and don't let you paste a
custom `Authorization` header. This server includes a minimal OAuth 2.1
authorization server that bridges to the existing `wes_...` bearer-key
auth, so those clients can connect without any change to how credentials
are actually managed.

## How it works

1. Enable it by setting `OAUTH_PUBLIC_URL` to this server's own public
   HTTPS URL, e.g. `https://cafe-mcp-production.up.railway.app`.
2. In Claude.ai (or any spec-compliant MCP OAuth client), add a connector
   with just this URL + `/mcp` — no header/token field needed.
3. The client discovers OAuth support via
   `/.well-known/oauth-authorization-server`, dynamically registers itself
   (`/register`), and redirects the browser to `/authorize`.
4. Instead of a username/password screen, `/authorize` redirects to this
   server's own `/oauth/login` page, which asks for an existing `wes_...`
   API key (the same one you'd otherwise put in a custom header).
5. On success, the server issues a normal OAuth authorization code, the
   client exchanges it at `/token` for an access token, and every
   subsequent MCP call uses `Authorization: Bearer <oauth-token>` — which
   this server resolves back to the same tenant/scopes the original API key
   had.

This does not create a second credential system: the OAuth access token is
just an opaque wrapper that expires (1 hour, auto-refreshed via the refresh
token) and maps back to the API key's tenant and scopes. Revoking the
underlying API key (`scripts/tenant_admin.py revoke-key`) also cuts off any
OAuth tokens derived from it within the auth cache TTL (60s).

## Known limitations

- **In-memory storage.** Registered OAuth clients, pending logins, and
  issued codes/tokens live in process memory, not the database — they do
  not survive a restart or redeploy. This is an accepted tradeoff for a
  low-traffic deployment:
  - Dynamic client registration means the client just re-registers
    automatically next time it needs to.
  - A user whose access token was lost to a restart simply reconnects the
    connector (one login-page visit) — no data loss, just a brief
    reauthorization.
  - If Railway restarts become frequent enough to be disruptive, move this
    storage into the tenant Postgres DB (new tables mirroring
    `mcp-common/migrations/001_init.sql`'s pattern).
- **Static env keys work through this bridge too.** If you log in at
  `/oauth/login` using a static `MCP_API_KEYS` value instead of a
  DB-issued tenant key, the resulting OAuth session runs in env-fallback
  mode (same as using that key directly in a header).
- Without `OAUTH_PUBLIC_URL` set, none of this is mounted — the server
  behaves exactly as before, header-only auth.

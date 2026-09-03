# Architecture and data handling

## Request flow

1. Auth0 proves user identity with authorization code + S256 PKCE, state, and nonce.
2. Cafe MCP creates or loads a local user, organization, and membership in dedicated D1.
3. The Cloudflare OAuth provider validates the MCP client and exact redirect URI, records consent, and issues an organization-bound grant.
4. A tool call decrypts only stable user/organization/membership IDs, then rechecks current D1 membership, organization scopes, member scopes, and location grants.
5. `toast_execute_read` resolves one reviewed operation and one internal location ID. Cafe MCP supplies the fixed Toast hostname, catalog method/path, bearer token, and restaurant header.

The four tools are `toast_list_locations`, `toast_search_operations`, `toast_execute_read`, and `toast_read_result`.

## Resource isolation

- D1 `cafe-mcp-db`: tenants, permissions, connection metadata, grants, result metadata, sanitized audit events.
- KV `cafe-mcp-oauth`: OAuth provider state, Auth0 flow state, and consent resumes.
- R2 `cafe-mcp-results`: encrypted temporary non-sensitive result fragments.
- Durable Object `CafeCredentialBroker`: in-memory Toast tokens, single-flight refresh, and credential rate budget.
- Queue `cafe-mcp-jobs` + DLQ: invitation email and verified partner-event processing.

Per-user/organization request buckets use atomic D1 upserts and expire automatically during hourly cleanup. Partner reconciliation runs only on the separate eight-hour schedule.

Production and staging use distinct resource names. No module-global access-token cache exists.

## Data classes

`operational` responses may use encrypted 24-hour result fragments. `pii`, `orders` (including kitchen item-fulfillment exports), `labor`, and `cash` responses cannot be stored; an oversized response fails with a stable error and asks the client to narrow its query. Inline responses are capped at 512 KiB and upstream responses at 32 MiB.

Audit rows contain user, organization, location, operation ID, outcome, duration, status, timestamp, and request ID. They never contain credentials, access tokens, input parameters, or Toast bodies and are deleted after 90 days.

## Key rotation

Ciphertext records store `secret_key_version`. Version 1 resolves to `CREDENTIAL_KEK_V1` or `RESULT_KEK_V1`. Introduce a new secret and decryption branch before writing version 2; migrate records in bounded batches; remove the old key only after counts reach zero and backups expire.

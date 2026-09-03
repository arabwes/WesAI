# Cafe MCP

Cafe MCP is an isolated, multi-tenant Cloudflare Worker that gives standards-compatible MCP clients reviewed, read-only access to a user's Toast restaurant data. It is intentionally independent from the Shibam Coffee Pages application and its `TEAM_DB`.

Production URLs:

- Portal: `https://shibamatlanta.com/toast-mcp/`
- MCP: `https://shibamatlanta.com/toast-mcp/mcp`
- OAuth: `/toast-mcp/authorize`, `/toast-mcp/token`, `/toast-mcp/register`
- Protected-resource discovery: `/.well-known/oauth-protected-resource/toast-mcp/mcp`
- Authorization-server discovery alias: `/.well-known/oauth-authorization-server/toast-mcp`
- Auth0 callback: `/toast-mcp/auth/callback`
- Partner webhook: `/toast-mcp/webhooks/toast/partners`
- Health: `/toast-mcp/healthz`

The page is "disconnected" in the sense that it is unlinked, excluded from the sitemap, marked `noindex`, and independently deployed. It is not offline: Auth0, Toast, Resend, and Cloudflare services require network access.

## Security model

- Auth0 Universal Login authenticates people. Verified email is mandatory in both Auth0 policy and Worker-side ID-token validation.
- Organization, membership, location, and scope authorization lives in Cafe MCP's D1 database. OAuth tokens contain only stable IDs; every tool call reloads authorization from D1.
- Effective authorization is the intersection of organization scopes, member grants, and OAuth consent.
- BYO Toast client secrets are AES-256-GCM encrypted with a per-record nonce, record-bound associated data, and versioned Worker key. Secrets are never returned.
- Toast tokens exist only in `CafeCredentialBroker` Durable Object memory. The object coordinates refresh and rate pacing per credential.
- The runtime accepts operation IDs—not arbitrary URLs, methods, or headers. The catalog is generated from checksum-pinned official Toast OpenAPI specifications.
- Oversized operational results are encrypted in R2 and expire after 24 hours. PII, orders, labor, and cash responses are never persisted.
- Partner installations require the exact organization claim code. Unknown codes are quarantined; email is never used for matching.

## Local development

Requirements: Node.js 24+, npm, and a Cloudflare account for remote resource deployment.

```sh
npm ci
npm run cf-typegen
npm run db:migrate:local
npm test
npm run build
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars` and supply development-only values. Generate both KEKs as 32 random bytes encoded with standard base64. Never commit `.dev.vars`.

The checked-in default keeps both `TOAST_BYO_MODE` and `TOAST_PARTNER_MODE` disabled. Enable BYO only after confirming Toast's current credential-use terms. Enable partner mode only after approval and issuance of partner credentials/webhook secret.

## Operation catalog

`npm run catalog:sync` downloads the 12 official Toast OpenAPI specifications, pins their SHA-256 checksums in `catalog/spec-lock.json`, and emits a review ledger for every operation. The generator exposes non-payment GET operations except Menus V3, plus only the explicitly reviewed read-only calculation/search POSTs. Every excluded operation has a recorded reason.

After reviewing an upstream change:

```sh
npm run catalog:sync
npm run catalog:build
npm test
```

CI runs `catalog:check`, which fails if the runtime catalog and review ledger differ.

## Deployment

See [Deployment](docs/DEPLOYMENT.md), [architecture and data handling](docs/ARCHITECTURE.md), [partner readiness](docs/PARTNER_READINESS.md), and the [launch review checklist](docs/LAUNCH_REVIEW.md).

Cafe MCP is independent and does not claim partnership with or endorsement by Toast, Inc.

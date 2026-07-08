# Operations Runbook — Cafe MCP

## Architecture (multi-tenant)

```
Claude/ChatGPT connector
  └─ Bearer wes_<key>  ─────────────► Railway edge (TLS)
       └─ TenancyMiddleware: body cap → rate limit → auth → tenant contextvar
            └─ FastMCP app (+ AuditMiddleware on every tool call)
                 └─ tools read `config.<x>` → resolves per-request tenant
                      └─ tenant DB (Postgres): keys (hashed), credentials
                         (Fernet-encrypted), settings (jsonb), audit_log
```

- **Env-fallback mode** (break-glass / single-tenant): with `MCP_API_KEYS`
  set and no tenant rows, a static key authenticates and config comes from
  env vars — the pre-multi-tenant behavior, still auth-gated.
- Server refuses to boot with no auth configured unless
  `MCP_ALLOW_ANONYMOUS=true` (local dev only).

## Environment variables (single Railway service)

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | multi-tenant mode | Postgres tenant store |
| `TENANT_MASTER_KEY` | multi-tenant mode | Fernet key(s), `id:key` CSV, first = primary |
| `MCP_API_KEYS` | break-glass | static bearer keys (CSV) |
| `PORT` | yes (Railway sets) | listen port |
| legacy service creds | env-fallback only | see `.env.example` |

## Deploys

One Railway service for the unified server:

- Root Directory: `cafe-mcp`
- Build: the `Dockerfile` at the cafe-mcp root is the single build file —
  Railway auto-detects it there (builder = Dockerfile, see `railway.toml`).
  No language auto-detection (Railpack/Nixpacks) is involved; earlier
  split-server layouts failed because neither requirements.txt sat at the
  Root Directory root, producing images without Python/pip.
- Start: the Dockerfile's `CMD ["python", "main.py"]`.
- Health check path: `/` (returns only `{"status":"ok"}`).

## Backups & restore

- Railway Postgres daily backups + weekly `pg_dump` via GitHub Action
  (`.github/workflows/backup.yml`) to encrypted storage.
- Restore: provision new Postgres, `psql < dump.sql`, update `DATABASE_URL`.
- The tenant DB contains encrypted credentials — a dump alone is useless
  without `TENANT_MASTER_KEY`. Store the master key in a password manager,
  separate from DB backups.

## Incident quick reference

| Symptom | Check |
|---|---|
| Customer gets 401 | key revoked? tenant suspended? cache is 60s — recent revocation is expected to lag up to 1 min |
| Customer gets 429 | rate limit (60/min, burst 20) — legitimate spike? raise per deploy |
| Tool returns "internal error (ref: X)" | grep server logs for `ref=X` — full traceback is there |
| All tenants down | Postgres reachable? `TENANT_MASTER_KEY` present? server refuses boot without auth config |
| One tenant's third-party API failing | their credential expired (Meta 60-day token, Google testing-mode 7-day refresh token) — re-enroll via `set-credential` |
| Employee CRUD denied | key lacks `mutate` scope — intentional; mint a mutate key if authorized |

## Audit queries

```sql
-- last 24h activity by tenant
SELECT t.slug, a.tool, a.outcome, count(*) FROM audit_log a
JOIN tenants t ON t.id = a.tenant_id
WHERE a.ts > now() - interval '24 hours'
GROUP BY 1,2,3 ORDER BY 1, 4 DESC;

-- all mutations this month
SELECT ts, t.slug, tool, args_summary FROM audit_log a
JOIN tenants t ON t.id = a.tenant_id
WHERE tool IN ('toast_create_employee','toast_update_employee',
               'toast_unarchive_employee','sheets_write_labor_report',
               'invoice_ledger_sync')
  AND ts > date_trunc('month', now()) ORDER BY ts DESC;
```

## Security invariants (do not regress)

1. No tool may return raw exception text — always `safe_error()`.
2. No real account IDs, emails, or business names in source-code defaults or
   tool docstrings.
3. Raw API keys are never stored — SHA-256 hash only; shown once at mint.
4. Credentials at rest are always Fernet-encrypted with a versioned key.
5. Health endpoint discloses nothing beyond `{"status":"ok"}`.
6. Mutating tools require the `mutate` scope in tenant mode.

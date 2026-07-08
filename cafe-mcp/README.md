# Cafe MCP — unified small-business MCP server

One MCP server exposing 65 tools for running a small business, spanning:

| Domain | Tools |
|---|---|
| Toast POS — financial | labor summaries, tips, breaks, voids/refunds, payouts, payment breakdowns (14) |
| Toast POS — labor analytics | hourly headcount, labor cost by hour, sales by hour (4) |
| Toast POS — sales/marketing | sales summaries, top items, heatmaps, dayparts (7) |
| Toast POS — employees | list/create/update/unarchive (4; writes require `mutate` scope) |
| Email invoices (Gmail + OpenAI) | parse, vendor spend, reconciliation, ledger sync (4) |
| Payroll (QuickBooks) | summaries, by-role, labor % (4) |
| WhenIWork | schedules, forecasts, cost, punctuality (4) |
| Inventory (Google Sheets) | stock, valuation, reorder (5) |
| Google Ads | performance, spend, KPI checks, impression share (5) |
| Meta Ads | performance, KPIs, objectives, creatives (4) |
| Instagram | account summary, post performance, engagement (3) |
| Google Business Profile | reviews, completeness, competitors (3) |
| Digests | weekly financial, monthly close, weekly marketing (3) |
| QuickBooks accounting | 6 tools, currently disabled (commented out in `main.py`) |

## Architecture

- **FastMCP** over Streamable HTTP, behind bearer-token auth — see
  `mcp-common/` (tenant contextvar, encrypted credential store, audit log,
  rate limiting, sanitized errors).
- **Single-tenant mode**: credentials from env vars (`.env.example`),
  static keys via `MCP_API_KEYS`.
- **Multi-tenant mode**: set `DATABASE_URL` + `TENANT_MASTER_KEY`; per-tenant
  keys/credentials/settings via `scripts/tenant_admin.py`. See
  `docs/onboarding.md` and `docs/runbook.md`.

## Deploy (Railway)

- Root Directory: `cafe-mcp`
- The `Dockerfile` at this root is the single build file (auto-detected).
- Health check: `/` → `{"status":"ok"}`.

## Connect an AI client

Claude.ai / ChatGPT custom connector:
- URL: `https://<deployment>/mcp`
- Header: `Authorization: Bearer wes_...`

## Develop & test

```
pip install -r requirements.txt -e ./mcp-common pytest pytest-asyncio
python -m pytest tests mcp-common/tests -q
MCP_ALLOW_ANONYMOUS=true python main.py   # local dev without auth
```

See `TEST_PLAN.md` for the test strategy.

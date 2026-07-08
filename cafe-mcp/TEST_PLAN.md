# Test Plan — cafe-mcp (unified server)

## Scope

All 65 actively-registered tools in `main.py` (QuickBooks's 6 tools are
disabled and excluded — see comment block in `main.py`), plus the shared
`mcp_common` tenancy/auth/crypto package.

## Strategy

Every tool guards itself: it checks whether its required credentials/config
are present and returns a plain-English "not configured" message instead of
raising. Tools can therefore be smoke-tested with zero live credentials —
a passing test proves wiring (imports, registered, callable, graceful
return), not live-data correctness.

**Tier 1 — Import & registration check** (`tests/test_tools_smoke.py`).
Every tool registered in `main.py` imports cleanly and is an async callable.

**Tier 2 — Read-only smoke call.** Every non-mutating tool is invoked with
minimal/default arguments; asserts no exception and the documented return
type. Exercises the "not configured" path safely.

**Tier 3 — Mutating tools: smoke-skipped, manual/staging only.**
`toast_create_employee`, `toast_update_employee`, `toast_unarchive_employee`,
`sheets_write_labor_report`, `invoice_ledger_sync` write to live systems.
Tier-1 checks only; marked `skip` in Tier 2. They also require the `mutate`
API-key scope in multi-tenant mode.

**Tenancy & isolation** (`tests/test_tenancy.py` + `mcp-common/tests/`):
auth 401 paths, rate limiting, body caps, scope denial, crypto round-trip,
tenant-scoped config resolution, and the critical concurrent-tenant
isolation test (no config bleed across simultaneous requests).

**Tier 4 — Live integration (not implemented).** Once real credentials are
available, an opt-in suite gated behind `RUN_LIVE_TESTS=1` should assert
actual data shapes per tool. Follow-up work.

## Running

```
pip install -r requirements.txt -e ./mcp-common pytest pytest-asyncio
python -m pytest tests mcp-common/tests -q
```

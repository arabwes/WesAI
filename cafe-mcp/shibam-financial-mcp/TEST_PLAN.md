# Test Plan — shibam-financial-mcp

## Scope

All 42 actively-registered tools in `main.py` (QuickBooks's 6 tools are
disabled and excluded — see comment block in `main.py`).

## Strategy

Every tool already guards itself: at the top of each function (or via a
shared `_check_*()` helper) it checks whether its required credentials/config
are present and returns a plain-English "not configured" string instead of
raising when they're missing. That means tools can be smoke-tested with zero
live credentials — a passing test only proves the tool is wired correctly
(imports, registered, callable, returns gracefully), not that the live
integration produces correct data. Live-data correctness needs Tier 4.

**Tier 1 — Import & registration check.** Every tool name listed in
`main.py`'s `mcp.tool()` calls imports cleanly and is an `async` callable.

**Tier 2 — Read-only smoke call.** Every non-mutating tool is invoked with
minimal/default arguments. Asserts the call completes without raising and
returns the documented type (`str`, `dict`, or `list`). Runs safely with no
credentials configured — exercises the "not configured" path.

**Tier 3 — Mutating tools: smoke-skipped, manual/staging only.**
`toast_create_employee`, `toast_update_employee`, `toast_unarchive_employee`,
`sheets_write_labor_report`, and `invoice_ledger_sync` write to live systems
(Toast HR records, Google Sheets). These are NOT auto-invoked by the test
suite. They get a Tier-1 import check only, and are marked `skip` with a
reason in Tier 2. Verify these manually against a staging Toast location /
test sheet before relying on them in production. In multi-tenant mode they
additionally require the `mutate` API-key scope.

**Tier 4 — Live integration (not implemented here).** Once real credentials
are available, an opt-in suite gated behind `RUN_LIVE_TESTS=1` should assert
actual data shape/values per tool. Out of scope — flagged as follow-up work.

**Tenancy tests** (`tests/test_tenancy.py`): auth 401 paths, scope denial,
tenant-context config resolution, and cross-tenant isolation. See the
repo-root `mcp-common/tests/` for the shared-package unit tests.

## Running

```
pip install -r requirements.txt -e ../mcp-common pytest pytest-asyncio
pytest tests/ -v
```

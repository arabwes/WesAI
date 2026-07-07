# Test Plan — shibam-marketing-mcp

## Scope

All 23 actively-registered tools in `main.py`.

## Strategy

Same approach as `shibam-financial-mcp` (see that repo's `TEST_PLAN.md` for
the full rationale): every tool guards its own missing-config case and
returns a plain-English string instead of raising, so smoke tests can run
with zero live credentials.

**Tier 1 — Import & registration check.** Every tool listed in `main.py`'s
`mcp.tool()` calls imports cleanly and is an `async` callable.

**Tier 2 — Read-only smoke call.** All 23 tools in this server are
read-only, so all are exercised directly with default/minimal arguments.
Asserts no exception and a return type matching the docstring/annotation.

**Tier 3 — Live integration (not implemented here).** Once Google Ads,
Meta Ads, Instagram, GBP, and Toast Production credentials are live, an
opt-in suite gated behind `RUN_LIVE_TESTS=1` should assert real metric
shapes/values. Out of scope — flagged as follow-up work.

**Tenancy tests** (`tests/test_tenancy.py`): auth 401 paths, tenant-context
config resolution, and cross-tenant isolation. See the repo-root
`mcp-common/tests/` for the shared-package unit tests.

## Running

```
pip install -r requirements.txt -e ../mcp-common pytest pytest-asyncio
pytest tests/ -v
```

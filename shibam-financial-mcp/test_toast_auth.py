"""
Standalone Toast auth diagnostic — run this directly wherever the server runs
(locally or via `railway run python test_toast_auth.py`) to isolate whether
the problem is credentials, the restaurant GUID, or API access/scope.

Usage:
    python test_toast_auth.py
"""
import sys
sys.path.insert(0, ".")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from config import config
from clients import toast_client


def mask(s: str, keep: int = 4) -> str:
    if not s:
        return "(EMPTY)"
    return s[:keep] + "…" + f"({len(s)} chars)"


print("=" * 60)
print("TOAST AUTH DIAGNOSTIC")
print("=" * 60)
print(f"TOAST_ENVIRONMENT      = {config.toast_environment}")
print(f"TOAST_API_PENDING      = {config.toast_api_pending}")
print(f"TOAST_CLIENT_ID        = {mask(config.toast_client_id)}")
print(f"TOAST_CLIENT_SECRET    = {mask(config.toast_client_secret)}")
print(f"TOAST_RESTAURANT_GUID  = {config.toast_restaurant_guid or '(EMPTY)'}")
print()

if config.toast_api_pending:
    print("❌ TOAST_API_PENDING is true — set it to 'false' before testing further.")
    sys.exit(1)

missing = [n for n, v in [
    ("TOAST_CLIENT_ID", config.toast_client_id),
    ("TOAST_CLIENT_SECRET", config.toast_client_secret),
    ("TOAST_RESTAURANT_GUID", config.toast_restaurant_guid),
] if not v]
if missing:
    print(f"❌ Missing env vars: {', '.join(missing)}")
    sys.exit(1)

# ── Step 1: token fetch ───────────────────────────────────────────────────────
print("Step 1: Requesting access token (login)...")
try:
    token = toast_client.get_token()
    print(f"  ✅ Token acquired ({len(token)} chars).")
except Exception as e:
    print(f"  ❌ FAILED at login: {e}")
    print("\n  -> TOAST_CLIENT_ID / TOAST_CLIENT_SECRET are wrong for this environment.")
    sys.exit(1)

# ── Step 2: a cheap config-read call (proves header + scope on read-only data) ─
print("\nStep 2: Calling /config/v2/diningOptions (lightweight, read-only)...")
try:
    result = toast_client.get("/config/v2/diningOptions")
    n = len(result) if isinstance(result, list) else "?"
    print(f"  ✅ Success — {n} dining options returned.")
except Exception as e:
    print(f"  ❌ FAILED: {e}")
    sys.exit(1)

# ── Step 3: the actual failing call from the bug report ───────────────────────
print("\nStep 3: Calling /orders/v2/orders (1-hour window, the endpoint from the bug report)...")
try:
    from datetime import datetime, timedelta, timezone
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=1)
    result = toast_client.get("/orders/v2/orders", params={
        "startDate": start.strftime("%Y-%m-%dT%H:%M:%S.000+0000"),
        "endDate": end.strftime("%Y-%m-%dT%H:%M:%S.000+0000"),
        "pageSize": 10,
        "page": 1,
    })
    n = len(result) if isinstance(result, list) else "?"
    print(f"  ✅ Success — {n} order GUIDs returned for the last hour.")
    print("\n✅ ALL CHECKS PASSED. Toast auth is fully working in this environment.")
except Exception as e:
    print(f"  ❌ FAILED: {e}")
    print("\n  Step 2 succeeded but Step 3 failed -> the credentials and restaurant GUID")
    print("  are correct, but this app's API access likely lacks the orders:read scope,")
    print("  or is not yet Production Approved for the Orders API specifically.")
    sys.exit(1)

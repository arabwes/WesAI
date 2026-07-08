"""Onboarding portal route tests — no database required: link verification
and the store are monkeypatched, exercising token gating, CSRF, form
validation, finish/auto-mint, and the OAuth start redirects."""
import re
from datetime import datetime, timedelta, timezone

import pytest
from fastmcp import FastMCP
from starlette.testclient import TestClient

from mcp_common.crypto import generate_master_key
from mcp_common.middleware import TenancyMiddleware
from mcp_common.onboarding import links as links_mod
from mcp_common.onboarding.links import OnboardingSession
from mcp_common.onboarding.routes import register_onboarding_routes
from mcp_common import store as store_mod

GOOD = "good-token"
SESSION = OnboardingSession(
    link_id="l1", tenant_id="t1", slug="acme", tenant_name="Acme Coffee",
    expires_at=datetime.now(timezone.utc) + timedelta(days=7),
)


@pytest.fixture
def saved():
    return {"credentials": {}, "settings": {}, "keys": [], "completed": []}


@pytest.fixture
def client(monkeypatch, saved):
    monkeypatch.setenv("MCP_API_KEYS", "unit-test-key")
    monkeypatch.setenv("TENANT_MASTER_KEY", generate_master_key("v1"))
    monkeypatch.setenv("OAUTH_PUBLIC_URL", "https://portal.test")
    monkeypatch.delenv("PLATFORM_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("PLATFORM_META_APP_ID", raising=False)

    async def fake_verify(raw):
        return SESSION if raw == GOOD else None

    async def fake_complete(raw):
        if raw == GOOD and raw not in saved["completed"]:
            saved["completed"].append(raw)
            return True
        return False

    async def fake_set_credential(slug, service, bundle, cipher):
        saved["credentials"][service] = bundle

    async def fake_set_settings(slug, patch):
        saved["settings"].update(patch)

    async def fake_create_api_key(slug, scopes, label=""):
        saved["keys"].append((slug, tuple(scopes), label))
        return "wes_test_minted_key"

    async def fake_credential_services(slug):
        return set(saved["credentials"])

    async def fake_get_settings(slug):
        return dict(saved["settings"])

    monkeypatch.setattr(links_mod, "verify_token", fake_verify)
    monkeypatch.setattr(links_mod, "complete", fake_complete)
    monkeypatch.setattr(store_mod, "set_credential", fake_set_credential)
    monkeypatch.setattr(store_mod, "set_settings", fake_set_settings)
    monkeypatch.setattr(store_mod, "create_api_key", fake_create_api_key)
    monkeypatch.setattr(store_mod, "credential_services", fake_credential_services)
    monkeypatch.setattr(store_mod, "get_settings", fake_get_settings)

    # Toast live-verify: pretend network is unavailable (save proceeds)
    import mcp_common.onboarding.routes as routes_mod
    async def fake_verify_toast(bundle):
        return None
    monkeypatch.setattr(routes_mod, "_verify_toast", fake_verify_toast)

    mcp = FastMCP("portal-test")
    register_onboarding_routes(mcp)
    app = TenancyMiddleware(mcp.http_app(host_origin_protection=False),
                            onboarding_enabled=True)
    return TestClient(app)


def _csrf(client):
    r = client.get(f"/onboard?t={GOOD}")
    assert r.status_code == 200
    return re.search(r'name="csrf" value="([^"]+)"', r.text).group(1)


def test_dashboard_valid_token(client):
    r = client.get(f"/onboard?t={GOOD}")
    assert r.status_code == 200
    assert "Acme Coffee" in r.text
    assert "onboard_csrf" in r.cookies


def test_dashboard_bad_token_404(client):
    assert client.get("/onboard?t=nope").status_code == 404
    assert client.get("/onboard").status_code == 404


def test_toast_save_roundtrip(client, saved):
    csrf = _csrf(client)
    r = client.post("/onboard/toast", data={
        "t": GOOD, "csrf": csrf, "client_id": "cid", "client_secret": "sec",
        "restaurant_guid": "guid-1",
    }, follow_redirects=False)
    assert r.status_code == 303
    assert saved["credentials"]["toast"]["restaurant_guid"] == "guid-1"
    assert saved["settings"]["toast_api_pending"] is False
    # dashboard now shows connected, and never echoes the secret
    r = client.get(f"/onboard?t={GOOD}")
    assert "sec" not in r.text.replace("client_secret", "")
    assert "✓" in r.text


def test_csrf_required(client, saved):
    r = client.post("/onboard/toast", data={
        "t": GOOD, "csrf": "wrong", "client_id": "c", "client_secret": "s",
        "restaurant_guid": "g",
    })
    assert r.status_code == 400
    assert "toast" not in saved["credentials"]


def test_business_vendor_parsing(client, saved):
    csrf = _csrf(client)
    r = client.post("/onboard/business", data={
        "t": GOOD, "csrf": csrf, "business_name": "Acme",
        "vendor_domains": "Sysco: sysco.com\nDepot: restaurantdepot.com",
    }, follow_redirects=False)
    assert r.status_code == 303
    assert saved["settings"]["vendor_domains"] == {
        "Sysco": "sysco.com", "Depot": "restaurantdepot.com"}


def test_business_vendor_bad_line(client, saved):
    csrf = _csrf(client)
    r = client.post("/onboard/business", data={
        "t": GOOD, "csrf": csrf, "vendor_domains": "not a valid line",
    })
    assert r.status_code == 400


def test_finish_mints_key_once(client, saved):
    csrf = _csrf(client)
    r = client.post("/onboard/finish", data={"t": GOOD, "csrf": csrf})
    assert r.status_code == 200
    assert "wes_test_minted_key" in r.text
    assert saved["keys"] == [("acme", ("read",), "onboarding portal")]
    # link is dead now
    r = client.post("/onboard/finish", data={"t": GOOD, "csrf": csrf})
    assert r.status_code == 404


def test_google_start_unconfigured_gives_error_page(client):
    r = client.get(f"/onboard/google/start?t={GOOD}&ads=0")
    assert r.status_code == 400
    assert "not configured" in r.text


def test_google_start_redirects_when_configured(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    r = client.get(f"/onboard/google/start?t={GOOD}&ads=0", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://accounts.google.com/o/oauth2/auth")
    assert "gmail.readonly" in loc
    assert "adwords" not in loc
    assert GOOD in loc  # state carries the onboarding token
    assert "onboard_gnonce" in r.cookies


def test_meta_start_redirects_when_configured(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_META_APP_ID", "mid")
    monkeypatch.setenv("PLATFORM_META_APP_SECRET", "msec")
    r = client.get(f"/onboard/meta/start?t={GOOD}", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://www.facebook.com/v19.0/dialog/oauth")
    assert "ads_read" in loc
    assert "onboard_mnonce" in r.cookies


def test_callback_state_mismatch_rejected(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_META_APP_ID", "mid")
    monkeypatch.setenv("PLATFORM_META_APP_SECRET", "msec")
    # no nonce cookie set -> mismatch
    r = client.get(f"/onboard/meta/callback?state={GOOD}.badnonce&code=x")
    assert r.status_code == 400
    assert "mismatch" in r.text


def test_onboard_rate_limit(monkeypatch, client):
    # fresh middleware with a tiny bucket to assert 429 behavior
    mcp = FastMCP("rl-test")
    register_onboarding_routes(mcp)
    app = TenancyMiddleware(mcp.http_app(host_origin_protection=False),
                            onboarding_enabled=True)
    app.onboard_bucket.rate = 0.0
    app.onboard_bucket.burst = 2.0
    c = TestClient(app)
    assert c.get("/onboard?t=x").status_code == 404
    assert c.get("/onboard?t=x").status_code == 404
    assert c.get("/onboard?t=x").status_code == 429

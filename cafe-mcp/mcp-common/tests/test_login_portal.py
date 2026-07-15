"""Tests for /login (Google/Facebook identity sign-in) and /portal
(session-gated dashboard) — no database required: identity/store/links are
monkeypatched, mirroring test_onboarding_portal.py's approach."""
import re

import pytest
from fastmcp import FastMCP
from starlette.testclient import TestClient

from mcp_common.crypto import generate_master_key
from mcp_common.identity import TenantIdentitySession
from mcp_common.middleware import TenancyMiddleware
from mcp_common.onboarding import links as links_mod
from mcp_common.onboarding.routes import register_onboarding_routes
from mcp_common.onboarding.login_flow import SESSION_COOKIE, register_login_page_routes
from mcp_common.portal.routes import register_portal_routes
from mcp_common import identity as identity_mod
from mcp_common import store as store_mod

SESSION = TenantIdentitySession(
    tenant_id="t1", slug="acme", tenant_name="Acme Coffee",
    identity_id="i1", email="owner@acme.test",
)
GOOD_COOKIE = "good-session-cookie"


@pytest.fixture
def saved():
    return {"credentials": {"toast"}, "settings": {"business_name": "Acme Coffee"},
            "keys": [], "sessions_created": [], "sessions_revoked": [], "links_minted": []}


@pytest.fixture
def client(monkeypatch, saved):
    monkeypatch.setenv("MCP_API_KEYS", "unit-test-key")
    monkeypatch.setenv("TENANT_MASTER_KEY", generate_master_key("v1"))
    monkeypatch.setenv("OAUTH_PUBLIC_URL", "https://portal.test")
    monkeypatch.delenv("PLATFORM_GOOGLE_CLIENT_ID", raising=False)
    monkeypatch.delenv("PLATFORM_META_APP_ID", raising=False)

    async def fake_verify_session(raw):
        return SESSION if raw == GOOD_COOKIE else None

    async def fake_find_tenant_by_identity(provider, provider_user_id):
        if provider == "google" and provider_user_id == "known-sub":
            return SESSION
        return None

    async def fake_create_session(tenant_id, identity_id, ua="", ip=""):
        saved["sessions_created"].append((tenant_id, identity_id))
        return GOOD_COOKIE

    async def fake_revoke_session(raw):
        saved["sessions_revoked"].append(raw)

    async def fake_credential_services(slug):
        return set(saved["credentials"])

    async def fake_get_settings(slug):
        return dict(saved["settings"])

    async def fake_create_api_key(slug, scopes, label=""):
        saved["keys"].append((slug, tuple(scopes), label))
        return "wes_generated_key"

    async def fake_mint_link(slug, ttl_days=1):
        saved["links_minted"].append((slug, ttl_days))
        return "freshly-minted-link-token"

    monkeypatch.setattr(identity_mod, "verify_session", fake_verify_session)
    monkeypatch.setattr(identity_mod, "find_tenant_by_identity", fake_find_tenant_by_identity)
    monkeypatch.setattr(identity_mod, "create_session", fake_create_session)
    monkeypatch.setattr(identity_mod, "revoke_session", fake_revoke_session)
    monkeypatch.setattr(store_mod, "credential_services", fake_credential_services)
    monkeypatch.setattr(store_mod, "get_settings", fake_get_settings)
    monkeypatch.setattr(store_mod, "create_api_key", fake_create_api_key)
    monkeypatch.setattr(links_mod, "mint_link", fake_mint_link)

    # onboarding routes reference these same identity/store symbols via the
    # `mcp_common.identity`/`mcp_common.store` modules (not re-imported), so
    # patching the module attributes above covers portal/routes.py too.
    import mcp_common.onboarding.routes as onboarding_routes_mod
    async def fake_onboarding_verify_token(raw):
        return None
    monkeypatch.setattr(links_mod, "verify_token", fake_onboarding_verify_token)

    mcp = FastMCP("login-portal-test")
    register_onboarding_routes(mcp)
    register_login_page_routes(mcp)
    register_portal_routes(mcp)
    app = TenancyMiddleware(mcp.http_app(host_origin_protection=False), onboarding_enabled=True)
    return TestClient(app)


# ── /login ──────────────────────────────────────────────────────────────────

def test_login_page_loads(client):
    r = client.get("/login")
    assert r.status_code == 200
    assert "Sign in" in r.text


def test_login_page_shows_unconfigured_hint_without_platform_apps(client):
    r = client.get("/login")
    assert "not configured" in r.text


def test_google_start_unconfigured(client):
    r = client.get("/login/google/start", follow_redirects=False)
    assert r.status_code == 400


def test_google_start_redirects_when_configured(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    r = client.get("/login/google/start", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://accounts.google.com/o/oauth2/auth")
    assert "openid" in loc
    # must NOT request the sensitive data-access scopes just to sign in
    assert "gmail.readonly" not in loc
    assert "adwords" not in loc
    assert "cafemcp_login_nonce" in r.cookies


def test_facebook_start_redirects_when_configured(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_META_APP_ID", "mid")
    monkeypatch.setenv("PLATFORM_META_APP_SECRET", "msec")
    r = client.get("/login/facebook/start", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://www.facebook.com/v19.0/dialog/oauth")
    assert "public_profile" in loc
    assert "ads_read" not in loc
    assert "cafemcp_login_nonce" in r.cookies


def test_google_callback_state_mismatch(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    r = client.get("/login/google/callback?state=whatever&code=x")
    assert r.status_code == 400
    assert "mismatch" in r.text


def test_google_callback_denied(client, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    client.cookies.set("cafemcp_login_nonce", "abc")
    r = client.get("/login/google/callback?state=abc&error=access_denied")
    assert r.status_code == 400
    assert "cancelled or denied" in r.text


# ── /portal ─────────────────────────────────────────────────────────────────

def test_portal_requires_session(client):
    r = client.get("/portal", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/login"


def test_portal_dashboard_with_valid_session(client):
    client.cookies.set(SESSION_COOKIE, GOOD_COOKIE)
    r = client.get("/portal")
    assert r.status_code == 200
    assert "Acme Coffee" in r.text
    assert "owner@acme.test" in r.text


def test_portal_dashboard_bad_session_redirects(client):
    client.cookies.set(SESSION_COOKIE, "garbage")
    r = client.get("/portal", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/login"


def _portal_csrf(client):
    client.cookies.set(SESSION_COOKIE, GOOD_COOKIE)
    r = client.get("/portal")
    return re.search(r'name="csrf" value="([^"]+)"', r.text).group(1)


def test_generate_key(client, saved):
    csrf = _portal_csrf(client)
    r = client.post("/portal/generate-key", data={"csrf": csrf, "label": "ChatGPT"})
    assert r.status_code == 200
    assert "wes_generated_key" in r.text
    assert saved["keys"] == [("acme", ("read",), "ChatGPT")]


def test_generate_key_requires_csrf(client, saved):
    client.cookies.set(SESSION_COOKIE, GOOD_COOKIE)
    r = client.post("/portal/generate-key", data={"csrf": "wrong"}, follow_redirects=False)
    assert r.status_code == 303  # bounced back to /portal, no key minted
    assert saved["keys"] == []


def test_generate_key_requires_session(client, saved):
    r = client.post("/portal/generate-key", data={"csrf": "x"}, follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/login"
    assert saved["keys"] == []


def test_manage_mints_link_and_redirects_to_onboard(client, saved):
    csrf = _portal_csrf(client)
    r = client.post("/portal/manage", data={"csrf": csrf}, follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/onboard?t=freshly-minted-link-token"
    assert saved["links_minted"] == [("acme", 1)]


def test_logout_revokes_and_redirects_home(client, saved):
    client.cookies.set(SESSION_COOKIE, GOOD_COOKIE)
    r = client.post("/portal/logout", data={}, follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/"
    assert saved["sessions_revoked"] == [GOOD_COOKIE]

"""HTTP-level tests for the OAuth-bridge's identity sign-in routes
(/oauth/login/google/*, /oauth/login/facebook/*) — the path an MCP client
like Claude uses to authenticate a tenant with no pasted API key."""
import httpx
import pytest
from fastmcp import FastMCP
from mcp.server.auth.provider import AuthorizationParams
from mcp.shared.auth import OAuthClientInformationFull
from pydantic import AnyUrl
from starlette.testclient import TestClient

from mcp_common import identity as identity_mod
from mcp_common.oauth import TenantOAuthProvider, register_login_routes


def _client_info(client_id="mcp-client", redirect="https://claude.ai/callback"):
    return OAuthClientInformationFull(
        client_id=client_id, redirect_uris=[AnyUrl(redirect)],
        client_name="test", grant_types=["authorization_code"],
        response_types=["code"], token_endpoint_auth_method="none",
    )


def _params(redirect="https://claude.ai/callback"):
    return AuthorizationParams(
        state="s1", scopes=["read"], redirect_uri=AnyUrl(redirect),
        redirect_uri_provided_explicitly=True, code_challenge="c", resource=None,
    )


class FakeResponse:
    def __init__(self, json_data, status_code=200):
        self._json = json_data
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json


class FakeAsyncClient:
    """Fakes httpx.AsyncClient for the google/facebook token+userinfo
    exchange sequence: first call returns a token, second returns a profile."""
    def __init__(self, responses):
        self._responses = list(responses)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **kw):
        return self._responses.pop(0)

    async def get(self, *a, **kw):
        return self._responses.pop(0)


@pytest.fixture
def app_and_provider(monkeypatch, tmp_path):
    monkeypatch.setenv("OAUTH_PUBLIC_URL", "https://mcp.test")
    provider = TenantOAuthProvider(base_url="https://mcp.test")
    mcp = FastMCP("oauth-login-test")
    register_login_routes(mcp, provider)
    app = mcp.http_app(host_origin_protection=False)
    return TestClient(app), provider


async def _seed_pending(provider) -> str:
    client = _client_info()
    await provider.register_client(client)
    url = await provider.authorize(client, _params())
    return url.split("txn=")[1]


# ── page rendering ────────────────────────────────────────────────────────────

def test_login_page_no_platform_apps_shows_key_form_only(app_and_provider):
    client, provider = app_and_provider
    r = client.get("/oauth/login?txn=whatever")
    assert r.status_code == 400  # unknown txn
    assert "Continue with Google" not in r.text
    assert "access key instead" in r.text


async def test_login_page_shows_provider_buttons_when_configured(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    monkeypatch.setenv("PLATFORM_META_APP_ID", "mid")
    monkeypatch.setenv("PLATFORM_META_APP_SECRET", "msec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)
    r = client.get(f"/oauth/login?txn={txn}")
    assert r.status_code == 200
    assert "Continue with Google" in r.text
    assert "Continue with Facebook" in r.text


# ── Google identity sign-in ─────────────────────────────────────────────────

async def test_google_start_redirect_has_minimal_scopes(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)
    r = client.get(f"/oauth/login/google/start?txn={txn}", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://accounts.google.com/o/oauth2/auth")
    assert "openid" in loc
    assert "gmail" not in loc
    assert f"state={txn}." in loc or f"state={txn}%2E" in loc.replace(".", "%2E") or txn in loc


async def test_google_callback_success_completes_authorization(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)

    async def fake_find(provider_name, provider_user_id):
        assert provider_name == "google"
        assert provider_user_id == "google-sub-42"
        return identity_mod.TenantIdentitySession(
            tenant_id="t1", slug="acme", tenant_name="Acme", identity_id="i1", email="o@acme.test")
    monkeypatch.setattr(identity_mod, "find_tenant_by_identity", fake_find)

    fake_client = FakeAsyncClient([
        FakeResponse({"access_token": "gtok"}),          # token endpoint
        FakeResponse({"sub": "google-sub-42", "email": "o@acme.test"}),  # userinfo
    ])
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: fake_client)

    client.cookies.set("cafemcp_oauth_login_nonce", "nonce1")
    r = client.get(f"/oauth/login/google/callback?state={txn}.nonce1&code=abc", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].startswith("https://claude.ai/callback?code=")


async def test_google_callback_unrecognized_identity(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)

    async def fake_find(provider_name, provider_user_id):
        return None
    monkeypatch.setattr(identity_mod, "find_tenant_by_identity", fake_find)

    fake_client = FakeAsyncClient([
        FakeResponse({"access_token": "gtok"}),
        FakeResponse({"sub": "unknown-sub", "email": "x@x.test"}),
    ])
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: fake_client)

    client.cookies.set("cafemcp_oauth_login_nonce", "nonce1")
    r = client.get(f"/oauth/login/google/callback?state={txn}.nonce1&code=abc")
    assert r.status_code == 404
    assert "don&#x27;t recognize" in r.text or "don't recognize" in r.text


async def test_google_callback_state_mismatch(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_ID", "gid")
    monkeypatch.setenv("PLATFORM_GOOGLE_CLIENT_SECRET", "gsec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)
    r = client.get(f"/oauth/login/google/callback?state={txn}.wrongnonce&code=abc")
    assert r.status_code == 400
    assert "mismatch" in r.text


# ── Facebook identity sign-in ───────────────────────────────────────────────

async def test_facebook_start_redirect_has_minimal_scopes(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_META_APP_ID", "mid")
    monkeypatch.setenv("PLATFORM_META_APP_SECRET", "msec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)
    r = client.get(f"/oauth/login/facebook/start?txn={txn}", follow_redirects=False)
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://www.facebook.com/v19.0/dialog/oauth")
    assert "public_profile" in loc
    assert "ads_read" not in loc


async def test_facebook_callback_success(app_and_provider, monkeypatch):
    monkeypatch.setenv("PLATFORM_META_APP_ID", "mid")
    monkeypatch.setenv("PLATFORM_META_APP_SECRET", "msec")
    client, provider = app_and_provider
    txn = await _seed_pending(provider)

    async def fake_find(provider_name, provider_user_id):
        assert provider_name == "facebook"
        assert provider_user_id == "fb-id-7"
        return identity_mod.TenantIdentitySession(
            tenant_id="t1", slug="acme", tenant_name="Acme", identity_id="i1", email="o@acme.test")
    monkeypatch.setattr(identity_mod, "find_tenant_by_identity", fake_find)

    fake_client = FakeAsyncClient([
        FakeResponse({"access_token": "ftok"}),      # token exchange
        FakeResponse({"id": "fb-id-7", "email": "o@acme.test"}),  # /me
    ])
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: fake_client)

    client.cookies.set("cafemcp_oauth_login_nonce", "nonce2")
    r = client.get(f"/oauth/login/facebook/callback?state={txn}.nonce2&code=abc", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"].startswith("https://claude.ai/callback?code=")

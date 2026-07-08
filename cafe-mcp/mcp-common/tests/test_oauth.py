"""Unit tests for the OAuth 2.1 bridge (mcp_common.oauth): client
registration, the authorize -> login -> code -> token chain, expiry, and
rejection of unknown/expired transactions — independent of a live server."""
import time

import pytest
from mcp.server.auth.provider import AuthorizationParams, AuthorizeError
from mcp.shared.auth import OAuthClientInformationFull
from pydantic import AnyUrl

from mcp_common.oauth import TenantOAuthProvider
from mcp_common.tenant import TenantContext


def _client(client_id="client-1", redirect="https://example.com/cb", scope=None):
    return OAuthClientInformationFull(
        client_id=client_id,
        redirect_uris=[AnyUrl(redirect)],
        client_name="test client",
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="none",
        scope=scope,
    )


def _params(redirect="https://example.com/cb", scopes=None, state="s1"):
    return AuthorizationParams(
        state=state,
        scopes=scopes or ["read", "mutate"],
        redirect_uri=AnyUrl(redirect),
        redirect_uri_provided_explicitly=True,
        code_challenge="challenge",
        resource=None,
    )


def _tenant(slug="acme", scopes=("read", "mutate")):
    return TenantContext(
        tenant_id=f"id-{slug}", slug=slug, scopes=frozenset(scopes),
        settings={}, credentials={},
    )


@pytest.fixture
def provider():
    return TenantOAuthProvider(base_url="http://testserver")


async def test_register_and_get_client(provider):
    client = _client()
    await provider.register_client(client)
    assert await provider.get_client("client-1") is client
    assert await provider.get_client("nope") is None


async def test_authorize_redirects_to_login_page(provider):
    client = _client()
    await provider.register_client(client)
    url = await provider.authorize(client, _params())
    assert url.startswith("http://testserver/oauth/login?txn=")
    txn = url.split("txn=")[1]
    assert provider.peek_pending(txn) is not None


async def test_unknown_txn_rejected(provider):
    assert provider.peek_pending("does-not-exist") is None
    with pytest.raises(AuthorizeError):
        await provider.complete_login("does-not-exist", _tenant())


async def test_full_code_and_token_exchange(provider):
    client = _client()
    await provider.register_client(client)
    url = await provider.authorize(client, _params())
    txn = url.split("txn=")[1]

    redirect = await provider.complete_login(txn, _tenant("acme"))
    assert "code=" in redirect
    assert "state=s1" in redirect
    code_value = redirect.split("code=")[1].split("&")[0]

    # txn consumed — can't be reused
    assert provider.peek_pending(txn) is None

    loaded = await provider.load_authorization_code(client, code_value)
    assert loaded is not None
    assert loaded.subject == "acme"
    assert set(loaded.scopes) == {"read", "mutate"}

    token = await provider.exchange_authorization_code(client, loaded)
    assert token.access_token
    assert token.refresh_token

    access = await provider.load_access_token(token.access_token)
    assert access is not None
    assert access.subject == "acme"

    # code is single-use
    assert await provider.load_authorization_code(client, code_value) is None


async def test_env_fallback_subject(provider):
    from mcp_common.auth import AUTHENTICATED_NO_TENANT
    client = _client()
    await provider.register_client(client)
    url = await provider.authorize(client, _params())
    txn = url.split("txn=")[1]
    redirect = await provider.complete_login(txn, AUTHENTICATED_NO_TENANT)
    code_value = redirect.split("code=")[1].split("&")[0]
    loaded = await provider.load_authorization_code(client, code_value)
    assert loaded.subject == "__env__"


async def test_scope_filtered_by_client_registration(provider):
    client = _client(scope="read")  # client only registered for 'read'
    await provider.register_client(client)
    url = await provider.authorize(client, _params(scopes=["read", "mutate"]))
    txn = url.split("txn=")[1]
    redirect = await provider.complete_login(txn, _tenant(scopes=("read", "mutate")))
    code_value = redirect.split("code=")[1].split("&")[0]
    loaded = await provider.load_authorization_code(client, code_value)
    assert loaded.scopes == ["read"]


async def test_expired_code_rejected(provider):
    client = _client()
    await provider.register_client(client)
    url = await provider.authorize(client, _params())
    txn = url.split("txn=")[1]
    redirect = await provider.complete_login(txn, _tenant())
    code_value = redirect.split("code=")[1].split("&")[0]

    provider.auth_codes[code_value].expires_at = time.time() - 1
    assert await provider.load_authorization_code(client, code_value) is None


async def test_refresh_token_flow(provider):
    client = _client()
    await provider.register_client(client)
    url = await provider.authorize(client, _params())
    txn = url.split("txn=")[1]
    redirect = await provider.complete_login(txn, _tenant())
    code_value = redirect.split("code=")[1].split("&")[0]
    loaded = await provider.load_authorization_code(client, code_value)
    token = await provider.exchange_authorization_code(client, loaded)

    rt = await provider.load_refresh_token(client, token.refresh_token)
    assert rt is not None
    new_token = await provider.exchange_refresh_token(client, rt, [])
    assert new_token.access_token != token.access_token
    assert await provider.load_access_token(new_token.access_token) is not None

"""Unit tests for mcp_common: crypto round-trip, tenant contextvar isolation,
auth providers, rate limiting, validators, error sanitization."""
import asyncio
import re

import pytest

from mcp_common.auth import EnvKeyAuthenticator, AUTHENTICATED_NO_TENANT
from mcp_common.crypto import CredentialCipher, CryptoError, generate_master_key
from mcp_common.errors import safe_error, tool_errors, requires_scope, ScopeDeniedError
from mcp_common.ratelimit import TokenBucket
from mcp_common.tenant import TenantContext, current_tenant, maybe_tenant, tenant_scope, NotAuthenticatedError
from mcp_common.validators import (
    gaql_date, parse_date, validate_date_range, validate_enum, validate_number, validate_text,
)


def _ctx(slug="alpha", scopes=("read",), settings=None):
    return TenantContext(
        tenant_id=f"id-{slug}", slug=slug, scopes=frozenset(scopes),
        settings=settings or {}, credentials={},
    )


# ── crypto ────────────────────────────────────────────────────────────────────

def test_crypto_roundtrip_and_key_versioning():
    k1 = generate_master_key("v1")
    cipher = CredentialCipher(k1)
    key_id, ct = cipher.encrypt(b'{"secret": 1}')
    assert key_id == "v1"
    assert cipher.decrypt(key_id, ct) == b'{"secret": 1}'

    # add a v2 key at the front: new encrypts use v2, old v1 still decrypts
    k2 = generate_master_key("v2")
    rotated = CredentialCipher(f"{k2},{k1}")
    assert rotated.primary_key_id == "v2"
    assert rotated.decrypt("v1", ct) == b'{"secret": 1}'
    kid2, ct2 = rotated.encrypt(b"x")
    assert kid2 == "v2"

    with pytest.raises(CryptoError):
        rotated.decrypt("v9", ct)


def test_crypto_requires_key():
    with pytest.raises(CryptoError):
        CredentialCipher("")


# ── tenant context ────────────────────────────────────────────────────────────

def test_tenant_scope_set_and_reset():
    assert maybe_tenant() is None
    with tenant_scope(_ctx("alpha")):
        assert current_tenant().slug == "alpha"
    assert maybe_tenant() is None
    with pytest.raises(NotAuthenticatedError):
        current_tenant()


async def test_concurrent_tenant_isolation():
    """The critical multi-tenant test: concurrent tasks under different
    tenant contexts must never observe each other's tenant."""
    observed = {}

    async def work(slug):
        with tenant_scope(_ctx(slug)):
            await asyncio.sleep(0.01)
            observed[slug] = current_tenant().slug
            await asyncio.sleep(0.01)
            assert current_tenant().slug == slug

    await asyncio.gather(*(work(s) for s in ("a", "b", "c", "d")))
    assert observed == {"a": "a", "b": "b", "c": "c", "d": "d"}


# ── auth ──────────────────────────────────────────────────────────────────────

async def test_env_key_authenticator(monkeypatch):
    monkeypatch.setenv("MCP_API_KEYS", "goodkey1, goodkey2")
    auth = EnvKeyAuthenticator()
    assert auth.configured
    assert await auth.authenticate("goodkey1") is AUTHENTICATED_NO_TENANT
    assert await auth.authenticate("goodkey2") is AUTHENTICATED_NO_TENANT
    assert await auth.authenticate("badkey") is None
    assert await auth.authenticate("") is None


async def test_env_key_authenticator_unconfigured(monkeypatch):
    monkeypatch.delenv("MCP_API_KEYS", raising=False)
    auth = EnvKeyAuthenticator()
    assert not auth.configured
    assert await auth.authenticate("anything") is None


# ── scopes ────────────────────────────────────────────────────────────────────

async def test_requires_scope_denies_read_only_key():
    @requires_scope("mutate")
    async def dangerous():
        return "did it"

    with tenant_scope(_ctx(scopes=("read",))):
        with pytest.raises(ScopeDeniedError):
            await dangerous()

    with tenant_scope(_ctx(scopes=("read", "mutate"))):
        assert await dangerous() == "did it"

    # env-fallback mode (no tenant): gate is a no-op
    assert await dangerous() == "did it"


async def test_tool_errors_shapes_scope_denial():
    @tool_errors(context="testing")
    @requires_scope("mutate")
    async def str_tool() -> str:
        return "ok"

    with tenant_scope(_ctx(scopes=("read",))):
        msg = await str_tool()
        assert "permission" in msg


# ── error sanitization ────────────────────────────────────────────────────────

def test_safe_error_hides_detail_and_gives_ref():
    msg = safe_error(RuntimeError("secret_token=abc123 exploded"), "fetching data")
    assert "secret_token" not in msg
    assert "abc123" not in msg
    assert re.search(r"ref: [0-9a-f]{8}", msg)
    assert "fetching data" in msg


async def test_tool_errors_catches_and_sanitizes():
    @tool_errors(context="doing the thing")
    async def boom() -> str:
        raise RuntimeError("internal deets")

    msg = await boom()
    assert "internal deets" not in msg
    assert "ref:" in msg


async def test_tool_errors_timeout():
    @tool_errors(context="slow", timeout_s=0.05)
    async def slow() -> str:
        await asyncio.sleep(1)
        return "never"

    msg = await slow()
    assert "timed out" in msg


# ── rate limiting ─────────────────────────────────────────────────────────────

def test_token_bucket_burst_then_block():
    tb = TokenBucket(rate_per_min=60, burst=3)
    assert all(tb.allow("k") for _ in range(3))
    assert not tb.allow("k")
    assert tb.allow("other")  # independent keys


# ── validators ────────────────────────────────────────────────────────────────

def test_validators():
    assert parse_date("2025-05-01").month == 5
    with pytest.raises(ValueError):
        parse_date("not-a-date")
    with pytest.raises(ValueError):
        parse_date("1999-01-01")  # before min
    with pytest.raises(ValueError):
        validate_date_range("2025-05-02", "2025-05-01")
    with pytest.raises(ValueError):
        validate_date_range("2020-01-01", "2025-01-01")  # too long
    assert validate_enum("a", {"a", "b"}, "x") == "a"
    with pytest.raises(ValueError):
        validate_enum("c", {"a", "b"}, "x")
    with pytest.raises(ValueError):
        validate_text("x" * 501, "notes")
    with pytest.raises(ValueError):
        validate_number(999, "wage", 0, 500)


def test_gaql_date_rejects_strings():
    import datetime
    assert gaql_date(datetime.date(2025, 5, 1)) == "2025-05-01"
    with pytest.raises(ValueError):
        gaql_date("2025-05-01' OR 1=1 --")

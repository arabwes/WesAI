"""Integration tests for TenancyMiddleware over a toy ASGI app: auth 401s,
health-path exemption, rate limiting, body cap, and refusal to start open."""
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from mcp_common.middleware import TenancyMiddleware
from mcp_common.tenant import maybe_tenant


def make_app(monkeypatch, keys="testkey", rate_per_min=6000, burst=50):
    if keys is None:
        monkeypatch.delenv("MCP_API_KEYS", raising=False)
    else:
        monkeypatch.setenv("MCP_API_KEYS", keys)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    async def echo_tenant(request):
        t = maybe_tenant()
        return JSONResponse({"tenant": t.slug if t else None})

    async def health(request):
        return JSONResponse({"status": "ok"})

    inner = Starlette(routes=[
        Route("/", health),
        Route("/mcp", echo_tenant, methods=["GET", "POST"]),
    ])
    return TenancyMiddleware(inner, rate_per_min=rate_per_min, burst=burst)


def test_missing_token_401(monkeypatch):
    client = TestClient(make_app(monkeypatch))
    r = client.get("/mcp")
    assert r.status_code == 401
    assert r.headers.get("www-authenticate") == "Bearer"


def test_bad_token_401(monkeypatch):
    client = TestClient(make_app(monkeypatch))
    r = client.get("/mcp", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_good_token_env_mode_no_tenant(monkeypatch):
    client = TestClient(make_app(monkeypatch))
    r = client.get("/mcp", headers={"Authorization": "Bearer testkey"})
    assert r.status_code == 200
    assert r.json() == {"tenant": None}  # env-fallback: authenticated, no tenant row


def test_health_path_open(monkeypatch):
    client = TestClient(make_app(monkeypatch))
    assert client.get("/").status_code == 200


def test_rate_limit_429(monkeypatch):
    client = TestClient(make_app(monkeypatch, rate_per_min=1, burst=2))
    h = {"Authorization": "Bearer testkey"}
    assert client.get("/mcp", headers=h).status_code == 200
    assert client.get("/mcp", headers=h).status_code == 200
    assert client.get("/mcp", headers=h).status_code == 429


def test_body_cap_413(monkeypatch):
    client = TestClient(make_app(monkeypatch))
    r = client.post(
        "/mcp",
        headers={"Authorization": "Bearer testkey", "Content-Length": "2000000"},
        content=b"",
    )
    assert r.status_code == 413


def test_refuses_to_start_without_auth(monkeypatch):
    monkeypatch.delenv("MCP_ALLOW_ANONYMOUS", raising=False)
    with pytest.raises(RuntimeError, match="Refusing to start"):
        make_app(monkeypatch, keys=None)


def test_anonymous_opt_in(monkeypatch):
    monkeypatch.setenv("MCP_ALLOW_ANONYMOUS", "true")
    client = TestClient(make_app(monkeypatch, keys=None))
    assert client.get("/mcp").status_code == 200

"""ASGI middleware: rate-limit -> authenticate -> set tenant contextvar.

Pipeline per request (except the health path):
  1. Reject bodies over MAX_BODY_BYTES.
  2. Rate-limit by API-key hash.
  3. Authenticate via ChainAuthenticator (env keys, then tenant DB).
  4. Set the tenant contextvar for downstream tools; reset afterwards.

If NO auth provider is configured (no MCP_API_KEYS and no DATABASE_URL) the
middleware refuses to start rather than silently running an open server. Set
MCP_ALLOW_ANONYMOUS=true to explicitly opt into the old open behavior (dev only).
"""
from __future__ import annotations

import hashlib
import logging
import os

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from mcp_common.auth import default_authenticator, EnvKeyAuthenticator
from mcp_common.db import db_configured
from mcp_common.ratelimit import TokenBucket
from mcp_common.tenant import tenant_scope

logger = logging.getLogger("mcp.middleware")

MAX_BODY_BYTES = 1_000_000
HEALTH_PATHS = {"/", "/health"}


class TenancyMiddleware:
    def __init__(self, app: ASGIApp, rate_per_min: float = 60.0, burst: int = 20):
        self.app = app
        self.authenticator = default_authenticator()
        self.bucket = TokenBucket(rate_per_min, burst)
        env_configured = EnvKeyAuthenticator().configured
        if not env_configured and not db_configured():
            if os.getenv("MCP_ALLOW_ANONYMOUS", "").lower() == "true":
                logger.warning("AUTH DISABLED (MCP_ALLOW_ANONYMOUS=true) — dev mode only")
                self.open_mode = True
            else:
                raise RuntimeError(
                    "Refusing to start without authentication: set MCP_API_KEYS or "
                    "DATABASE_URL (or MCP_ALLOW_ANONYMOUS=true for local dev)."
                )
        else:
            self.open_mode = False

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] != "http" or scope["path"] in HEALTH_PATHS:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        content_length = headers.get(b"content-length")
        if content_length and int(content_length) > MAX_BODY_BYTES:
            await JSONResponse({"error": "request too large"}, status_code=413)(scope, receive, send)
            return

        if self.open_mode:
            await self.app(scope, receive, send)
            return

        auth = headers.get(b"authorization", b"").decode()
        if not auth.lower().startswith("bearer "):
            await JSONResponse(
                {"error": "missing bearer token"}, status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
            return
        bearer = auth[7:].strip()

        rl_key = hashlib.sha256(bearer.encode()).hexdigest()[:16]
        if not self.bucket.allow(rl_key):
            await JSONResponse({"error": "rate limit exceeded"}, status_code=429)(scope, receive, send)
            return

        ctx = await self.authenticator.authenticate(bearer)
        if ctx is None:
            await JSONResponse(
                {"error": "invalid or revoked API key"}, status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
            return

        from mcp_common.auth import AUTHENTICATED_NO_TENANT
        effective = None if ctx is AUTHENTICATED_NO_TENANT else ctx
        with tenant_scope(effective):
            await self.app(scope, receive, send)

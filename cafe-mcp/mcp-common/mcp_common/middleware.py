"""ASGI middleware: rate-limit -> authenticate -> set tenant contextvar.

Pipeline per request (except the health and OAuth-flow paths):
  1. Reject bodies over MAX_BODY_BYTES.
  2. Rate-limit by API-key hash.
  3. Authenticate via ChainAuthenticator (env keys, tenant DB keys, then
     OAuth-issued tokens if an OAuth provider is configured).
  4. Set the tenant contextvar for downstream tools; reset afterwards.

OAUTH_EXEMPT_PATHS are the OAuth 2.1 wire-protocol endpoints (metadata,
authorize, token, register, revoke) plus our own /oauth/login pages — these
must be reachable WITHOUT an existing bearer token, since going through them
is how a client obtains one in the first place.

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
# Public product/compliance pages + healthcheck: reachable anonymously by
# design (Google/Meta reviewers must be able to load them).
HEALTH_PATHS = {"/", "/health", "/privacy", "/terms", "/data-deletion"}
OAUTH_EXEMPT_PATHS = {
    "/authorize", "/token", "/register", "/revoke",
    "/oauth/login", "/oauth/login/submit",
}


def _is_oauth_exempt(path: str) -> bool:
    # Well-known routes are mounted MCP-path-scoped (e.g.
    # /.well-known/oauth-protected-resource/mcp), so match by prefix.
    return path in OAUTH_EXEMPT_PATHS or path.startswith("/.well-known/")


class TenancyMiddleware:
    def __init__(self, app: ASGIApp, rate_per_min: float = 60.0, burst: int = 20,
                 oauth_provider=None, onboarding_enabled: bool | None = None):
        self.app = app
        self.oauth_provider = oauth_provider
        self.onboarding_enabled = (
            db_configured() if onboarding_enabled is None else onboarding_enabled
        )
        self.authenticator = default_authenticator(oauth_provider)
        self.bucket = TokenBucket(rate_per_min, burst)
        # Separate, stricter bucket for the keyless public onboarding pages,
        # keyed by client IP.
        self.onboard_bucket = TokenBucket(rate_per_min=30, burst=10)
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
        path = scope.get("path", "")
        if scope["type"] != "http" or path in HEALTH_PATHS:
            await self.app(scope, receive, send)
            return
        if self.oauth_provider is not None and _is_oauth_exempt(path):
            await self.app(scope, receive, send)
            return
        if self.onboarding_enabled and path.startswith("/onboard"):
            # Keyless public surface: link tokens are the credential; add an
            # IP-keyed rate limit in front.
            client = scope.get("client")
            ip = client[0] if client else "unknown"
            if not self.onboard_bucket.allow(f"ob:{ip}"):
                await JSONResponse({"error": "rate limit exceeded"}, status_code=429)(scope, receive, send)
                return
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

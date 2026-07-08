"""Bearer-token authentication.

Two providers behind one interface, so OAuth 2.1 can be added later as a
third implementation of `authenticate(request) -> TenantContext | None`:

- EnvKeyAuthenticator: static keys from MCP_API_KEYS (single-tenant mode).
  Returns AUTHENTICATED_NO_TENANT on success (env-fallback config applies).
- DbKeyAuthenticator: keys resolved against the tenant store (multi-tenant).

A request is authenticated if EITHER provider accepts it, letting the env
key act as a break-glass credential during and after migration.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os

from mcp_common.tenant import TenantContext

logger = logging.getLogger("mcp.auth")

# Sentinel: request authenticated by a static env key; no tenant row exists,
# so config falls back to environment variables.
AUTHENTICATED_NO_TENANT = TenantContext(
    tenant_id="__env__", slug="__env__",
    scopes=frozenset({"read", "mutate"}),
    settings={}, credentials={},
)


class EnvKeyAuthenticator:
    def __init__(self, env_var: str = "MCP_API_KEYS"):
        raw = os.getenv(env_var, "")
        self._digests = [
            hashlib.sha256(k.strip().encode()).digest()
            for k in raw.split(",") if k.strip()
        ]

    @property
    def configured(self) -> bool:
        return bool(self._digests)

    async def authenticate(self, bearer: str) -> TenantContext | None:
        candidate = hashlib.sha256(bearer.encode()).digest()
        for digest in self._digests:
            if hmac.compare_digest(candidate, digest):
                return AUTHENTICATED_NO_TENANT
        return None


class DbKeyAuthenticator:
    def __init__(self):
        self._cipher = None

    def _get_cipher(self):
        if self._cipher is None:
            from mcp_common.crypto import CredentialCipher
            self._cipher = CredentialCipher()
        return self._cipher

    async def authenticate(self, bearer: str) -> TenantContext | None:
        from mcp_common.db import db_configured
        from mcp_common.store import resolve_api_key
        if not db_configured():
            return None
        try:
            return await resolve_api_key(bearer, self._get_cipher())
        except Exception as e:
            logger.error("DB auth lookup failed: %r", e)
            return None


class OAuthTokenAuthenticator:
    """Validates access tokens issued by the OAuth bridge (mcp_common.oauth)
    for OAuth-only client UIs, and maps them back to a TenantContext."""

    def __init__(self, provider):
        self._provider = provider  # TenantOAuthProvider, or None if OAuth is disabled

    async def authenticate(self, bearer: str) -> TenantContext | None:
        if self._provider is None:
            return None
        access = await self._provider.load_access_token(bearer)
        if access is None:
            return None
        if access.subject == "__env__":
            return AUTHENTICATED_NO_TENANT
        from mcp_common.db import db_configured
        if not db_configured():
            return None
        from mcp_common.crypto import CredentialCipher
        from mcp_common.store import load_tenant_by_slug
        try:
            return await load_tenant_by_slug(access.subject, frozenset(access.scopes), CredentialCipher())
        except Exception as e:
            logger.error("OAuth token tenant resolution failed: %r", e)
            return None


class ChainAuthenticator:
    def __init__(self, *providers):
        self.providers = providers

    async def authenticate(self, bearer: str) -> TenantContext | None:
        for p in self.providers:
            ctx = await p.authenticate(bearer)
            if ctx is not None:
                return ctx
        return None


def default_authenticator(oauth_provider=None) -> ChainAuthenticator:
    providers = [EnvKeyAuthenticator(), DbKeyAuthenticator()]
    if oauth_provider is not None:
        providers.append(OAuthTokenAuthenticator(oauth_provider))
    return ChainAuthenticator(*providers)

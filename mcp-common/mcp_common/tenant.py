"""Per-request tenant context, propagated via contextvars.

The middleware sets the context for each authenticated request; tools and
clients read it through current_tenant() / maybe_tenant(). When no tenant is
set (single-tenant env-fallback mode), maybe_tenant() returns None and
config falls back to environment variables.
"""
from __future__ import annotations

import contextlib
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Mapping


class NotAuthenticatedError(Exception):
    """Raised when tenant context is required but no request context is set."""


@dataclass(frozen=True)
class TenantContext:
    tenant_id: str
    slug: str
    scopes: frozenset[str]
    settings: Mapping[str, Any]
    credentials: Mapping[str, Mapping[str, Any]]  # service -> decrypted secret bundle
    api_key_id: str | None = None

    def credential(self, service: str) -> Mapping[str, Any] | None:
        return self.credentials.get(service)

    def setting(self, key: str, default: Any = None) -> Any:
        return self.settings.get(key, default)


_current: ContextVar[TenantContext | None] = ContextVar("wesai_tenant", default=None)


def current_tenant() -> TenantContext:
    ctx = _current.get()
    if ctx is None:
        raise NotAuthenticatedError("No tenant context set for this request")
    return ctx


def maybe_tenant() -> TenantContext | None:
    return _current.get()


@contextlib.contextmanager
def tenant_scope(ctx: TenantContext | None):
    """Set the tenant context for the duration of a block (used by middleware and tests)."""
    token = _current.set(ctx)
    try:
        yield ctx
    finally:
        _current.reset(token)

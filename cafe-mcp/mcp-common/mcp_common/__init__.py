"""Shared multi-tenant infrastructure for the WesAI MCP servers.

Provides: bearer-key authentication, per-request tenant context (contextvars),
encrypted per-tenant credential storage (Postgres + Fernet), audit logging,
rate limiting, input validators, and sanitized error handling.

Servers depend on this package; it never imports from the servers.
"""

from mcp_common.tenant import TenantContext, current_tenant, tenant_scope
from mcp_common.errors import safe_error, tool_errors, requires_scope

__all__ = [
    "TenantContext",
    "current_tenant",
    "tenant_scope",
    "safe_error",
    "tool_errors",
    "requires_scope",
]

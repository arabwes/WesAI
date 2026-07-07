"""Sanitized error handling and scope enforcement for MCP tools.

safe_error() logs the full exception server-side under a correlation ID and
returns a generic message safe to show any caller. tool_errors() wraps an
async tool so uncaught exceptions and timeouts become sanitized strings.
requires_scope() gates mutating tools on the caller's API-key scopes.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import uuid

from mcp_common.tenant import maybe_tenant

logger = logging.getLogger("mcp.errors")

DEFAULT_TOOL_TIMEOUT_S = 60.0


def safe_error(exc: BaseException, context: str = "") -> str:
    """Log exc with a correlation ID; return a caller-safe message."""
    ref = uuid.uuid4().hex[:8]
    tenant = maybe_tenant()
    logger.error(
        "ref=%s tenant=%s context=%s error=%r",
        ref, tenant.slug if tenant else "-", context or "-", exc,
        exc_info=exc,
    )
    what = context or "completing the operation"
    return f"An internal error occurred while {what}. (ref: {ref})"


class ScopeDeniedError(Exception):
    pass


def tool_errors(context: str = "", timeout_s: float = DEFAULT_TOOL_TIMEOUT_S):
    """Wrap an async tool: enforce a timeout and sanitize uncaught exceptions.

    Tools that return dicts get {"error": msg}; string tools get the message.
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            label = context or fn.__name__.replace("_", " ")
            try:
                return await asyncio.wait_for(fn(*args, **kwargs), timeout=timeout_s)
            except ScopeDeniedError as e:
                return _shaped(fn, str(e))
            except asyncio.TimeoutError:
                return _shaped(fn, f"The operation timed out after {int(timeout_s)}s. Try a narrower date range.")
            except Exception as e:
                return _shaped(fn, safe_error(e, label))
        return wrapper
    return decorator


def _shaped(fn, message: str):
    """Match the tool's documented return shape (dict tools vs str tools)."""
    ret = getattr(fn, "__annotations__", {}).get("return")
    if ret in (dict, "dict"):
        return {"error": message}
    return message


def requires_scope(scope: str):
    """Gate a tool on an API-key/tenant scope. In env-fallback (single-tenant)
    mode there is no tenant context and the gate is a no-op — the deployment
    owner holds the only key."""
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            tenant = maybe_tenant()
            if tenant is not None and scope not in tenant.scopes:
                from mcp_common.audit import audit_denied
                await audit_denied(fn.__name__, scope)
                raise ScopeDeniedError(
                    f"This operation requires the '{scope}' permission, which is not "
                    "enabled for your API key. Contact your administrator."
                )
            return await fn(*args, **kwargs)
        return wrapper
    return decorator

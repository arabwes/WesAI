"""FastMCP tool-call middleware: audits every invocation to the audit_log table."""
from __future__ import annotations

import time
import uuid

from fastmcp.server.middleware import Middleware, MiddlewareContext

from mcp_common.audit import record


class AuditMiddleware(Middleware):
    async def on_call_tool(self, context: MiddlewareContext, call_next):
        tool = context.message.name
        args = dict(context.message.arguments or {})
        started = time.monotonic()
        correlation_id = uuid.uuid4().hex[:8]
        try:
            result = await call_next(context)
        except Exception:
            await record(tool, args, "error", correlation_id,
                         int((time.monotonic() - started) * 1000))
            raise
        await record(tool, args, "ok", correlation_id,
                     int((time.monotonic() - started) * 1000))
        return result

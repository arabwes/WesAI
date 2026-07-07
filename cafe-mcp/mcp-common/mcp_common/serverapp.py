"""Shared server bootstrap: wraps a FastMCP instance in the tenancy/auth ASGI
middleware, registers audit middleware, and runs uvicorn.

Usage from a server's main.py:

    from mcp_common.serverapp import run_server
    run_server(mcp, server_name="financial", port=config.port)
"""
from __future__ import annotations

import logging

from mcp_common import audit
from mcp_common.fastmcp_audit import AuditMiddleware
from mcp_common.middleware import TenancyMiddleware

logger = logging.getLogger("mcp.serverapp")


def build_app(mcp, server_name: str):
    audit.configure(server_name)
    mcp.add_middleware(AuditMiddleware())
    app = mcp.http_app()
    return TenancyMiddleware(app)


def run_server(mcp, server_name: str, port: int, host: str = "0.0.0.0"):
    import uvicorn
    app = build_app(mcp, server_name)
    logger.info("Starting %s MCP server on %s:%d (auth enforced)", server_name, host, port)
    uvicorn.run(app, host=host, port=port, timeout_keep_alive=30)

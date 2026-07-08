"""Shared server bootstrap: wraps a FastMCP instance in the tenancy/auth ASGI
middleware, registers audit middleware, optionally mounts an OAuth 2.1
bridge (for OAuth-only client UIs like Claude.ai's connector picker), and
runs uvicorn.

Usage from a server's main.py:

    from mcp_common.serverapp import run_server
    run_server(mcp, server_name="cafe-mcp", port=config.port)

Set OAUTH_PUBLIC_URL (the server's own public HTTPS URL, e.g.
https://cafe-mcp-production.up.railway.app) to enable the OAuth bridge.
Without it, only bearer-token auth (MCP_API_KEYS / tenant DB keys) works —
fine for clients that support a custom Authorization header.
"""
from __future__ import annotations

import logging
import os

from mcp_common import audit
from mcp_common.fastmcp_audit import AuditMiddleware
from mcp_common.middleware import TenancyMiddleware

logger = logging.getLogger("mcp.serverapp")


def build_app(mcp, server_name: str, mcp_path: str = "/mcp"):
    audit.configure(server_name)
    mcp.add_middleware(AuditMiddleware())

    oauth_provider = None
    public_url = os.getenv("OAUTH_PUBLIC_URL", "").strip()
    if public_url:
        from mcp_common.oauth import TenantOAuthProvider, register_login_routes
        oauth_provider = TenantOAuthProvider(base_url=public_url)
        register_login_routes(mcp, oauth_provider)
        logger.info("OAuth bridge enabled at %s (for OAuth-only client UIs)", public_url)

    # FastMCP's DNS-rebinding Host-header check is redundant behind our own
    # bearer-auth middleware and rejects Railway's proxy/healthcheck Host
    # header with 421 Misdirected Request. TenancyMiddleware is the actual
    # access control here, so disable FastMCP's own layer. auth= is
    # deliberately NOT passed to FastMCP itself — that would add FastMCP's
    # own Bearer-only gate in front of /mcp, which doesn't recognize our
    # static wes_ keys and would break non-OAuth clients.
    app = mcp.http_app(path=mcp_path, host_origin_protection=False)

    if oauth_provider is not None:
        for route in oauth_provider.get_routes(mcp_path=mcp_path):
            app.router.routes.append(route)

    return TenancyMiddleware(app, oauth_provider=oauth_provider)


def run_server(mcp, server_name: str, port: int, host: str = "0.0.0.0"):
    import uvicorn
    app = build_app(mcp, server_name)
    logger.info("Starting %s MCP server on %s:%d (auth enforced)", server_name, host, port)
    uvicorn.run(app, host=host, port=port, timeout_keep_alive=30)

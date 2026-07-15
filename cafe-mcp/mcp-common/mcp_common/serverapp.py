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
import pathlib

from mcp_common import audit
from mcp_common.fastmcp_audit import AuditMiddleware
from mcp_common.middleware import TenancyMiddleware

logger = logging.getLogger("mcp.serverapp")

# cafe-mcp/mcp-common/mcp_common/serverapp.py -> cafe-mcp/CafeMCP.com/
BRAND_DIR = pathlib.Path(__file__).resolve().parent.parent.parent / "CafeMCP.com"


def build_app(mcp, server_name: str, mcp_path: str = "/mcp"):
    audit.configure(server_name)
    mcp.add_middleware(AuditMiddleware())

    from mcp_common.db import db_configured as _db_configured
    from mcp_common.publicsite import register_public_pages
    register_public_pages(mcp)

    onboarding_enabled = _db_configured()
    if onboarding_enabled:
        from mcp_common.onboarding.routes import register_onboarding_routes
        register_onboarding_routes(mcp)
        logger.info("Onboarding portal enabled at /onboard")

        from mcp_common.onboarding.login_flow import register_login_page_routes
        register_login_page_routes(mcp)
        from mcp_common.portal.routes import register_portal_routes
        register_portal_routes(mcp)
        logger.info("Tenant sign-in enabled at /login (portal at /portal)")

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

    if BRAND_DIR.is_dir():
        from starlette.routing import Mount
        from starlette.staticfiles import StaticFiles
        app.router.routes.append(
            Mount("/CafeMCP.com", app=StaticFiles(directory=str(BRAND_DIR)), name="brand")
        )
    else:
        logger.warning("CafeMCP.com brand folder not found at %s — pages will render without theme.css", BRAND_DIR)

    return TenancyMiddleware(app, oauth_provider=oauth_provider,
                             onboarding_enabled=onboarding_enabled)


def run_server(mcp, server_name: str, port: int, host: str = "0.0.0.0"):
    import asyncio
    import uvicorn

    from mcp_common.db import db_configured

    if db_configured():
        from mcp_common.db import close_pool
        from mcp_common.migrate import migrate_on_startup

        async def _migrate_then_close():
            await migrate_on_startup()
            # The pool just created is bound to THIS throwaway event loop;
            # uvicorn will run its own loop next, so close it here and let
            # get_pool() lazily create a fresh one bound to that loop.
            await close_pool()

        logger.info("DATABASE_URL is set — running schema migrations before startup...")
        asyncio.run(_migrate_then_close())
    else:
        logger.info("DATABASE_URL not set — running in single-tenant env-fallback mode, no migration needed.")

    app = build_app(mcp, server_name)
    logger.info("Starting %s MCP server on %s:%d (auth enforced)", server_name, host, port)
    uvicorn.run(app, host=host, port=port, timeout_keep_alive=30)

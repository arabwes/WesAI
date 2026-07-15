"""Session-authenticated tenant portal (/portal). Read-only connection
status, access-key generation, and sign-out. "Manage connections" hands off
to the existing, already-tested /onboard flow via a freshly minted,
short-lived, single-use link — no duplication of the connect/save forms.
"""
from __future__ import annotations

import logging
import os
import secrets

from mcp_common import audit, identity, store
from mcp_common.onboarding import links
from mcp_common.onboarding.login_flow import SESSION_COOKIE
from mcp_common.onboarding.routes import CSRF_COOKIE, _csrf_ok
from mcp_common.portal import html as pages

logger = logging.getLogger("mcp.portal")


async def _portal_session(request):
    raw = request.cookies.get(SESSION_COOKIE, "")
    return await identity.verify_session(raw)


def register_portal_routes(mcp) -> None:
    from starlette.requests import Request
    from starlette.responses import RedirectResponse

    @mcp.custom_route("/portal", methods=["GET"])
    async def portal_dashboard(request: Request):
        sess = await _portal_session(request)
        if sess is None:
            return RedirectResponse("/login", status_code=303)
        csrf = request.cookies.get(CSRF_COOKIE) or secrets.token_urlsafe(24)
        connected = await store.credential_services(sess.slug)
        settings = await store.get_settings(sess.slug)
        notice = {
            "generated": None,  # handled by the dedicated key page instead
        }.get(request.query_params.get("notice", ""))
        resp = pages.dashboard(sess, csrf, connected, settings, notice)
        resp.set_cookie(CSRF_COOKIE, csrf, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https")
        return resp

    @mcp.custom_route("/portal/manage", methods=["POST"])
    async def portal_manage(request: Request):
        form = await request.form()
        sess = await _portal_session(request)
        if sess is None:
            return RedirectResponse("/login", status_code=303)
        if not _csrf_ok(form, request):
            return RedirectResponse("/portal", status_code=303)
        raw_link = await links.mint_link(sess.slug, ttl_days=1)
        await audit.record("portal.manage_link_minted", {"tenant": sess.slug}, "ok")
        return RedirectResponse(f"/onboard?t={raw_link}", status_code=303)

    @mcp.custom_route("/portal/generate-key", methods=["POST"])
    async def portal_generate_key(request: Request):
        form = await request.form()
        sess = await _portal_session(request)
        if sess is None:
            return RedirectResponse("/login", status_code=303)
        if not _csrf_ok(form, request):
            return RedirectResponse("/portal", status_code=303)
        label = str(form.get("label", "")).strip()[:100] or "portal"
        api_key = await store.create_api_key(sess.slug, ["read"], label)
        await audit.record("portal.generate_key", {"tenant": sess.slug, "label": label}, "ok")
        base = os.getenv("OAUTH_PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip("/")
        return pages.key_generated(sess, api_key, f"{base}/mcp")

    @mcp.custom_route("/portal/logout", methods=["POST"])
    async def portal_logout(request: Request):
        form = await request.form()
        raw_session = request.cookies.get(SESSION_COOKIE, "")
        # No CSRF-cookie-present case still allowed to log out (fail open on
        # logout specifically — refusing to let someone sign out is worse
        # than a low-value CSRF-triggered logout).
        await identity.revoke_session(raw_session)
        await audit.record("portal.logout", {}, "ok")
        resp = RedirectResponse("/", status_code=303)
        resp.delete_cookie(SESSION_COOKIE, path="/")
        return resp

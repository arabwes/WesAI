"""Onboarding portal routes.

Every handler re-verifies the one-time link token (generic 404 for
bad/expired/completed — no oracle) and, on POSTs, the CSRF double-submit
cookie. Saved secrets are audited (redacted) and never echoed back.
"""
from __future__ import annotations

import logging
import secrets

from mcp_common import audit
from mcp_common.crypto import CredentialCipher
from mcp_common.onboarding import html as pages
from mcp_common.onboarding import links
from mcp_common import store

logger = logging.getLogger("mcp.onboarding")

CSRF_COOKIE = "onboard_csrf"


def _csrf_ok(form, request) -> bool:
    sent = str(form.get("csrf", ""))
    cookie = request.cookies.get(CSRF_COOKIE, "")
    return bool(sent) and secrets.compare_digest(sent, cookie)


async def _session_or_none(request, form=None):
    raw = str((form or request.query_params).get("t", ""))
    session = await links.verify_token(raw)
    return raw, session


def register_onboarding_routes(mcp) -> None:
    from starlette.requests import Request
    from starlette.responses import RedirectResponse

    def _redirect_back(token: str, notice: str):
        # Post/Redirect/Get with a short status notice
        resp = RedirectResponse(f"/onboard?t={token}&notice={notice}", status_code=303)
        return resp

    @mcp.custom_route("/onboard", methods=["GET"])
    async def onboard_dashboard(request: Request):
        raw, session = await _session_or_none(request)
        if session is None:
            return pages.dead_link_page()
        csrf = request.cookies.get(CSRF_COOKIE) or secrets.token_urlsafe(24)
        connected = await store.credential_services(session.slug)
        settings = await store.get_settings(session.slug)
        notice = {
            "toast": "Toast credentials saved.",
            "wheniwork": "When I Work credentials saved.",
            "business": "Business details saved.",
            "google": "Google connected.",
            "google_ads": "Google Ads connected.",
            "meta": "Facebook connected.",
        }.get(request.query_params.get("notice", ""))
        resp = pages.dashboard(session, raw, csrf, connected, settings, notice)
        resp.set_cookie(CSRF_COOKIE, csrf, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https")
        return resp

    async def _form_handler(request: Request, handler):
        form = await request.form()
        raw, session = await _session_or_none(request, form)
        if session is None:
            return pages.dead_link_page()
        if not _csrf_ok(form, request):
            return pages.error_page("Your session expired — please try again.",
                                    back_href=f"/onboard?t={raw}")
        try:
            return await handler(raw, session, form)
        except ValueError as e:
            return pages.error_page(str(e), back_href=f"/onboard?t={raw}")
        except Exception:
            logger.exception("onboarding form save failed (tenant=%s)", session.slug)
            return pages.error_page("Could not save — please try again or contact your operator.",
                                    back_href=f"/onboard?t={raw}")

    @mcp.custom_route("/onboard/toast", methods=["POST"])
    async def onboard_toast(request: Request):
        async def save(raw, session, form):
            bundle = {
                "client_id": str(form.get("client_id", "")).strip(),
                "client_secret": str(form.get("client_secret", "")).strip(),
                "restaurant_guid": str(form.get("restaurant_guid", "")).strip(),
                "environment": "production",
            }
            if not all(bundle.values()):
                raise ValueError("All Toast fields are required.")
            verify_error = await _verify_toast(bundle)
            if verify_error:
                raise ValueError(verify_error)
            await store.set_credential(session.slug, "toast", bundle, CredentialCipher())
            await store.set_settings(session.slug, {"toast_api_pending": False})
            await audit.record("onboarding.set_credential", {"service": "toast", "tenant": session.slug}, "ok")
            return _redirect_back(raw, "toast")
        return await _form_handler(request, save)

    @mcp.custom_route("/onboard/wheniwork", methods=["POST"])
    async def onboard_wheniwork(request: Request):
        async def save(raw, session, form):
            bundle = {
                "api_key": str(form.get("api_key", "")).strip(),
                "account_id": str(form.get("account_id", "")).strip(),
            }
            if not all(bundle.values()):
                raise ValueError("Both When I Work fields are required.")
            await store.set_credential(session.slug, "wheniwork", bundle, CredentialCipher())
            await audit.record("onboarding.set_credential", {"service": "wheniwork", "tenant": session.slug}, "ok")
            return _redirect_back(raw, "wheniwork")
        return await _form_handler(request, save)

    @mcp.custom_route("/onboard/business", methods=["POST"])
    async def onboard_business(request: Request):
        async def save(raw, session, form):
            patch = {}
            for key in ("business_name", "gmail_address", "sheets_inventory_id", "sheets_ledger_id"):
                value = str(form.get(key, "")).strip()
                if value:
                    if len(value) > 300:
                        raise ValueError(f"{key} is too long.")
                    patch[key] = value
            vendors = {}
            for line in str(form.get("vendor_domains", "")).splitlines():
                line = line.strip()
                if not line:
                    continue
                if ":" not in line:
                    raise ValueError(f'Vendor line "{line[:40]}" must look like "Name: domain.com".')
                name, domain = line.split(":", 1)
                if name.strip() and domain.strip():
                    vendors[name.strip()] = domain.strip().lower()
            if vendors:
                patch["vendor_domains"] = vendors
            if patch:
                await store.set_settings(session.slug, patch)
                await audit.record("onboarding.set_settings",
                                   {"keys": sorted(patch), "tenant": session.slug}, "ok")
            return _redirect_back(raw, "business")
        return await _form_handler(request, save)

    # OAuth connect flows (render as forms-only if platform apps unset)
    from mcp_common.onboarding.google_flow import register_google_routes
    from mcp_common.onboarding.meta_flow import register_meta_routes
    register_google_routes(mcp)
    register_meta_routes(mcp)

    @mcp.custom_route("/onboard/finish", methods=["POST"])
    async def onboard_finish(request: Request):
        async def save(raw, session, form):
            if not await links.complete(raw):
                return pages.dead_link_page()
            api_key = await store.create_api_key(session.slug, ["read"], "onboarding portal")
            await audit.record("onboarding.finished", {"tenant": session.slug}, "ok")
            import os
            base = os.getenv("OAUTH_PUBLIC_URL", "").rstrip("/") or str(request.base_url).rstrip("/")
            return pages.finished(session, api_key, f"{base}/mcp")
        return await _form_handler(request, save)


async def _verify_toast(bundle: dict) -> str | None:
    """Live-check Toast credentials with a token request; returns an error
    message or None. Network failures don't block the save (the operator
    can retry later) — only a definitive auth rejection does."""
    import httpx
    host = ("https://ws-api.toasttab.com" if bundle["environment"] == "production"
            else "https://ws-sandbox-api.toasttab.com")
    try:
        r = httpx.post(
            f"{host}/authentication/v1/authentication/login",
            json={"clientId": bundle["client_id"], "clientSecret": bundle["client_secret"],
                  "userAccessType": "TOAST_MACHINE_CLIENT"},
            timeout=10,
        )
        if r.status_code in (400, 401, 403):
            return ("Toast rejected these credentials — double-check the Client ID and "
                    "Secret (and that your Toast API access is approved).")
    except Exception:
        logger.warning("Toast live-verify skipped (network error)", exc_info=True)
    return None

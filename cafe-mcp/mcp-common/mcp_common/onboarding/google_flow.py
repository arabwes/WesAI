"""Hosted Google OAuth consent for the onboarding portal.

Two entry points sharing one callback (both also carry the non-sensitive
identity scopes so we can link a sign-in identity for later portal login):
- ads=0: gmail.readonly + spreadsheets  -> 'google' credential bundle
- ads=1: adwords + business.manage      -> 'google_ads' bundle (+ platform
         developer token) and Ads customer-ID discovery/picker

Uses the PLATFORM_GOOGLE_CLIENT_ID/SECRET web OAuth client; the customer's
refresh token is written into the same bundle shapes config.py already
consumes, so nothing downstream changes. Sync google libs run in
asyncio.to_thread.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets

from mcp_common import audit
from mcp_common.crypto import CredentialCipher
from mcp_common.onboarding import html as pages
from mcp_common.onboarding import links
from mcp_common import store

logger = logging.getLogger("mcp.onboarding.google")

# Non-sensitive identity scopes, included in every flow (not just /login)
# so we can always resolve a stable user id (sub) + email — used both for
# gmail_address autofill and for linking the sign-in identity that lets
# this tenant log back into the portal later without an API key.
IDENTITY_SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]
CORE_SCOPES = IDENTITY_SCOPES + [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
]
ADS_SCOPES = IDENTITY_SCOPES + [
    "https://www.googleapis.com/auth/adwords",
    "https://www.googleapis.com/auth/business.manage",
]
STATE_COOKIE = "onboard_gnonce"


def platform_google_configured() -> bool:
    return bool(os.getenv("PLATFORM_GOOGLE_CLIENT_ID") and os.getenv("PLATFORM_GOOGLE_CLIENT_SECRET"))


def _redirect_uri() -> str:
    return f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/onboard/google/callback"


def _flow(scopes: list[str]):
    from google_auth_oauthlib.flow import Flow
    return Flow.from_client_config(
        {
            "web": {
                "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
                "client_secret": os.environ["PLATFORM_GOOGLE_CLIENT_SECRET"],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=scopes,
        redirect_uri=_redirect_uri(),
    )


async def _fetch_userinfo(credentials) -> dict:
    """Best-effort OIDC userinfo (sub + email) for gmail_address autofill
    and identity linking. Empty dict on any failure."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://openidconnect.googleapis.com/v1/userinfo",
                headers={"Authorization": f"Bearer {credentials.token}"},
            )
            if r.status_code == 200:
                return r.json()
    except Exception:
        logger.warning("userinfo fetch failed", exc_info=True)
    return {}


async def _discover_ads_customers(refresh_token: str) -> list[str]:
    """List Ads customer IDs this login can access. Empty on any failure."""
    def _list() -> list[str]:
        from google.ads.googleads.client import GoogleAdsClient
        client = GoogleAdsClient.load_from_dict({
            "developer_token": os.environ["PLATFORM_GOOGLE_ADS_DEVELOPER_TOKEN"],
            "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["PLATFORM_GOOGLE_CLIENT_SECRET"],
            "refresh_token": refresh_token,
            "use_proto_plus": True,
        })
        svc = client.get_service("CustomerService")
        return [rn.split("/")[-1] for rn in svc.list_accessible_customers().resource_names]

    try:
        return await asyncio.to_thread(_list)
    except Exception:
        logger.warning("Ads customer discovery failed", exc_info=True)
        return []


def register_google_routes(mcp) -> None:
    from starlette.requests import Request
    from starlette.responses import RedirectResponse

    @mcp.custom_route("/onboard/google/start", methods=["GET"])
    async def google_start(request: Request):
        raw = str(request.query_params.get("t", ""))
        session = await links.verify_token(raw)
        if session is None:
            return pages.dead_link_page()
        if not platform_google_configured() or not os.getenv("OAUTH_PUBLIC_URL"):
            return pages.error_page("Google sign-in is not configured on this deployment.",
                                    back_href=f"/onboard?t={raw}")
        ads = request.query_params.get("ads") == "1"
        nonce = secrets.token_urlsafe(16)
        flow = _flow(ADS_SCOPES if ads else CORE_SCOPES)
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            prompt="consent",
            include_granted_scopes="true",
            state=f"{raw}.{nonce}.{'ads' if ads else 'core'}",
        )
        resp = RedirectResponse(auth_url, status_code=302)
        resp.set_cookie(STATE_COOKIE, nonce, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=600)
        return resp

    @mcp.custom_route("/onboard/google/callback", methods=["GET"])
    async def google_callback(request: Request):
        state = str(request.query_params.get("state", ""))
        parts = state.split(".")
        if len(parts) != 3:
            return pages.dead_link_page()
        raw, nonce, kind = parts
        session = await links.verify_token(raw)
        if session is None:
            return pages.dead_link_page()
        back = f"/onboard?t={raw}"
        if not secrets.compare_digest(nonce, request.cookies.get(STATE_COOKIE, "")):
            return pages.error_page("Sign-in session mismatch — please try connecting again.", back)
        if request.query_params.get("error"):
            return pages.error_page("Google sign-in was cancelled or denied.", back)
        code = request.query_params.get("code", "")
        if not code:
            return pages.error_page("Google did not return an authorization code.", back)

        ads = kind == "ads"
        flow = _flow(ADS_SCOPES if ads else CORE_SCOPES)
        try:
            await asyncio.to_thread(flow.fetch_token, code=code)
        except Exception:
            logger.exception("Google token exchange failed (tenant=%s)", session.slug)
            return pages.error_page("Could not complete Google sign-in — please try again.", back)

        creds = flow.credentials
        if not creds.refresh_token:
            return pages.error_page(
                "Google did not issue a refresh token. Remove this app's access at "
                "myaccount.google.com/permissions and try connecting again.", back)

        userinfo = await _fetch_userinfo(creds)
        if userinfo.get("sub"):
            # Link this Google identity to the tenant so they can sign back
            # into the portal later — safe to do here because reaching this
            # callback already required a valid, token-gated onboarding
            # session (see links.verify_token above).
            from mcp_common.identity import link_identity
            await link_identity(session.tenant_id, "google", userinfo["sub"], userinfo.get("email"))

        cipher = CredentialCipher()
        if ads:
            await store.set_credential(session.slug, "google_ads", {
                "developer_token": os.getenv("PLATFORM_GOOGLE_ADS_DEVELOPER_TOKEN", ""),
                "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
                "client_secret": os.environ["PLATFORM_GOOGLE_CLIENT_SECRET"],
                "refresh_token": creds.refresh_token,
            }, cipher)
            await audit.record("onboarding.set_credential", {"service": "google_ads", "tenant": session.slug}, "ok")
            customers = await _discover_ads_customers(creds.refresh_token)
            if len(customers) == 1:
                await store.set_settings(session.slug, {"google_ads_customer_id": customers[0]})
            elif len(customers) > 1:
                return pages.google_ads_picker(session, raw,
                                               request.cookies.get("onboard_csrf", ""), customers)
            return RedirectResponse(f"{back}&notice=google_ads", status_code=303)

        bundle = {
            "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["PLATFORM_GOOGLE_CLIENT_SECRET"],
            "refresh_token": creds.refresh_token,
        }
        await store.set_credential(session.slug, "google", bundle, cipher)
        await audit.record("onboarding.set_credential", {"service": "google", "tenant": session.slug}, "ok")
        email = userinfo.get("email", "")
        if email:
            existing = await store.get_settings(session.slug)
            if not existing.get("gmail_address"):
                await store.set_settings(session.slug, {"gmail_address": email})
        return RedirectResponse(f"{back}&notice=google", status_code=303)

    @mcp.custom_route("/onboard/google/select", methods=["POST"])
    async def google_select(request: Request):
        form = await request.form()
        raw = str(form.get("t", ""))
        session = await links.verify_token(raw)
        if session is None:
            return pages.dead_link_page()
        customer_id = str(form.get("customer_id", "")).strip()
        if not customer_id.isdigit():
            return pages.error_page("Invalid selection.", back_href=f"/onboard?t={raw}")
        await store.set_settings(session.slug, {"google_ads_customer_id": customer_id})
        return RedirectResponse(f"/onboard?t={raw}&notice=google_ads", status_code=303)

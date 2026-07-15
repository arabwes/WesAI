"""Hosted Facebook Login for the onboarding portal.

Dialog redirect -> code exchange -> long-lived token exchange (~60 days),
then discovery of the login's ad accounts and Instagram business accounts
for a picker. Writes 'meta' and 'instagram' bundles in the shapes config.py
already consumes. All Graph calls send appsecret_proof.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time

import httpx

from mcp_common import audit
from mcp_common.crypto import CredentialCipher
from mcp_common.onboarding import html as pages
from mcp_common.onboarding import links
from mcp_common import store

logger = logging.getLogger("mcp.onboarding.meta")

GRAPH = "https://graph.facebook.com/v19.0"
DIALOG = "https://www.facebook.com/v19.0/dialog/oauth"
# email is a default/non-sensitive permission — included so we can link a
# sign-in identity for later portal login; public_profile (id, name) is
# always implicitly granted by Facebook Login regardless of scope list.
SCOPES = "ads_read,business_management,instagram_basic,instagram_manage_insights,pages_show_list,email"
STATE_COOKIE = "onboard_mnonce"


def platform_meta_configured() -> bool:
    return bool(os.getenv("PLATFORM_META_APP_ID") and os.getenv("PLATFORM_META_APP_SECRET"))


def _redirect_uri() -> str:
    return f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/onboard/meta/callback"


def _proof(access_token: str) -> str:
    return hmac.new(os.environ["PLATFORM_META_APP_SECRET"].encode(),
                    access_token.encode(), hashlib.sha256).hexdigest()


async def _graph_get(client: httpx.AsyncClient, path: str, access_token: str, **params):
    r = await client.get(f"{GRAPH}/{path}", params={
        "access_token": access_token, "appsecret_proof": _proof(access_token), **params,
    })
    r.raise_for_status()
    return r.json()


async def _exchange_code(code: str) -> str:
    """code -> short-lived token -> long-lived token."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{GRAPH}/oauth/access_token", params={
            "client_id": os.environ["PLATFORM_META_APP_ID"],
            "client_secret": os.environ["PLATFORM_META_APP_SECRET"],
            "redirect_uri": _redirect_uri(),
            "code": code,
        })
        r.raise_for_status()
        short = r.json()["access_token"]

        r = await client.get(f"{GRAPH}/oauth/access_token", params={
            "grant_type": "fb_exchange_token",
            "client_id": os.environ["PLATFORM_META_APP_ID"],
            "client_secret": os.environ["PLATFORM_META_APP_SECRET"],
            "fb_exchange_token": short,
        })
        r.raise_for_status()
        return r.json()["access_token"]


async def _fetch_me(access_token: str) -> dict:
    """Best-effort {id, email} for identity linking. Empty dict on failure."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            return await _graph_get(client, "me", access_token, fields="id,email")
    except Exception:
        logger.warning("Meta /me fetch failed", exc_info=True)
        return {}


async def _discover(access_token: str) -> tuple[list[dict], list[dict]]:
    """(ad_accounts, instagram_accounts) for this login. Empty on failure."""
    ad_accounts: list[dict] = []
    ig_accounts: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            ads = await _graph_get(client, "me/adaccounts", access_token,
                                   fields="id,name", limit=50)
            ad_accounts = [{"id": a["id"], "name": a.get("name", "")} for a in ads.get("data", [])]

            pages_resp = await _graph_get(client, "me/accounts", access_token,
                                          fields="name,instagram_business_account{id,username}",
                                          limit=50)
            for p in pages_resp.get("data", []):
                ig = p.get("instagram_business_account")
                if ig:
                    ig_accounts.append({"id": ig["id"], "username": ig.get("username", "")})
    except Exception:
        logger.warning("Meta discovery failed", exc_info=True)
    return ad_accounts, ig_accounts


def register_meta_routes(mcp) -> None:
    from starlette.requests import Request
    from starlette.responses import RedirectResponse

    @mcp.custom_route("/onboard/meta/start", methods=["GET"])
    async def meta_start(request: Request):
        raw = str(request.query_params.get("t", ""))
        session = await links.verify_token(raw)
        if session is None:
            return pages.dead_link_page()
        if not platform_meta_configured() or not os.getenv("OAUTH_PUBLIC_URL"):
            return pages.error_page("Facebook sign-in is not configured on this deployment.",
                                    back_href=f"/onboard?t={raw}")
        nonce = secrets.token_urlsafe(16)
        params = httpx.QueryParams({
            "client_id": os.environ["PLATFORM_META_APP_ID"],
            "redirect_uri": _redirect_uri(),
            "scope": SCOPES,
            "response_type": "code",
            "state": f"{raw}.{nonce}",
        })
        resp = RedirectResponse(f"{DIALOG}?{params}", status_code=302)
        resp.set_cookie(STATE_COOKIE, nonce, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=600)
        return resp

    @mcp.custom_route("/onboard/meta/callback", methods=["GET"])
    async def meta_callback(request: Request):
        state = str(request.query_params.get("state", ""))
        parts = state.split(".")
        if len(parts) != 2:
            return pages.dead_link_page()
        raw, nonce = parts
        session = await links.verify_token(raw)
        if session is None:
            return pages.dead_link_page()
        back = f"/onboard?t={raw}"
        if not secrets.compare_digest(nonce, request.cookies.get(STATE_COOKIE, "")):
            return pages.error_page("Sign-in session mismatch — please try connecting again.", back)
        if request.query_params.get("error"):
            return pages.error_page("Facebook sign-in was cancelled or denied.", back)
        code = request.query_params.get("code", "")
        if not code:
            return pages.error_page("Facebook did not return an authorization code.", back)

        try:
            token = await _exchange_code(code)
        except Exception:
            logger.exception("Meta token exchange failed (tenant=%s)", session.slug)
            return pages.error_page("Could not complete Facebook sign-in — please try again.", back)

        cipher = CredentialCipher()
        issued_at = int(time.time())
        await store.set_credential(session.slug, "meta", {
            "access_token": token,
            "app_id": os.environ["PLATFORM_META_APP_ID"],
            "app_secret": os.environ["PLATFORM_META_APP_SECRET"],
            "issued_at": issued_at,
        }, cipher)
        await store.set_credential(session.slug, "instagram", {
            "access_token": token, "issued_at": issued_at,
        }, cipher)
        await audit.record("onboarding.set_credential", {"service": "meta+instagram", "tenant": session.slug}, "ok")

        me = await _fetch_me(token)
        if me.get("id"):
            # Same rationale as the Google flow: safe to link here because
            # reaching this callback already required a valid, token-gated
            # onboarding session.
            from mcp_common.identity import link_identity
            await link_identity(session.tenant_id, "facebook", me["id"], me.get("email"))

        ad_accounts, ig_accounts = await _discover(token)
        auto = {}
        if len(ad_accounts) == 1:
            auto["meta_ad_account_id"] = ad_accounts[0]["id"]
        if len(ig_accounts) == 1:
            auto["instagram_business_account_id"] = ig_accounts[0]["id"]
        if auto:
            await store.set_settings(session.slug, auto)
        needs_picker = len(ad_accounts) > 1 or len(ig_accounts) > 1
        if needs_picker:
            return pages.meta_picker(session, raw, request.cookies.get("onboard_csrf", ""),
                                     ad_accounts, ig_accounts)
        return RedirectResponse(f"{back}&notice=meta", status_code=303)

    @mcp.custom_route("/onboard/meta/select", methods=["POST"])
    async def meta_select(request: Request):
        form = await request.form()
        raw = str(form.get("t", ""))
        session = await links.verify_token(raw)
        if session is None:
            return pages.dead_link_page()
        patch = {}
        ad_id = str(form.get("ad_account_id", "")).strip()
        ig_id = str(form.get("ig_account_id", "")).strip()
        if ad_id:
            if not ad_id.startswith("act_") or not ad_id[4:].isdigit():
                return pages.error_page("Invalid ad account selection.", back_href=f"/onboard?t={raw}")
            patch["meta_ad_account_id"] = ad_id
        if ig_id:
            if not ig_id.isdigit():
                return pages.error_page("Invalid Instagram selection.", back_href=f"/onboard?t={raw}")
            patch["instagram_business_account_id"] = ig_id
        if patch:
            await store.set_settings(session.slug, patch)
        return RedirectResponse(f"/onboard?t={raw}&notice=meta", status_code=303)

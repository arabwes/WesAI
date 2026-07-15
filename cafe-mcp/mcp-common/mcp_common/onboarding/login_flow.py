"""Persistent tenant login via Google/Facebook sign-in — no passwords, no
pasted API keys. A tenant proves who they are by signing into the same
Google/Facebook account already linked during onboarding (see
identity.link_identity, wired into google_flow.py/meta_flow.py's connect
callbacks), and gets a session cookie for /portal.

Deliberately uses MINIMAL, non-sensitive scopes — openid/email/profile and
public_profile/email — separate from the data-access scopes requested by
the onboarding connect flows, so signing in never triggers the sensitive-
scope consent screen.

Unrecognized identities get a generic "not recognized" page: we do not
reveal whether a Google/Facebook account has no CafeMCP tenant at all vs.
any other failure, to avoid account enumeration.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets

import httpx

from mcp_common import audit, identity
from mcp_common.htmlpages import page

logger = logging.getLogger("mcp.login")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_LOGIN_SCOPES = "openid email profile"

FACEBOOK_DIALOG_URL = "https://www.facebook.com/v19.0/dialog/oauth"
FACEBOOK_GRAPH = "https://graph.facebook.com/v19.0"
FACEBOOK_LOGIN_SCOPES = "public_profile,email"

STATE_COOKIE = "cafemcp_login_nonce"
SESSION_COOKIE = "cafemcp_session"


def google_login_configured() -> bool:
    return bool(os.getenv("PLATFORM_GOOGLE_CLIENT_ID") and os.getenv("PLATFORM_GOOGLE_CLIENT_SECRET"))


def facebook_login_configured() -> bool:
    return bool(os.getenv("PLATFORM_META_APP_ID") and os.getenv("PLATFORM_META_APP_SECRET"))


def _google_redirect_uri() -> str:
    return f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/login/google/callback"


def _facebook_redirect_uri() -> str:
    return f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/login/facebook/callback"


def render_login_page(error: str | None = None):
    google_btn = (
        '<a class="btn btn-provider" href="/login/google/start">Continue with Google</a>'
        if google_login_configured() else
        '<p class="hint">Google sign-in is not configured on this deployment.</p>'
    )
    facebook_btn = (
        '<a class="btn btn-provider" href="/login/facebook/start">Continue with Facebook</a>'
        if facebook_login_configured() else
        '<p class="hint">Facebook sign-in is not configured on this deployment.</p>'
    )
    error_html = f'<p class="error">{error}</p>' if error else ""
    return page("Sign in — CafeMCP", f"""
<h1>Sign in</h1>
<p class="hint">Use the Google or Facebook account connected to your business.</p>
{error_html}
{google_btn}
{facebook_btn}
<p class="hint" style="margin-top:1.5em">Not a customer yet? See the <a href="/">homepage</a> to request access.</p>
""", status_code=400 if error else 200)


def render_not_recognized_page():
    return page("Sign-in not recognized — CafeMCP", """
<h1>We don't recognize that sign-in</h1>
<p>This Google/Facebook account isn't linked to a CafeMCP business yet.</p>
<p class="hint">If you're a new customer, contact your operator for an
invite. If you've connected your accounts before, make sure you're signing
in with the same Google or Facebook account you used during setup.</p>
<p><a class="btn btn-secondary" href="/login">Try again</a></p>
""", status_code=404)


def _set_session_cookie(response, raw_session: str, secure: bool):
    response.set_cookie(
        SESSION_COOKIE, raw_session, httponly=True, samesite="lax", secure=secure,
        max_age=identity.SESSION_TTL_HOURS * 3600, path="/",
    )
    return response


async def _complete_login(request, provider: str, provider_user_id: str, email: str | None):
    """Shared tail end of both provider callbacks: look up the tenant,
    audit, issue a session, redirect to /portal (or the not-recognized page)."""
    from starlette.responses import RedirectResponse

    found = await identity.find_tenant_by_identity(provider, provider_user_id)
    if found is None:
        await audit.record("login.not_recognized", {"provider": provider}, "denied")
        return render_not_recognized_page()

    ua = request.headers.get("user-agent", "")
    ip = request.client.host if request.client else ""
    raw_session = await identity.create_session(found.tenant_id, found.identity_id, ua, ip)
    await audit.record("login.success", {"provider": provider, "tenant": found.slug}, "ok")

    resp = RedirectResponse("/portal", status_code=303)
    return _set_session_cookie(resp, raw_session, secure=request.url.scheme == "https")


def register_login_page_routes(mcp) -> None:
    from starlette.requests import Request
    from starlette.responses import RedirectResponse

    @mcp.custom_route("/login", methods=["GET"])
    async def login_page(request: Request):
        return render_login_page()

    # ── Google ──────────────────────────────────────────────────────────
    @mcp.custom_route("/login/google/start", methods=["GET"])
    async def login_google_start(request: Request):
        if not google_login_configured() or not os.getenv("OAUTH_PUBLIC_URL"):
            return render_login_page(error="Google sign-in is not configured on this deployment.")
        nonce = secrets.token_urlsafe(16)
        params = httpx.QueryParams({
            "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
            "redirect_uri": _google_redirect_uri(),
            "response_type": "code",
            "scope": GOOGLE_LOGIN_SCOPES,
            "state": nonce,
            "prompt": "select_account",
        })
        resp = RedirectResponse(f"{GOOGLE_AUTH_URL}?{params}", status_code=302)
        resp.set_cookie(STATE_COOKIE, nonce, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=600)
        return resp

    @mcp.custom_route("/login/google/callback", methods=["GET"])
    async def login_google_callback(request: Request):
        state = str(request.query_params.get("state", ""))
        if not state or not secrets.compare_digest(state, request.cookies.get(STATE_COOKIE, "")):
            return render_login_page(error="Sign-in session mismatch — please try again.")
        if request.query_params.get("error"):
            return render_login_page(error="Google sign-in was cancelled or denied.")
        code = request.query_params.get("code", "")
        if not code:
            return render_login_page(error="Google did not return an authorization code.")

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                tok = await client.post(GOOGLE_TOKEN_URL, data={
                    "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
                    "client_secret": os.environ["PLATFORM_GOOGLE_CLIENT_SECRET"],
                    "redirect_uri": _google_redirect_uri(),
                    "grant_type": "authorization_code",
                    "code": code,
                })
                tok.raise_for_status()
                access_token = tok.json()["access_token"]
                info = await client.get(GOOGLE_USERINFO_URL,
                                        headers={"Authorization": f"Bearer {access_token}"})
                info.raise_for_status()
                userinfo = info.json()
        except Exception:
            logger.exception("Google login exchange failed")
            return render_login_page(error="Could not complete Google sign-in — please try again.")

        sub = userinfo.get("sub")
        if not sub:
            return render_login_page(error="Google did not return an account identifier.")
        return await _complete_login(request, "google", sub, userinfo.get("email"))

    # ── Facebook ────────────────────────────────────────────────────────
    @mcp.custom_route("/login/facebook/start", methods=["GET"])
    async def login_facebook_start(request: Request):
        if not facebook_login_configured() or not os.getenv("OAUTH_PUBLIC_URL"):
            return render_login_page(error="Facebook sign-in is not configured on this deployment.")
        nonce = secrets.token_urlsafe(16)
        params = httpx.QueryParams({
            "client_id": os.environ["PLATFORM_META_APP_ID"],
            "redirect_uri": _facebook_redirect_uri(),
            "scope": FACEBOOK_LOGIN_SCOPES,
            "response_type": "code",
            "state": nonce,
        })
        resp = RedirectResponse(f"{FACEBOOK_DIALOG_URL}?{params}", status_code=302)
        resp.set_cookie(STATE_COOKIE, nonce, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=600)
        return resp

    @mcp.custom_route("/login/facebook/callback", methods=["GET"])
    async def login_facebook_callback(request: Request):
        state = str(request.query_params.get("state", ""))
        if not state or not secrets.compare_digest(state, request.cookies.get(STATE_COOKIE, "")):
            return render_login_page(error="Sign-in session mismatch — please try again.")
        if request.query_params.get("error"):
            return render_login_page(error="Facebook sign-in was cancelled or denied.")
        code = request.query_params.get("code", "")
        if not code:
            return render_login_page(error="Facebook did not return an authorization code.")

        try:
            async with httpx.AsyncClient(timeout=15) as client:
                tok = await client.get(f"{FACEBOOK_GRAPH}/oauth/access_token", params={
                    "client_id": os.environ["PLATFORM_META_APP_ID"],
                    "client_secret": os.environ["PLATFORM_META_APP_SECRET"],
                    "redirect_uri": _facebook_redirect_uri(),
                    "code": code,
                })
                tok.raise_for_status()
                access_token = tok.json()["access_token"]
                proof = hmac.new(os.environ["PLATFORM_META_APP_SECRET"].encode(),
                                 access_token.encode(), hashlib.sha256).hexdigest()
                me = await client.get(f"{FACEBOOK_GRAPH}/me", params={
                    "access_token": access_token, "appsecret_proof": proof, "fields": "id,email",
                })
                me.raise_for_status()
                profile = me.json()
        except Exception:
            logger.exception("Facebook login exchange failed")
            return render_login_page(error="Could not complete Facebook sign-in — please try again.")

        fb_id = profile.get("id")
        if not fb_id:
            return render_login_page(error="Facebook did not return an account identifier.")
        return await _complete_login(request, "facebook", fb_id, profile.get("email"))

"""Minimal OAuth 2.1 authorization server bridging to mcp_common's existing
bearer-key tenant auth, so OAuth-only MCP client UIs (Claude.ai/ChatGPT
connector pickers that don't support custom headers) can connect.

The interactive "login" step asks for an existing wes_ API key — this does
not replace API keys, it wraps them in a spec-compliant OAuth 2.1 flow.
FastMCP handles the wire protocol (PKCE, /.well-known/*, /authorize, /token,
/register) via the OAuthProvider extension point; this module only
implements the storage + the bridge back to TenantContext.

Storage is in-memory: dynamically-registered clients, pending logins, and
issued codes/tokens do not survive a process restart. Accepted tradeoff for
a low-traffic deployment — MCP clients re-register automatically per the
dynamic client registration spec, and a user with a lost token just
reconnects the connector. Revisit with DB-backed storage if restarts become
disruptive to users mid-session.
"""
from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from fastmcp.server.auth.auth import ClientRegistrationOptions, OAuthProvider

from mcp_common.auth import AUTHENTICATED_NO_TENANT, default_authenticator
from mcp_common.tenant import TenantContext

logger = logging.getLogger("mcp.oauth")

AUTH_CODE_TTL_S = 300
LOGIN_TXN_TTL_S = 600
ACCESS_TOKEN_TTL_S = 3600


@dataclass
class _PendingAuthorization:
    client: OAuthClientInformationFull
    params: AuthorizationParams
    created_at: float


class TenantOAuthProvider(OAuthProvider):
    """Bridges OAuth 2.1 authorization-code flow to tenant bearer-key auth."""

    def __init__(self, base_url: str):
        super().__init__(
            base_url=base_url,
            client_registration_options=ClientRegistrationOptions(enabled=True),
        )
        self.clients: dict[str, OAuthClientInformationFull] = {}
        self.pending: dict[str, _PendingAuthorization] = {}
        self.auth_codes: dict[str, AuthorizationCode] = {}
        self.access_tokens: dict[str, AccessToken] = {}
        self.refresh_tokens: dict[str, RefreshToken] = {}
        self._authenticator = default_authenticator()

    # ── Dynamic client registration (RFC 7591) ────────────────────────────
    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        return self.clients.get(client_id)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self.clients[client_info.client_id] = client_info

    # ── Authorization: hand off to our own login page ─────────────────────
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        self._sweep_expired_pending()
        txn = secrets.token_urlsafe(24)
        self.pending[txn] = _PendingAuthorization(client=client, params=params, created_at=time.time())
        return f"{str(self.base_url).rstrip('/')}/oauth/login?txn={txn}"

    def peek_pending(self, txn: str) -> _PendingAuthorization | None:
        p = self.pending.get(txn)
        if p is None or (time.time() - p.created_at) > LOGIN_TXN_TTL_S:
            return None
        return p

    async def verify_api_key(self, raw_key: str) -> TenantContext | None:
        """Verify a pasted API key using the same chain (env keys + tenant
        DB keys) the main bearer-auth middleware uses."""
        return await self._authenticator.authenticate(raw_key)

    async def complete_login(self, txn: str, tenant: TenantContext) -> str:
        """Called by the /oauth/login/submit route after a valid API key was
        presented. Returns the redirect URI to send the browser to."""
        pending = self.pending.pop(txn, None)
        if pending is None or (time.time() - pending.created_at) > LOGIN_TXN_TTL_S:
            raise AuthorizeError(error="access_denied", error_description="Login session expired — reconnect and try again.")

        subject = "__env__" if tenant is AUTHENTICATED_NO_TENANT else tenant.slug
        scopes = list(tenant.scopes)
        if pending.client.scope:
            allowed = set(pending.client.scope.split())
            filtered = [s for s in scopes if s in allowed]
            if filtered:
                scopes = filtered

        code_value = secrets.token_urlsafe(32)
        auth_code = AuthorizationCode(
            code=code_value,
            client_id=pending.client.client_id,
            redirect_uri=pending.params.redirect_uri,
            redirect_uri_provided_explicitly=pending.params.redirect_uri_provided_explicitly,
            scopes=scopes,
            expires_at=time.time() + AUTH_CODE_TTL_S,
            code_challenge=pending.params.code_challenge,
            resource=pending.params.resource,
            subject=subject,
        )
        self.auth_codes[code_value] = auth_code
        return construct_redirect_uri(str(pending.params.redirect_uri), code=code_value, state=pending.params.state)

    def _sweep_expired_pending(self) -> None:
        cutoff = time.time() - LOGIN_TXN_TTL_S
        stale = [t for t, p in self.pending.items() if p.created_at < cutoff]
        for t in stale:
            self.pending.pop(t, None)

    # ── Code exchange ──────────────────────────────────────────────────────
    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str) -> AuthorizationCode | None:
        code = self.auth_codes.get(authorization_code)
        if code is None or code.client_id != client.client_id:
            return None
        if code.expires_at < time.time():
            self.auth_codes.pop(authorization_code, None)
            return None
        return code

    async def exchange_authorization_code(self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode) -> OAuthToken:
        if authorization_code.code not in self.auth_codes:
            raise TokenError("invalid_grant", "Authorization code not found or already used.")
        self.auth_codes.pop(authorization_code.code, None)

        access_value = secrets.token_urlsafe(32)
        refresh_value = secrets.token_urlsafe(32)
        expires_at = int(time.time() + ACCESS_TOKEN_TTL_S)
        self.access_tokens[access_value] = AccessToken(
            token=access_value, client_id=client.client_id, scopes=authorization_code.scopes,
            expires_at=expires_at, resource=authorization_code.resource,
            subject=authorization_code.subject,
        )
        self.refresh_tokens[refresh_value] = RefreshToken(
            token=refresh_value, client_id=client.client_id, scopes=authorization_code.scopes,
            expires_at=None, subject=authorization_code.subject,
        )
        return OAuthToken(
            access_token=access_value, token_type="bearer", expires_in=ACCESS_TOKEN_TTL_S,
            scope=" ".join(authorization_code.scopes), refresh_token=refresh_value,
        )

    # ── Refresh ─────────────────────────────────────────────────────────────
    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        token = self.refresh_tokens.get(refresh_token)
        if token is None or token.client_id != client.client_id:
            return None
        return token

    async def exchange_refresh_token(self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        access_value = secrets.token_urlsafe(32)
        expires_at = int(time.time() + ACCESS_TOKEN_TTL_S)
        granted = scopes or refresh_token.scopes
        self.access_tokens[access_value] = AccessToken(
            token=access_value, client_id=client.client_id, scopes=granted,
            expires_at=expires_at, subject=refresh_token.subject,
        )
        return OAuthToken(
            access_token=access_value, token_type="bearer", expires_in=ACCESS_TOKEN_TTL_S,
            scope=" ".join(granted), refresh_token=refresh_token.token,
        )

    # ── Verification ────────────────────────────────────────────────────────
    async def load_access_token(self, token: str) -> AccessToken | None:
        access = self.access_tokens.get(token)
        if access is None:
            return None
        if access.expires_at and access.expires_at < time.time():
            self.access_tokens.pop(token, None)
            return None
        return access

    async def revoke_token(self, token) -> None:
        if isinstance(token, AccessToken):
            self.access_tokens.pop(token.token, None)
        elif isinstance(token, RefreshToken):
            self.refresh_tokens.pop(token.token, None)


# ── Login page routes (mounted on the FastMCP app in main.py) ─────────────────
#
# This is the page an OAuth-only MCP client (Claude, ChatGPT) is redirected
# to mid-connector-setup. Primary path is the same Google/Facebook identity
# sign-in used by the marketing-site portal (mcp_common.identity) — no API
# key required. The API-key form is kept as a secondary fallback for the
# static-key break-glass case (MCP_API_KEYS) and for tenants who haven't
# linked a sign-in identity yet.

OAUTH_LOGIN_NONCE_COOKIE = "cafemcp_oauth_login_nonce"


@dataclass(frozen=True)
class _IdentityTenant:
    """Minimal duck-typed stand-in for TenantContext — complete_login()
    only reads .slug and .scopes."""
    slug: str
    scopes: frozenset


def _google_login_configured() -> bool:
    from mcp_common.onboarding.login_flow import google_login_configured
    return google_login_configured()


def _facebook_login_configured() -> bool:
    from mcp_common.onboarding.login_flow import facebook_login_configured
    return facebook_login_configured()


def _login_page(txn: str, error: str | None = None, show_key_form: bool = False, status_code: int | None = None):
    """Render the full connector-authorization page (theme shell + security
    headers via htmlpages.page())."""
    from mcp_common.htmlpages import page

    error_html = f'<p class="error">{error}</p>' if error else ""
    google_btn = (
        f'<a class="btn btn-provider" href="/oauth/login/google/start?txn={txn}">Continue with Google</a>'
        if _google_login_configured() else ""
    )
    facebook_btn = (
        f'<a class="btn btn-provider" href="/oauth/login/facebook/start?txn={txn}">Continue with Facebook</a>'
        if _facebook_login_configured() else ""
    )
    key_form = f"""
  <details {"open" if show_key_form else ""} style="margin-top:1.4em">
    <summary class="hint" style="cursor:pointer">Use an access key instead</summary>
    <form method="post" action="/oauth/login/submit" style="margin-top:10px">
      <input type="hidden" name="txn" value="{txn}">
      <input type="password" name="api_key" placeholder="wes_..." autocomplete="off">
      <button type="submit" class="btn-secondary">Authorize with key</button>
    </form>
  </details>
"""
    body = f"""
<h1>Connect your AI assistant</h1>
<p class="hint">Sign in with the Google or Facebook account connected to your business.</p>
{error_html}
{google_btn}
{facebook_btn}
{key_form}
"""
    code = status_code if status_code is not None else (400 if error else 200)
    return page("Connect to CafeMCP", body, status_code=code, nav="")


def register_login_routes(mcp, provider: "TenantOAuthProvider") -> None:
    """Mount the interactive login page used by the OAuth authorize step.

    provider.authorize() redirects the browser here instead of issuing a
    code immediately, since OAuth's authorize() must return synchronously
    with no way to render an interactive form itself.
    """
    import secrets as _secrets

    import httpx
    from starlette.requests import Request
    from starlette.responses import RedirectResponse

    @mcp.custom_route("/oauth/login", methods=["GET"])
    async def oauth_login_page(request: Request):
        txn = request.query_params.get("txn", "")
        if provider.peek_pending(txn) is None:
            return _login_page(txn, error="This login link expired or is invalid. Please reconnect from your AI client.")
        return _login_page(txn)

    @mcp.custom_route("/oauth/login/submit", methods=["POST"])
    async def oauth_login_submit(request: Request):
        form = await request.form()
        txn = str(form.get("txn", ""))
        api_key = str(form.get("api_key", "")).strip()

        if provider.peek_pending(txn) is None:
            return _login_page(txn, error="This login link expired. Please reconnect from your AI client.")

        tenant = await provider.verify_api_key(api_key) if api_key else None
        if tenant is None:
            return _login_page(txn, error="Invalid API key.", show_key_form=True, status_code=401)

        try:
            redirect_uri = await provider.complete_login(txn, tenant)
        except AuthorizeError as e:
            return _login_page(txn, error=e.error_description or "Login failed.")
        return RedirectResponse(redirect_uri, status_code=302)

    async def _complete_with_identity(request: Request, txn: str, provider_name: str,
                                       provider_user_id: str):
        from mcp_common.identity import find_tenant_by_identity

        found = await find_tenant_by_identity(provider_name, provider_user_id)
        if found is None:
            return _login_page(
                txn, error="We don't recognize that sign-in. If you're a new customer, "
                          "contact your operator for an invite.", status_code=404)
        tenant = _IdentityTenant(slug=found.slug, scopes=frozenset({"read"}))
        try:
            redirect_uri = await provider.complete_login(txn, tenant)
        except AuthorizeError as e:
            return _login_page(txn, error=e.error_description or "Login failed.")
        return RedirectResponse(redirect_uri, status_code=302)

    # ── Google identity sign-in ─────────────────────────────────────────
    @mcp.custom_route("/oauth/login/google/start", methods=["GET"])
    async def oauth_login_google_start(request: Request):
        import os
        from mcp_common.onboarding.login_flow import GOOGLE_AUTH_URL, GOOGLE_LOGIN_SCOPES

        txn = request.query_params.get("txn", "")
        if provider.peek_pending(txn) is None or not _google_login_configured():
            return _login_page(txn, error="Google sign-in is unavailable right now.")
        nonce = _secrets.token_urlsafe(16)
        redirect_uri = f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/oauth/login/google/callback"
        params = httpx.QueryParams({
            "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
            "redirect_uri": redirect_uri, "response_type": "code",
            "scope": GOOGLE_LOGIN_SCOPES, "state": f"{txn}.{nonce}", "prompt": "select_account",
        })
        resp = RedirectResponse(f"{GOOGLE_AUTH_URL}?{params}", status_code=302)
        resp.set_cookie(OAUTH_LOGIN_NONCE_COOKIE, nonce, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=600)
        return resp

    @mcp.custom_route("/oauth/login/google/callback", methods=["GET"])
    async def oauth_login_google_callback(request: Request):
        import os
        from mcp_common.onboarding.login_flow import GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL

        state = str(request.query_params.get("state", ""))
        txn, _, nonce = state.partition(".")
        if not nonce or not _secrets.compare_digest(nonce, request.cookies.get(OAUTH_LOGIN_NONCE_COOKIE, "")):
            return _login_page(txn, error="Sign-in session mismatch — please try again.")
        if request.query_params.get("error"):
            return _login_page(txn, error="Google sign-in was cancelled or denied.")
        code = request.query_params.get("code", "")
        if not code:
            return _login_page(txn, error="Google did not return an authorization code.")

        redirect_uri = f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/oauth/login/google/callback"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                tok = await client.post(GOOGLE_TOKEN_URL, data={
                    "client_id": os.environ["PLATFORM_GOOGLE_CLIENT_ID"],
                    "client_secret": os.environ["PLATFORM_GOOGLE_CLIENT_SECRET"],
                    "redirect_uri": redirect_uri, "grant_type": "authorization_code", "code": code,
                })
                tok.raise_for_status()
                access_token = tok.json()["access_token"]
                info = await client.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
                info.raise_for_status()
                userinfo = info.json()
        except Exception:
            logger.exception("OAuth-bridge Google login exchange failed")
            return _login_page(txn, error="Could not complete Google sign-in — please try again.")

        sub = userinfo.get("sub")
        if not sub:
            return _login_page(txn, error="Google did not return an account identifier.")
        return await _complete_with_identity(request, txn, "google", sub)

    # ── Facebook identity sign-in ───────────────────────────────────────
    @mcp.custom_route("/oauth/login/facebook/start", methods=["GET"])
    async def oauth_login_facebook_start(request: Request):
        import os
        from mcp_common.onboarding.login_flow import FACEBOOK_DIALOG_URL, FACEBOOK_LOGIN_SCOPES

        txn = request.query_params.get("txn", "")
        if provider.peek_pending(txn) is None or not _facebook_login_configured():
            return _login_page(txn, error="Facebook sign-in is unavailable right now.")
        nonce = _secrets.token_urlsafe(16)
        redirect_uri = f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/oauth/login/facebook/callback"
        params = httpx.QueryParams({
            "client_id": os.environ["PLATFORM_META_APP_ID"],
            "redirect_uri": redirect_uri, "scope": FACEBOOK_LOGIN_SCOPES,
            "response_type": "code", "state": f"{txn}.{nonce}",
        })
        resp = RedirectResponse(f"{FACEBOOK_DIALOG_URL}?{params}", status_code=302)
        resp.set_cookie(OAUTH_LOGIN_NONCE_COOKIE, nonce, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", max_age=600)
        return resp

    @mcp.custom_route("/oauth/login/facebook/callback", methods=["GET"])
    async def oauth_login_facebook_callback(request: Request):
        import hashlib
        import hmac
        import os
        from mcp_common.onboarding.login_flow import FACEBOOK_GRAPH

        state = str(request.query_params.get("state", ""))
        txn, _, nonce = state.partition(".")
        if not nonce or not _secrets.compare_digest(nonce, request.cookies.get(OAUTH_LOGIN_NONCE_COOKIE, "")):
            return _login_page(txn, error="Sign-in session mismatch — please try again.")
        if request.query_params.get("error"):
            return _login_page(txn, error="Facebook sign-in was cancelled or denied.")
        code = request.query_params.get("code", "")
        if not code:
            return _login_page(txn, error="Facebook did not return an authorization code.")

        redirect_uri = f"{os.environ['OAUTH_PUBLIC_URL'].rstrip('/')}/oauth/login/facebook/callback"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                tok = await client.get(f"{FACEBOOK_GRAPH}/oauth/access_token", params={
                    "client_id": os.environ["PLATFORM_META_APP_ID"],
                    "client_secret": os.environ["PLATFORM_META_APP_SECRET"],
                    "redirect_uri": redirect_uri, "code": code,
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
            logger.exception("OAuth-bridge Facebook login exchange failed")
            return _login_page(txn, error="Could not complete Facebook sign-in — please try again.")

        fb_id = profile.get("id")
        if not fb_id:
            return _login_page(txn, error="Facebook did not return an account identifier.")
        return await _complete_with_identity(request, txn, "facebook", fb_id)

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

def _render_login_html(txn: str, error: str | None = None) -> str:
    error_html = f'<p class="error">{error}</p>' if error else ""
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Connect to Cafe MCP</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {{ font-family: -apple-system, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 16px; color: #1a1a1a; }}
  h1 {{ font-size: 1.25rem; }}
  input {{ width: 100%; padding: 10px; font-size: 1rem; box-sizing: border-box; margin: 8px 0 16px; border: 1px solid #ccc; border-radius: 6px; }}
  button {{ width: 100%; padding: 10px; font-size: 1rem; background: #1a1a1a; color: white; border: none; border-radius: 6px; cursor: pointer; }}
  .error {{ color: #c0392b; }}
  .hint {{ color: #666; font-size: 0.85rem; }}
</style></head>
<body>
  <h1>Connect to Cafe MCP</h1>
  <p class="hint">Enter your API key to authorize this connection.</p>
  {error_html}
  <form method="post" action="/oauth/login/submit">
    <input type="hidden" name="txn" value="{txn}">
    <input type="password" name="api_key" placeholder="wes_..." autofocus required>
    <button type="submit">Authorize</button>
  </form>
</body></html>"""


def register_login_routes(mcp, provider: "TenantOAuthProvider") -> None:
    """Mount the interactive login page used by the OAuth authorize step.

    provider.authorize() redirects the browser here instead of issuing a
    code immediately, since OAuth's authorize() must return synchronously
    with no way to render an interactive form itself.
    """
    from starlette.requests import Request
    from starlette.responses import HTMLResponse, RedirectResponse

    @mcp.custom_route("/oauth/login", methods=["GET"])
    async def oauth_login_page(request: Request):
        txn = request.query_params.get("txn", "")
        if provider.peek_pending(txn) is None:
            return HTMLResponse(
                _render_login_html(txn, error="This login link expired or is invalid. Please reconnect from your AI client."),
                status_code=400,
            )
        return HTMLResponse(_render_login_html(txn))

    @mcp.custom_route("/oauth/login/submit", methods=["POST"])
    async def oauth_login_submit(request: Request):
        form = await request.form()
        txn = str(form.get("txn", ""))
        api_key = str(form.get("api_key", "")).strip()

        if provider.peek_pending(txn) is None:
            return HTMLResponse(
                _render_login_html(txn, error="This login link expired. Please reconnect from your AI client."),
                status_code=400,
            )

        tenant = await provider.verify_api_key(api_key) if api_key else None
        if tenant is None:
            return HTMLResponse(_render_login_html(txn, error="Invalid API key."), status_code=401)

        try:
            redirect_uri = await provider.complete_login(txn, tenant)
        except AuthorizeError as e:
            return HTMLResponse(
                _render_login_html(txn, error=e.error_description or "Login failed."),
                status_code=400,
            )
        return RedirectResponse(redirect_uri, status_code=302)

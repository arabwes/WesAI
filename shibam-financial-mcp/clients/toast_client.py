"""Toast API OAuth client — identical to shibam-marketing-mcp/clients/toast_client.py.
Toast credentials use the same env var names across both servers."""
import time
import logging
import httpx
from typing import Optional
from config import config

logger = logging.getLogger(__name__)

_TOAST_AUTH_URLS = {
    "production": "https://ws-api.toasttab.com/authentication/v1/authentication/login",
    "sandbox": "https://ws-sandbox-api.eng.toasttab.com/authentication/v1/authentication/login",
}
_TOAST_BASE_URLS = {
    "production": "https://ws-api.toasttab.com",
    "sandbox": "https://ws-sandbox-api.eng.toasttab.com",
}

_token: Optional[str] = None
_token_expiry: float = 0


class ToastAuthError(RuntimeError):
    """Raised when Toast rejects a request with 401. Distinguishes the failure point
    (login vs data call) and the most likely env-var cause, since Toast's own 401
    body rarely says which credential is wrong."""
    _no_retry = True


def _fetch_token() -> str:
    url = _TOAST_AUTH_URLS[config.toast_environment]
    r = httpx.post(url, json={
        "clientId": config.toast_client_id,
        "clientSecret": config.toast_client_secret,
        "userAccessType": "TOAST_MACHINE_CLIENT",
    }, timeout=15)
    if r.status_code == 401:
        raise ToastAuthError(
            "Toast API 401 on the LOGIN call (authentication/v1/authentication/login) — "
            "TOAST_CLIENT_ID or TOAST_CLIENT_SECRET is wrong, empty, or has stray "
            "whitespace/quotes in this environment. Verify both in the Toast Developer "
            "Portal under your app's API Access / Credentials, and re-paste them into "
            "Railway Variables without surrounding quotes."
        )
    r.raise_for_status()
    return r.json()["token"]["accessToken"]


def get_token() -> str:
    global _token, _token_expiry
    if _token is None or time.time() >= _token_expiry:
        _token = _fetch_token()
        _token_expiry = time.time() + 82800
        logger.info("Toast API token refreshed")
    return _token


def get(path: str, params: Optional[dict] = None) -> dict:
    base = _TOAST_BASE_URLS[config.toast_environment]
    r = httpx.get(
        f"{base}{path}",
        headers={
            "Authorization": f"Bearer {get_token()}",
            "Toast-Restaurant-External-ID": config.toast_restaurant_guid,
        },
        params=params or {},
        timeout=30,
    )
    if r.status_code == 401:
        global _token, _token_expiry
        _token = None
        _token_expiry = 0  # force a fresh token on the next call
        if not config.toast_restaurant_guid:
            raise ToastAuthError(
                f"Toast API 401 on {path} — TOAST_RESTAURANT_GUID is not set, so the "
                "Toast-Restaurant-External-ID header was sent empty. This header is "
                "required on every data call, separate from the bearer token. Find the "
                "restaurant GUID in Toast Web back-office under Restaurant Info."
            )
        raise ToastAuthError(
            f"Toast API 401 on {path}, even though the login call succeeded (the bearer "
            "token was issued fine). Since the token itself was accepted, the data call "
            "rejection is most likely one of:\n"
            f"  1. TOAST_RESTAURANT_GUID ({config.toast_restaurant_guid[:8]}...) does not "
            "match the restaurant tied to these credentials — verify it exactly matches "
            "Toast Web back-office Restaurant Info, no extra characters.\n"
            "  2. Your Toast app's API access is Sandbox/Pending rather than Production "
            "Approved, or the 'orders:read' scope isn't granted — check the Developer "
            "Portal's API Access tab for this app.\n"
            f"  3. TOAST_ENVIRONMENT='{config.toast_environment}' doesn't match the type "
            "of credentials issued (sandbox vs production).\n"
            f"Toast's raw response: {r.text[:300]}"
        )
    r.raise_for_status()
    return r.json()

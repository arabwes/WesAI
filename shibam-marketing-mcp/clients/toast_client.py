"""Toast API OAuth client — SYNCHRONIZED MIRROR of shibam-financial-mcp/clients/toast_client.py.
Keep these two files byte-identical (below the docstring). They live in separate
deploy roots (each Railway service builds from its own subdirectory), so a single
shared module can't be imported by both without restructuring the build; until then,
any change here must be applied to the other copy verbatim.

Resilience lives here so EVERY Toast call inherits it:
  - retries 429 / 5xx / transient network errors with exponential backoff (Retry-After aware)
  - on 401, refreshes the token once and retries before concluding it's a real misconfig
  - optional light client-side throttle to stay under Toast's per-restaurant rate limit
"""
import time
import logging
import threading
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

_MAX_ATTEMPTS = 4
# Minimum seconds between outbound Toast requests (proactive throttle). Toast
# rate-limits per restaurant; this keeps us comfortably under typical limits.
# Set to 0 to disable. ~0.1s ≈ 10 req/s.
_MIN_REQUEST_INTERVAL = 0.1

_token: Optional[str] = None
_token_expiry: float = 0
_token_lock = threading.Lock()

_rate_lock = threading.Lock()
_last_request_ts: float = 0.0


class ToastAuthError(RuntimeError):
    """Raised when Toast rejects a request with 401 even after a fresh token.
    Distinguishes the likely env-var cause, since Toast's 401 body rarely says
    which credential is wrong. _no_retry stops the tool-level api_retry decorator
    from retrying a genuine auth/config failure."""
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
    with _token_lock:
        if _token is None or time.time() >= _token_expiry:
            _token = _fetch_token()
            _token_expiry = time.time() + 82800  # refresh after 23h (token lasts 24h)
            logger.info("Toast API token refreshed")
        return _token


def _invalidate_token() -> None:
    global _token, _token_expiry
    with _token_lock:
        _token = None
        _token_expiry = 0


def _throttle() -> None:
    """Block briefly so successive requests stay at least _MIN_REQUEST_INTERVAL apart."""
    global _last_request_ts
    if _MIN_REQUEST_INTERVAL <= 0:
        return
    with _rate_lock:
        delta = time.time() - _last_request_ts
        if delta < _MIN_REQUEST_INTERVAL:
            time.sleep(_MIN_REQUEST_INTERVAL - delta)
        _last_request_ts = time.time()


def _auth_error(path: str, body: str) -> "ToastAuthError":
    if not config.toast_restaurant_guid:
        return ToastAuthError(
            f"Toast API 401 on {path} — TOAST_RESTAURANT_GUID is not set, so the "
            "Toast-Restaurant-External-ID header was sent empty. This header is required "
            "on every data call, separate from the bearer token. Find the restaurant GUID "
            "in Toast Web back-office under Restaurant Info."
        )
    return ToastAuthError(
        f"Toast API 401 on {path} even after a fresh token, so this is not token "
        "expiry. Most likely one of:\n"
        f"  1. TOAST_RESTAURANT_GUID ({config.toast_restaurant_guid[:8]}...) does not "
        "match the restaurant tied to these credentials — verify it exactly matches "
        "Toast Web back-office Restaurant Info, no extra characters.\n"
        "  2. Your Toast app's API access is Sandbox/Pending rather than Production "
        "Approved, or the required read scope isn't granted — check the Developer "
        "Portal's API Access tab for this app.\n"
        f"  3. TOAST_ENVIRONMENT='{config.toast_environment}' doesn't match the type "
        "of credentials issued (sandbox vs production).\n"
        f"Toast's raw response: {body[:300]}"
    )


def get(path: str, params: Optional[dict] = None) -> dict:
    """Authenticated GET to the Toast API with built-in retry, token refresh, and throttle."""
    base = _TOAST_BASE_URLS[config.toast_environment]
    url = f"{base}{path}"
    refreshed = False
    last_exc: Optional[Exception] = None

    for attempt in range(_MAX_ATTEMPTS):
        _throttle()
        try:
            r = httpx.get(
                url,
                headers={
                    "Authorization": f"Bearer {get_token()}",
                    "Toast-Restaurant-External-ID": config.toast_restaurant_guid,
                },
                params=params or {},
                timeout=30,
            )
        except httpx.RequestError as e:  # transient network/connection error
            last_exc = e
            if attempt < _MAX_ATTEMPTS - 1:
                time.sleep(1.5 * (2 ** attempt))
                continue
            raise

        if r.status_code == 401:
            # The token may have expired early — refresh once and retry before
            # concluding it's a real credential/scope/restaurant misconfiguration.
            if not refreshed:
                _invalidate_token()
                refreshed = True
                continue
            _invalidate_token()
            raise _auth_error(path, r.text)

        if r.status_code == 429 or r.status_code >= 500:
            if attempt < _MAX_ATTEMPTS - 1:
                retry_after = r.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after else 1.5 * (2 ** attempt))
                continue

        r.raise_for_status()
        return r.json()

    if last_exc:
        raise last_exc
    raise RuntimeError(f"Toast GET {path} failed after {_MAX_ATTEMPTS} attempts")

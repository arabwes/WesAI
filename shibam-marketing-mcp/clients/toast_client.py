"""Toast API OAuth client — fetches and auto-refreshes bearer tokens."""
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


def _fetch_token() -> str:
    url = _TOAST_AUTH_URLS[config.toast_environment]
    payload = {
        "clientId": config.toast_client_id,
        "clientSecret": config.toast_client_secret,
        "userAccessType": "TOAST_MACHINE_CLIENT",
    }
    r = httpx.post(url, json=payload, timeout=15)
    r.raise_for_status()
    return r.json()["token"]["accessToken"]


def get_token() -> str:
    """Return a valid Toast token, refreshing 1 hour before expiry."""
    global _token, _token_expiry
    if _token is None or time.time() >= _token_expiry:
        _token = _fetch_token()
        _token_expiry = time.time() + 82800  # Refresh after 23 h (token lasts 24 h)
        logger.info("Toast API token refreshed")
    return _token


def get(path: str, params: Optional[dict] = None) -> dict:
    """Authenticated GET request to the Toast API."""
    base = _TOAST_BASE_URLS[config.toast_environment]
    headers = {
        "Authorization": f"Bearer {get_token()}",
        "Toast-Restaurant-External-ID": config.toast_restaurant_guid,
    }
    r = httpx.get(f"{base}{path}", headers=headers, params=params or {}, timeout=30)
    r.raise_for_status()
    return r.json()

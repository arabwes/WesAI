"""QuickBooks Online API client — OAuth 2.0 with automatic token refresh."""
import logging
import time
import httpx
from typing import Optional
from config import config, NotConfiguredError

logger = logging.getLogger(__name__)

_QB_BASE = {
    "production": "https://quickbooks.api.intuit.com",
    "sandbox": "https://sandbox-quickbooks.api.intuit.com",
}
_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"

_access_token: Optional[str] = None
_token_expiry: float = 0


def _refresh_access_token() -> str:
    """Use the refresh token to get a new short-lived access token."""
    if not config.qb_ready:
        raise NotConfiguredError(
            "QuickBooks not configured. Run: python scripts/get_qb_token.py — "
            "it will output QB_REFRESH_TOKEN and QB_REALM_ID for your .env."
        )
    r = httpx.post(
        _TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": config.qb_refresh_token,
        },
        auth=(config.qb_client_id, config.qb_client_secret),
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    return data["access_token"], int(data.get("expires_in", 3600))


def get_access_token() -> str:
    global _access_token, _token_expiry
    if _access_token is None or time.time() >= _token_expiry - 60:
        token, expires_in = _refresh_access_token()
        _access_token = token
        _token_expiry = time.time() + expires_in
        logger.info("QuickBooks access token refreshed")
    return _access_token


def qb_get(path: str, params: dict = None) -> dict:
    """Authenticated GET to QuickBooks REST API v3."""
    base = _QB_BASE.get(config.qb_environment, _QB_BASE["production"])
    url = f"{base}/v3/company/{config.qb_realm_id}{path}"
    r = httpx.get(
        url,
        headers={
            "Authorization": f"Bearer {get_access_token()}",
            "Accept": "application/json",
        },
        params={"minorversion": "65", **(params or {})},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def qb_query(sql: str) -> list:
    """Run a QuickBooks SQL-style query and return the entity list."""
    result = qb_get("/query", params={"query": sql})
    query_response = result.get("QueryResponse", {})
    # Return the first non-metadata key that contains a list
    for key, val in query_response.items():
        if isinstance(val, list):
            return val
    return []


def qb_report(report_name: str, params: dict = None) -> dict:
    """Fetch a QuickBooks report by name."""
    return qb_get(f"/reports/{report_name}", params=params)

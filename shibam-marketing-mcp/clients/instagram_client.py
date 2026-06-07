"""Instagram Graph API client."""
import logging
import httpx
from config import config

logger = logging.getLogger(__name__)
_GRAPH_BASE = "https://graph.facebook.com/v19.0"


def get(endpoint: str, params: dict = None) -> dict:
    """Authenticated GET request to the Instagram Graph API."""
    r = httpx.get(
        f"{_GRAPH_BASE}/{endpoint}",
        params={"access_token": config.instagram_access_token, **(params or {})},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def account_id() -> str:
    return config.instagram_business_account_id

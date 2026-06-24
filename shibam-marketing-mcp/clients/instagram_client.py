"""Instagram Graph API client."""
import logging
import httpx
from config import config, NotConfiguredError

logger = logging.getLogger(__name__)
_GRAPH_BASE = "https://graph.facebook.com/v19.0"


def get(endpoint: str, params: dict = None) -> dict:
    """Authenticated GET request to the Instagram Graph API."""
    if not config.instagram_ready:
        raise NotConfiguredError(
            "Instagram not configured. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID. "
            "Use the same System User Token as Meta Ads — add instagram_basic and "
            "instagram_manage_insights permissions."
        )
    r = httpx.get(
        f"{_GRAPH_BASE}/{endpoint}",
        params={"access_token": config.instagram_access_token, **(params or {})},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def account_id() -> str:
    return config.instagram_business_account_id

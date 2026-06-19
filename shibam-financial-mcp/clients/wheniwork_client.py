"""WhenIWork API v2 client."""
import logging
import httpx
from config import config, NotConfiguredError

logger = logging.getLogger(__name__)
_BASE = "https://api.wheniwork.com/2"


def _headers() -> dict:
    return {
        "W-Token": config.wheniwork_api_key,
        "Content-Type": "application/json",
    }


def get(path: str, params: dict = None) -> dict:
    """Authenticated GET request to WhenIWork API."""
    if not config.wheniwork_ready:
        raise NotConfiguredError(
            "WhenIWork not configured. Set WHENIWORK_API_KEY and WHENIWORK_ACCOUNT_ID. "
            "Find your API key at: WhenIWork web app → Account Settings → API."
        )
    r = httpx.get(f"{_BASE}{path}", headers=_headers(), params=params or {}, timeout=20)
    r.raise_for_status()
    return r.json()


def get_shifts(start_date: str, end_date: str) -> list:
    """Fetch all shifts in a date range."""
    data = get("/shifts", params={
        "start": start_date,
        "end": end_date,
        "account_id": config.wheniwork_account_id,
    })
    return data.get("shifts", [])


def get_users() -> dict:
    """Return a dict of user_id -> user_dict for all employees."""
    data = get("/users")
    return {str(u["id"]): u for u in data.get("users", [])}


def get_positions() -> dict:
    """Return a dict of position_id -> position name."""
    data = get("/positions")
    return {str(p["id"]): p.get("name", "Unknown") for p in data.get("positions", [])}

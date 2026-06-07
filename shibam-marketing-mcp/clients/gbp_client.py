"""Google Business Profile API and Places API clients."""
import logging
import httpx
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from config import config

logger = logging.getLogger(__name__)
PLACES_BASE = "https://maps.googleapis.com/maps/api/place"


def _gbp_credentials() -> Credentials:
    """Build OAuth credentials from the Google Ads refresh token.
    The same OAuth client covers GBP if the business.manage scope was requested."""
    return Credentials(
        token=None,
        refresh_token=config.google_ads_refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=config.google_ads_client_id,
        client_secret=config.google_ads_client_secret,
        scopes=["https://www.googleapis.com/auth/business.manage"],
    )


def get_reviews_service():
    """Return a Google Business Profile reviews API service."""
    return build("mybusiness", "v4", credentials=_gbp_credentials(), cache_discovery=False)


def get_info_service():
    """Return a Google Business Profile account management API service."""
    return build(
        "mybusinessaccountmanagement", "v1",
        credentials=_gbp_credentials(),
        cache_discovery=False,
    )


def places_find(query: str) -> dict:
    """Find a place by text query."""
    r = httpx.get(
        f"{PLACES_BASE}/findplacefromtext/json",
        params={
            "input": query,
            "inputtype": "textquery",
            "fields": "place_id,name,rating,user_ratings_total,price_level",
            "key": config.google_places_api_key,
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def places_details(place_id: str) -> dict:
    """Get full place details by place_id."""
    r = httpx.get(
        f"{PLACES_BASE}/details/json",
        params={
            "place_id": place_id,
            "fields": "name,rating,user_ratings_total,price_level,opening_hours,formatted_address",
            "key": config.google_places_api_key,
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json().get("result", {})

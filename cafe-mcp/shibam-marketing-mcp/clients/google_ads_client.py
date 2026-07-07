"""Initializes and caches the Google Ads API client."""
import logging
from typing import Optional
from google.ads.googleads.client import GoogleAdsClient
from config import config, NotConfiguredError

logger = logging.getLogger(__name__)
_client: Optional[GoogleAdsClient] = None


def get_client() -> GoogleAdsClient:
    """Return a cached Google Ads client, initializing on first call."""
    global _client
    if not config.google_ads_ready:
        raise NotConfiguredError(
            "Google Ads not configured. Add GOOGLE_ADS_REFRESH_TOKEN to your .env, "
            "then run: python scripts/get_refresh_token.py"
        )
    if _client is None:
        credentials = {
            "developer_token": config.google_ads_developer_token,
            "client_id": config.google_ads_client_id,
            "client_secret": config.google_ads_client_secret,
            "refresh_token": config.google_ads_refresh_token,
            "use_proto_plus": True,
        }
        if config.google_ads_login_customer_id:
            credentials["login_customer_id"] = config.google_ads_login_customer_id
        _client = GoogleAdsClient.load_from_dict(credentials)
        logger.info("Google Ads client initialized for customer %s", config.google_ads_customer_id)
    return _client


def get_service(service_name: str):
    """Return a named Google Ads service object."""
    return get_client().get_service(service_name)


def run_query(query: str) -> list:
    """Run a GAQL query and return all rows as a list."""
    service = get_service("GoogleAdsService")
    request = get_client().get_type("SearchGoogleAdsStreamRequest")
    request.customer_id = config.google_ads_customer_id
    request.query = query
    rows = []
    stream = service.search_stream(request=request)
    for batch in stream:
        rows.extend(batch.results)
    return rows

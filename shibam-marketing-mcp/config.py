"""Loads and validates all environment variables at startup."""
import os
from dataclasses import dataclass
from typing import Optional
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    # Server
    port: int
    server_name: str

    # Google Ads
    google_ads_developer_token: str
    google_ads_client_id: str
    google_ads_client_secret: str
    google_ads_refresh_token: str
    google_ads_customer_id: str
    google_ads_login_customer_id: Optional[str]

    # Meta Ads
    meta_access_token: str
    meta_ad_account_id: str
    meta_app_id: str
    meta_app_secret: str

    # Toast
    toast_api_pending: bool
    toast_client_id: str
    toast_client_secret: str
    toast_restaurant_guid: str
    toast_environment: str

    # Google Business Profile
    gbp_account_id: str
    gbp_location_id: str
    google_places_api_key: str

    # Instagram
    instagram_access_token: str
    instagram_business_account_id: str


def _get(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def _require(key: str, errors: list) -> str:
    val = _get(key)
    if not val:
        errors.append(key)
    return val


def load_config() -> Config:
    errors: list = []
    toast_pending = _get("TOAST_API_PENDING", "true").lower() == "true"

    cfg = Config(
        port=int(_get("PORT", "8000")),
        server_name=_get("MCP_SERVER_NAME", "shibam-marketing-mcp"),
        google_ads_developer_token=_require("GOOGLE_ADS_DEVELOPER_TOKEN", errors),
        google_ads_client_id=_require("GOOGLE_ADS_CLIENT_ID", errors),
        google_ads_client_secret=_require("GOOGLE_ADS_CLIENT_SECRET", errors),
        google_ads_refresh_token=_require("GOOGLE_ADS_REFRESH_TOKEN", errors),
        google_ads_customer_id=_get("GOOGLE_ADS_CUSTOMER_ID", "3307041753"),
        google_ads_login_customer_id=_get("GOOGLE_ADS_LOGIN_CUSTOMER_ID") or None,
        meta_access_token=_require("META_ACCESS_TOKEN", errors),
        meta_ad_account_id=_get("META_AD_ACCOUNT_ID", "act_817875271884127"),
        meta_app_id=_require("META_APP_ID", errors),
        meta_app_secret=_require("META_APP_SECRET", errors),
        toast_api_pending=toast_pending,
        toast_client_id=_get("TOAST_CLIENT_ID"),
        toast_client_secret=_get("TOAST_CLIENT_SECRET"),
        toast_restaurant_guid=_get("TOAST_RESTAURANT_GUID"),
        toast_environment=_get("TOAST_ENVIRONMENT", "production"),
        gbp_account_id=_require("GBP_ACCOUNT_ID", errors),
        gbp_location_id=_require("GBP_LOCATION_ID", errors),
        google_places_api_key=_require("GOOGLE_PLACES_API_KEY", errors),
        instagram_access_token=_require("INSTAGRAM_ACCESS_TOKEN", errors),
        instagram_business_account_id=_require("INSTAGRAM_BUSINESS_ACCOUNT_ID", errors),
    )

    if errors:
        missing = "\n".join(f"  • {e}" for e in errors)
        raise EnvironmentError(
            f"Cannot start shibam-marketing-mcp — missing required environment variables:\n{missing}\n"
            "Copy .env.example to .env and fill in all values."
        )

    return cfg


config = load_config()

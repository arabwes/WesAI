"""Configuration resolution.

Single-tenant mode: values come from environment variables (loaded once).
Multi-tenant mode: when a request carries an authenticated tenant context
(see mcp_common.middleware), values come from that tenant's stored settings
and encrypted credentials instead. Precedence: tenant > env.

The module-level `config` object is a proxy — every attribute access resolves
against the current request's tenant, so tools and clients keep using
`config.x` unchanged.
"""
import logging
import os
import sys
import pathlib
from dataclasses import dataclass, field
from typing import Optional
from dotenv import load_dotenv

# Monorepo path fallback so `import mcp_common` works without pip install
_COMMON = pathlib.Path(__file__).resolve().parent.parent / "mcp-common"
if str(_COMMON) not in sys.path and _COMMON.exists():
    sys.path.insert(0, str(_COMMON))

load_dotenv()
logger = logging.getLogger(__name__)


class NotConfiguredError(RuntimeError):
    """Raised when a tool is called but its service credentials are not set.
    _no_retry=True prevents the api_retry decorator from retrying these."""
    _no_retry = True


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

    # Computed availability flags (set in __post_init__)
    google_ads_ready: bool = field(init=False)
    meta_ready: bool = field(init=False)
    gbp_ready: bool = field(init=False)
    instagram_ready: bool = field(init=False)
    toast_ready: bool = field(init=False)

    def __post_init__(self):
        self.google_ads_ready = all([
            self.google_ads_developer_token,
            self.google_ads_client_id,
            self.google_ads_client_secret,
            self.google_ads_refresh_token,
        ])
        self.meta_ready = all([
            self.meta_access_token,
            self.meta_app_id,
            self.meta_app_secret,
        ])
        self.gbp_ready = all([
            self.google_ads_refresh_token,
            self.gbp_account_id,
            self.gbp_location_id,
            self.google_places_api_key,
        ])
        self.instagram_ready = all([
            self.instagram_access_token,
            self.instagram_business_account_id,
        ])
        self.toast_ready = (
            not self.toast_api_pending
            and bool(self.toast_client_id)
            and bool(self.toast_client_secret)
            and bool(self.toast_restaurant_guid)
        )


def _get(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def load_config() -> Config:
    toast_pending = _get("TOAST_API_PENDING", "true").lower() == "true"

    cfg = Config(
        port=int(_get("PORT", "8000")),
        server_name=_get("MCP_SERVER_NAME", "shibam-marketing-mcp"),
        google_ads_developer_token=_get("GOOGLE_ADS_DEVELOPER_TOKEN"),
        google_ads_client_id=_get("GOOGLE_ADS_CLIENT_ID"),
        google_ads_client_secret=_get("GOOGLE_ADS_CLIENT_SECRET"),
        google_ads_refresh_token=_get("GOOGLE_ADS_REFRESH_TOKEN"),
        google_ads_customer_id=_get("GOOGLE_ADS_CUSTOMER_ID"),
        google_ads_login_customer_id=_get("GOOGLE_ADS_LOGIN_CUSTOMER_ID") or None,
        meta_access_token=_get("META_ACCESS_TOKEN"),
        meta_ad_account_id=_get("META_AD_ACCOUNT_ID"),
        meta_app_id=_get("META_APP_ID"),
        meta_app_secret=_get("META_APP_SECRET"),
        toast_api_pending=toast_pending,
        toast_client_id=_get("TOAST_CLIENT_ID"),
        toast_client_secret=_get("TOAST_CLIENT_SECRET"),
        toast_restaurant_guid=_get("TOAST_RESTAURANT_GUID"),
        toast_environment=_get("TOAST_ENVIRONMENT", "production"),
        gbp_account_id=_get("GBP_ACCOUNT_ID"),
        gbp_location_id=_get("GBP_LOCATION_ID"),
        google_places_api_key=_get("GOOGLE_PLACES_API_KEY"),
        instagram_access_token=_get("INSTAGRAM_ACCESS_TOKEN"),
        instagram_business_account_id=_get("INSTAGRAM_BUSINESS_ACCOUNT_ID"),
    )

    groups = {
        "Google Ads": cfg.google_ads_ready,
        "Meta Ads":   cfg.meta_ready,
        "GBP":        cfg.gbp_ready,
        "Instagram":  cfg.instagram_ready,
        "Toast":      cfg.toast_ready,
    }
    for name, ready in groups.items():
        logger.info("  %-15s %s", name, "READY" if ready else "not configured")
    not_ready = [g for g, r in groups.items() if not r]
    if not_ready:
        logger.warning(
            "Unconfigured service groups: %s — tools will return setup instructions when called.",
            not_ready,
        )

    return cfg


_env_config = load_config()


def _config_from_tenant(tenant) -> Config:
    """Build a Config from a tenant's stored settings + decrypted credentials.

    Credential bundle services: 'google_ads', 'meta', 'instagram', 'toast',
    'gbp'. Non-secret identifiers live in tenant settings.
    """
    s = tenant.settings
    gads = tenant.credential("google_ads") or {}
    meta = tenant.credential("meta") or {}
    ig = tenant.credential("instagram") or {}
    toast = tenant.credential("toast") or {}
    gbp = tenant.credential("gbp") or {}

    return Config(
        port=_env_config.port,
        server_name=_env_config.server_name,
        google_ads_developer_token=gads.get("developer_token", ""),
        google_ads_client_id=gads.get("client_id", ""),
        google_ads_client_secret=gads.get("client_secret", ""),
        google_ads_refresh_token=gads.get("refresh_token", ""),
        google_ads_customer_id=s.get("google_ads_customer_id", ""),
        google_ads_login_customer_id=s.get("google_ads_login_customer_id") or None,
        meta_access_token=meta.get("access_token", ""),
        meta_ad_account_id=s.get("meta_ad_account_id", ""),
        meta_app_id=meta.get("app_id", ""),
        meta_app_secret=meta.get("app_secret", ""),
        toast_api_pending=bool(s.get("toast_api_pending", not bool(toast))),
        toast_client_id=toast.get("client_id", ""),
        toast_client_secret=toast.get("client_secret", ""),
        toast_restaurant_guid=toast.get("restaurant_guid", ""),
        toast_environment=toast.get("environment", "production"),
        gbp_account_id=s.get("gbp_account_id", ""),
        gbp_location_id=s.get("gbp_location_id", ""),
        google_places_api_key=gbp.get("places_api_key", ""),
        instagram_access_token=ig.get("access_token", ""),
        instagram_business_account_id=s.get("instagram_business_account_id", ""),
    )


def current_config() -> Config:
    """Tenant-scoped config if a request tenant is set; env config otherwise."""
    try:
        from mcp_common.tenant import maybe_tenant
        tenant = maybe_tenant()
    except ImportError:
        tenant = None
    if tenant is None:
        return _env_config
    return _config_from_tenant(tenant)


class _ConfigProxy:
    """Resolves every attribute against the current request's tenant, so all
    existing `config.x` call sites become tenant-aware without modification."""

    def __getattr__(self, name):
        return getattr(current_config(), name)


config = _ConfigProxy()

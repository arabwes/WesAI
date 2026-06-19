"""Loads all environment variables at startup. Missing credentials are logged as warnings;
the server starts and tools for unconfigured services return setup instructions."""
import logging
import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

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

    # QuickBooks
    qb_client_id: str
    qb_client_secret: str
    qb_refresh_token: str
    qb_realm_id: str
    qb_environment: str

    # Toast (reuse from marketing server)
    toast_api_pending: bool
    toast_client_id: str
    toast_client_secret: str
    toast_restaurant_guid: str
    toast_environment: str

    # Google / Gmail / Sheets
    google_client_id: str
    google_client_secret: str
    google_refresh_token: str
    sheets_inventory_id: str
    sheets_ledger_id: str

    # WhenIWork
    wheniwork_api_key: str
    wheniwork_account_id: str

    # Vendor domains (dynamic — loaded separately)
    vendor_domains: dict

    # Computed availability flags (set in __post_init__)
    qb_ready: bool = field(init=False)
    google_ready: bool = field(init=False)
    wheniwork_ready: bool = field(init=False)
    toast_ready: bool = field(init=False)

    def __post_init__(self):
        self.qb_ready = all([
            self.qb_client_id,
            self.qb_client_secret,
            self.qb_refresh_token,
            self.qb_realm_id,
        ])
        self.google_ready = all([
            self.google_client_id,
            self.google_client_secret,
            self.google_refresh_token,
            self.sheets_inventory_id,
        ])
        self.wheniwork_ready = all([
            self.wheniwork_api_key,
            self.wheniwork_account_id,
        ])
        self.toast_ready = (
            not self.toast_api_pending
            and bool(self.toast_client_id)
            and bool(self.toast_client_secret)
            and bool(self.toast_restaurant_guid)
        )


def _get(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def _load_vendor_domains() -> dict:
    """Load all VENDOR_* env vars dynamically — no code change needed for new vendors."""
    vendors = {}
    for key, val in os.environ.items():
        if key.startswith("VENDOR_") and val.strip():
            name = key[len("VENDOR_"):].replace("_", " ").title()
            vendors[name] = val.strip().lower()
    return vendors


def load_config() -> Config:
    toast_pending = _get("TOAST_API_PENDING", "true").lower() == "true"

    cfg = Config(
        port=int(_get("PORT", "8001")),
        server_name=_get("MCP_SERVER_NAME", "shibam-financial-mcp"),
        qb_client_id=_get("QB_CLIENT_ID"),
        qb_client_secret=_get("QB_CLIENT_SECRET"),
        qb_refresh_token=_get("QB_REFRESH_TOKEN"),
        qb_realm_id=_get("QB_REALM_ID"),
        qb_environment=_get("QB_ENVIRONMENT", "production"),
        toast_api_pending=toast_pending,
        toast_client_id=_get("TOAST_CLIENT_ID"),
        toast_client_secret=_get("TOAST_CLIENT_SECRET"),
        toast_restaurant_guid=_get("TOAST_RESTAURANT_GUID"),
        toast_environment=_get("TOAST_ENVIRONMENT", "production"),
        google_client_id=_get("GOOGLE_CLIENT_ID"),
        google_client_secret=_get("GOOGLE_CLIENT_SECRET"),
        google_refresh_token=_get("GOOGLE_REFRESH_TOKEN"),
        sheets_inventory_id=_get("GOOGLE_SHEETS_INVENTORY_ID"),
        sheets_ledger_id=_get("GOOGLE_SHEETS_LEDGER_ID"),
        wheniwork_api_key=_get("WHENIWORK_API_KEY"),
        wheniwork_account_id=_get("WHENIWORK_ACCOUNT_ID"),
        vendor_domains=_load_vendor_domains(),
    )

    groups = {
        "Gmail/Sheets": cfg.google_ready,
        "Toast":        cfg.toast_ready,
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


config = load_config()

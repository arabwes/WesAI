"""Loads and validates all environment variables at startup."""
import os
from dataclasses import dataclass, field
from typing import Optional
from dotenv import load_dotenv

load_dotenv()


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

    # Claude API
    anthropic_api_key: str

    # WhenIWork
    wheniwork_api_key: str
    wheniwork_account_id: str

    # Vendor domains (dynamic — loaded separately)
    vendor_domains: dict


def _get(key: str, default: str = "") -> str:
    return os.getenv(key, default).strip()


def _require(key: str, errors: list) -> str:
    val = _get(key)
    if not val:
        errors.append(key)
    return val


def _load_vendor_domains() -> dict:
    """Load all VENDOR_* env vars dynamically — no code change needed for new vendors."""
    vendors = {}
    for key, val in os.environ.items():
        if key.startswith("VENDOR_") and val.strip():
            name = key[len("VENDOR_"):].replace("_", " ").title()
            vendors[name] = val.strip().lower()
    return vendors


def load_config() -> Config:
    errors: list = []
    toast_pending = _get("TOAST_API_PENDING", "true").lower() == "true"

    cfg = Config(
        port=int(_get("PORT", "8001")),
        server_name=_get("MCP_SERVER_NAME", "shibam-financial-mcp"),
        qb_client_id=_require("QB_CLIENT_ID", errors),
        qb_client_secret=_require("QB_CLIENT_SECRET", errors),
        qb_refresh_token=_require("QB_REFRESH_TOKEN", errors),
        qb_realm_id=_require("QB_REALM_ID", errors),
        qb_environment=_get("QB_ENVIRONMENT", "production"),
        toast_api_pending=toast_pending,
        toast_client_id=_get("TOAST_CLIENT_ID"),
        toast_client_secret=_get("TOAST_CLIENT_SECRET"),
        toast_restaurant_guid=_get("TOAST_RESTAURANT_GUID"),
        toast_environment=_get("TOAST_ENVIRONMENT", "production"),
        google_client_id=_require("GOOGLE_CLIENT_ID", errors),
        google_client_secret=_require("GOOGLE_CLIENT_SECRET", errors),
        google_refresh_token=_require("GOOGLE_REFRESH_TOKEN", errors),
        sheets_inventory_id=_require("GOOGLE_SHEETS_INVENTORY_ID", errors),
        sheets_ledger_id=_get("GOOGLE_SHEETS_LEDGER_ID"),  # Optional — auto-created if missing
        anthropic_api_key=_require("ANTHROPIC_API_KEY", errors),
        wheniwork_api_key=_require("WHENIWORK_API_KEY", errors),
        wheniwork_account_id=_require("WHENIWORK_ACCOUNT_ID", errors),
        vendor_domains=_load_vendor_domains(),
    )

    if errors:
        missing = "\n".join(f"  • {e}" for e in errors)
        raise EnvironmentError(
            f"Cannot start shibam-financial-mcp — missing required environment variables:\n{missing}\n"
            "Copy .env.example to .env and fill in all values."
        )

    return cfg


config = load_config()

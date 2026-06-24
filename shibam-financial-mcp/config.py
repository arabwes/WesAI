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
    financial_dashboard_sheet_id: str

    # Claude API
    anthropic_api_key: str

    # WhenIWork
    wheniwork_api_key: str
    wheniwork_account_id: str

    # Vendor domains (dynamic — loaded separately)
    vendor_domains: dict

    @property
    def qb_ready(self) -> bool:
        return bool(self.qb_client_id and self.qb_client_secret and self.qb_refresh_token and self.qb_realm_id)

    @property
    def google_ready(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret and self.google_refresh_token)

    @property
    def sheets_ready(self) -> bool:
        return self.google_ready and bool(self.sheets_inventory_id)

    @property
    def gmail_ready(self) -> bool:
        return self.google_ready

    @property
    def anthropic_ready(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def wheniwork_ready(self) -> bool:
        return bool(self.wheniwork_api_key and self.wheniwork_account_id)

    @property
    def missing_vars(self) -> list:
        missing = []
        if not self.qb_client_id: missing.append("QB_CLIENT_ID")
        if not self.qb_client_secret: missing.append("QB_CLIENT_SECRET")
        if not self.qb_refresh_token: missing.append("QB_REFRESH_TOKEN")
        if not self.qb_realm_id: missing.append("QB_REALM_ID")
        if not self.google_client_id: missing.append("GOOGLE_CLIENT_ID")
        if not self.google_client_secret: missing.append("GOOGLE_CLIENT_SECRET")
        if not self.google_refresh_token: missing.append("GOOGLE_REFRESH_TOKEN")
        if not self.sheets_inventory_id: missing.append("GOOGLE_SHEETS_INVENTORY_ID")
        if not self.anthropic_api_key: missing.append("ANTHROPIC_API_KEY")
        if not self.wheniwork_api_key: missing.append("WHENIWORK_API_KEY")
        if not self.wheniwork_account_id: missing.append("WHENIWORK_ACCOUNT_ID")
        return missing


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
    toast_pending = _get("TOAST_API_PENDING", "true").lower() == "true"

    return Config(
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
        financial_dashboard_sheet_id=_get("FINANCIAL_DASHBOARD_SHEET_ID"),
        anthropic_api_key=_get("ANTHROPIC_API_KEY"),
        wheniwork_api_key=_get("WHENIWORK_API_KEY"),
        wheniwork_account_id=_get("WHENIWORK_ACCOUNT_ID"),
        vendor_domains=_load_vendor_domains(),
    )


config = load_config()

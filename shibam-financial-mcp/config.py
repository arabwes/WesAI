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

    # OpenAI API (used by clients/claude_parser.py for structured invoice extraction)
    openai_api_key: str

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
    def openai_ready(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def wheniwork_ready(self) -> bool:
        return bool(self.wheniwork_api_key and self.wheniwork_account_id)

    @property
    def toast_ready(self) -> bool:
        return (
            not self.toast_api_pending
            and bool(self.toast_client_id)
            and bool(self.toast_client_secret)
            and bool(self.toast_restaurant_guid)
        )

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
        financial_dashboard_sheet_id=_get("FINANCIAL_DASHBOARD_SHEET_ID"),
        anthropic_api_key=_get("ANTHROPIC_API_KEY"),
        openai_api_key=_get("OPENAI_API_KEY"),
        wheniwork_api_key=_get("WHENIWORK_API_KEY"),
        wheniwork_account_id=_get("WHENIWORK_ACCOUNT_ID"),
        vendor_domains=_load_vendor_domains(),
    )

    groups = {
        "QuickBooks":   cfg.qb_ready,
        "Gmail/Sheets": cfg.google_ready,
        "Claude API":   cfg.anthropic_ready,
        "WhenIWork":    cfg.wheniwork_ready,
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


_env_config = load_config()


def _config_from_tenant(tenant) -> Config:
    """Build a Config from a tenant's stored settings + decrypted credentials.

    Credential bundle services: 'quickbooks', 'toast', 'google', 'wheniwork',
    'anthropic', 'openai'. Everything else lives in tenant settings.
    """
    s = tenant.settings
    qb = tenant.credential("quickbooks") or {}
    toast = tenant.credential("toast") or {}
    google = tenant.credential("google") or {}
    wiw = tenant.credential("wheniwork") or {}
    anthropic = tenant.credential("anthropic") or {}
    openai_c = tenant.credential("openai") or {}

    return Config(
        port=_env_config.port,
        server_name=_env_config.server_name,
        qb_client_id=qb.get("client_id", ""),
        qb_client_secret=qb.get("client_secret", ""),
        qb_refresh_token=qb.get("refresh_token", ""),
        qb_realm_id=qb.get("realm_id", ""),
        qb_environment=qb.get("environment", "production"),
        toast_api_pending=bool(s.get("toast_api_pending", not bool(toast))),
        toast_client_id=toast.get("client_id", ""),
        toast_client_secret=toast.get("client_secret", ""),
        toast_restaurant_guid=toast.get("restaurant_guid", ""),
        toast_environment=toast.get("environment", "production"),
        google_client_id=google.get("client_id", ""),
        google_client_secret=google.get("client_secret", ""),
        google_refresh_token=google.get("refresh_token", ""),
        sheets_inventory_id=s.get("sheets_inventory_id", ""),
        sheets_ledger_id=s.get("sheets_ledger_id", ""),
        financial_dashboard_sheet_id=s.get("financial_dashboard_sheet_id", ""),
        anthropic_api_key=anthropic.get("api_key", ""),
        openai_api_key=openai_c.get("api_key", ""),
        wheniwork_api_key=wiw.get("api_key", ""),
        wheniwork_account_id=wiw.get("account_id", ""),
        vendor_domains=s.get("vendor_domains", {}),
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

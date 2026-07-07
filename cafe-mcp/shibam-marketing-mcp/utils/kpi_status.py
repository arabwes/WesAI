"""Returns emoji status indicators based on KPI thresholds.

Threshold defaults match the original hardcoded values; each is overridable
per tenant via settings (e.g. kpi_max_cpc, kpi_min_ctr_pct, ...).
"""
from typing import Optional
from mcp_common.tenant import maybe_tenant

GREEN = "\U0001f7e2"   # 🟢
YELLOW = "\U0001f7e1"  # 🟡
RED = "\U0001f534"     # 🔴


def _setting(key, default):
    t = maybe_tenant()
    return t.setting(key, default) if t else default


def status(
    value: float,
    green_threshold: float,
    yellow_threshold: float,
    higher_is_better: bool = True,
) -> str:
    """Generic threshold checker. Returns 🟢🟡🔴."""
    if higher_is_better:
        if value >= green_threshold:
            return GREEN
        elif value >= yellow_threshold:
            return YELLOW
        return RED
    else:
        # Lower is better (e.g., CPC, CPM, frequency)
        if value <= green_threshold:
            return GREEN
        elif value <= yellow_threshold:
            return YELLOW
        return RED


# ── Google Ads KPIs ──────────────────────────────────────────────────────────

def google_ctr_status(ctr_pct: float) -> str:
    """CTR — default: 🟢 ≥5% / 🟡 3–5% / 🔴 <3% (setting: kpi_min_ctr_pct)."""
    green = float(_setting("kpi_min_ctr_pct", 5.0))
    yellow = float(_setting("kpi_min_ctr_pct_yellow", 3.0))
    return status(ctr_pct, green, yellow, higher_is_better=True)


def google_cpc_status(cpc: float) -> str:
    """CPC — default: 🟢 ≤$1.50 / 🟡 $1.50–$2.00 / 🔴 >$2.00 (setting: kpi_max_cpc)."""
    green = float(_setting("kpi_max_cpc", 1.50))
    yellow = float(_setting("kpi_max_cpc_yellow", 2.00))
    return status(cpc, green, yellow, higher_is_better=False)


def google_conv_rate_status(rate_pct: float) -> str:
    """Conversion rate — default: 🟢 ≥8% / 🟡 5–8% / 🔴 <5% (setting: kpi_min_conversion_pct)."""
    green = float(_setting("kpi_min_conversion_pct", 8.0))
    yellow = float(_setting("kpi_min_conversion_pct_yellow", 5.0))
    return status(rate_pct, green, yellow, higher_is_better=True)


def google_cost_per_conv_status(cost: float) -> str:
    """Cost per conversion — default: 🟢 ≤$4 / 🟡 $4–$6 / 🔴 >$6 (setting: kpi_max_cost_per_conversion)."""
    green = float(_setting("kpi_max_cost_per_conversion", 4.0))
    yellow = float(_setting("kpi_max_cost_per_conversion_yellow", 6.0))
    return status(cost, green, yellow, higher_is_better=False)


def google_impression_share_status(is_pct: float) -> str:
    """Impression share — default: 🟢 ≥60% / 🟡 40–60% / 🔴 <40% (setting: kpi_min_impression_share_pct)."""
    green = float(_setting("kpi_min_impression_share_pct", 60.0))
    yellow = float(_setting("kpi_min_impression_share_pct_yellow", 40.0))
    return status(is_pct, green, yellow, higher_is_better=True)


# ── Meta Ads KPIs ────────────────────────────────────────────────────────────

def meta_cpm_status(cpm: float) -> str:
    """CPM — default: 🟢 ≤$10 / 🟡 $10–$15 / 🔴 >$15 (setting: kpi_meta_max_cpm)."""
    green = float(_setting("kpi_meta_max_cpm", 10.0))
    yellow = float(_setting("kpi_meta_max_cpm_yellow", 15.0))
    return status(cpm, green, yellow, higher_is_better=False)


def meta_link_ctr_status(ctr_pct: float) -> str:
    """Link CTR — default: 🟢 ≥1.5% / 🟡 1–1.5% / 🔴 <1% (setting: kpi_meta_min_ctr_pct)."""
    green = float(_setting("kpi_meta_min_ctr_pct", 1.5))
    yellow = float(_setting("kpi_meta_min_ctr_pct_yellow", 1.0))
    return status(ctr_pct, green, yellow, higher_is_better=True)


def meta_frequency_status(freq: float) -> str:
    """Frequency — default: 🟢 ≤2.0 / 🟡 2.0–3.0 / 🔴 >3.0 (setting: kpi_meta_max_frequency)."""
    green = float(_setting("kpi_meta_max_frequency", 2.0))
    yellow = float(_setting("kpi_meta_max_frequency_yellow", 3.0))
    return status(freq, green, yellow, higher_is_better=False)


# ── Instagram KPIs ───────────────────────────────────────────────────────────

def instagram_engagement_status(rate_pct: float) -> str:
    """Engagement rate — default: 🟢 ≥3% / 🟡 1.5–3% / 🔴 <1.5% (setting: kpi_instagram_min_engagement_pct)."""
    green = float(_setting("kpi_instagram_min_engagement_pct", 3.0))
    yellow = float(_setting("kpi_instagram_min_engagement_pct_yellow", 1.5))
    return status(rate_pct, green, yellow, higher_is_better=True)


def alert(condition: bool, message: str) -> Optional[str]:
    """Returns an alert string if condition is True, else None."""
    return f"⚠️  ALERT: {message}" if condition else None

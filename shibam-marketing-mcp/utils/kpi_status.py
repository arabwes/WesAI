"""Returns emoji status indicators based on KPI thresholds."""
from typing import Optional

GREEN = "\U0001f7e2"   # 🟢
YELLOW = "\U0001f7e1"  # 🟡
RED = "\U0001f534"     # 🔴


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
    """CTR: 🟢 ≥5% / 🟡 3–5% / 🔴 <3%"""
    return status(ctr_pct, 5.0, 3.0, higher_is_better=True)


def google_cpc_status(cpc: float) -> str:
    """CPC: 🟢 ≤$1.50 / 🟡 $1.50–$2.00 / 🔴 >$2.00"""
    return status(cpc, 1.50, 2.00, higher_is_better=False)


def google_conv_rate_status(rate_pct: float) -> str:
    """Conversion rate: 🟢 ≥8% / 🟡 5–8% / 🔴 <5%"""
    return status(rate_pct, 8.0, 5.0, higher_is_better=True)


def google_cost_per_conv_status(cost: float) -> str:
    """Cost per conversion: 🟢 ≤$4 / 🟡 $4–$6 / 🔴 >$6"""
    return status(cost, 4.0, 6.0, higher_is_better=False)


def google_impression_share_status(is_pct: float) -> str:
    """Impression share: 🟢 ≥60% / 🟡 40–60% / 🔴 <40%"""
    return status(is_pct, 60.0, 40.0, higher_is_better=True)


# ── Meta Ads KPIs ────────────────────────────────────────────────────────────

def meta_cpm_status(cpm: float) -> str:
    """CPM: 🟢 ≤$10 / 🟡 $10–$15 / 🔴 >$15"""
    return status(cpm, 10.0, 15.0, higher_is_better=False)


def meta_link_ctr_status(ctr_pct: float) -> str:
    """Link CTR: 🟢 ≥1.5% / 🟡 1–1.5% / 🔴 <1%"""
    return status(ctr_pct, 1.5, 1.0, higher_is_better=True)


def meta_frequency_status(freq: float) -> str:
    """Frequency: 🟢 ≤2.0 / 🟡 2.0–3.0 / 🔴 >3.0"""
    return status(freq, 2.0, 3.0, higher_is_better=False)


# ── Instagram KPIs ───────────────────────────────────────────────────────────

def instagram_engagement_status(rate_pct: float) -> str:
    """Engagement rate: 🟢 ≥3% / 🟡 1.5–3% / 🔴 <1.5%"""
    return status(rate_pct, 3.0, 1.5, higher_is_better=True)


def alert(condition: bool, message: str) -> Optional[str]:
    """Returns an alert string if condition is True, else None."""
    return f"⚠️  ALERT: {message}" if condition else None

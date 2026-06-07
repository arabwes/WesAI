"""Returns emoji status indicators based on KPI thresholds."""
from typing import Optional

GREEN = "\U0001f7e2"
YELLOW = "\U0001f7e1"
RED = "\U0001f534"


def status(value: float, green_threshold: float, yellow_threshold: float, higher_is_better: bool = True) -> str:
    if higher_is_better:
        if value >= green_threshold:
            return GREEN
        elif value >= yellow_threshold:
            return YELLOW
        return RED
    else:
        if value <= green_threshold:
            return GREEN
        elif value <= yellow_threshold:
            return YELLOW
        return RED


def labor_pct_status(pct: float) -> str:
    """Labor % of revenue: 🟢 ≤28% / 🟡 28–35% / 🔴 >35%"""
    return status(pct, 28.0, 35.0, higher_is_better=False)


def gross_margin_status(pct: float) -> str:
    """Gross margin: 🟢 ≥65% / 🟡 55–65% / 🔴 <55%"""
    return status(pct, 65.0, 55.0, higher_is_better=True)


def alert(condition: bool, message: str) -> Optional[str]:
    return f"⚠️  ALERT: {message}" if condition else None

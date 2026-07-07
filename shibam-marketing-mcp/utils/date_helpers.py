"""Converts human-friendly date_range strings into API-specific date formats."""
from datetime import date, timedelta
from typing import Tuple

DATE_RANGES = ("last_7_days", "last_30_days", "this_month", "last_month", "custom")


def to_start_end(
    date_range: str, start_date: str = "", end_date: str = ""
) -> Tuple[date, date]:
    """Return (start, end) date objects for a given range string."""
    today = date.today()

    if date_range == "last_7_days":
        return today - timedelta(days=7), today - timedelta(days=1)
    elif date_range == "last_30_days":
        return today - timedelta(days=30), today - timedelta(days=1)
    elif date_range == "this_month":
        return today.replace(day=1), today
    elif date_range == "last_month":
        first_of_this = today.replace(day=1)
        end = first_of_this - timedelta(days=1)
        return end.replace(day=1), end
    elif date_range == "custom":
        if not start_date or not end_date:
            raise ValueError(
                "date_range='custom' requires start_date and end_date (YYYY-MM-DD)"
            )
        return date.fromisoformat(start_date), date.fromisoformat(end_date)
    else:
        raise ValueError(
            f"Unknown date_range '{date_range}'. Valid: {', '.join(DATE_RANGES)}"
        )


def to_meta_time_range(
    date_range: str, start_date: str = "", end_date: str = ""
) -> dict:
    """Return a Meta API params dict with either date_preset or time_range."""
    presets = {
        "last_7_days": "last_7_days",
        "last_30_days": "last_30_days",
        "this_month": "this_month",
        "last_month": "last_month",
    }
    if date_range in presets:
        return {"date_preset": presets[date_range]}
    start, end = to_start_end(date_range, start_date, end_date)
    return {"time_range": f'{{"since":"{start}","until":"{end}"}}'}


def to_toast_datetime(d: date, end_of_day: bool = False) -> str:
    """Format date as Toast API ISO 8601 datetime string (UTC)."""
    if end_of_day:
        return f"{d.isoformat()}T23:59:59.000+0000"
    return f"{d.isoformat()}T00:00:00.000+0000"

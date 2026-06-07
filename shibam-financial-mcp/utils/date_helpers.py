"""Converts human-friendly date_range strings into API-specific date formats."""
from datetime import date, timedelta
from typing import Tuple

DATE_RANGES = ("last_7_days", "last_30_days", "this_month", "last_month", "custom")


def to_start_end(
    date_range: str, start_date: str = "", end_date: str = ""
) -> Tuple[date, date]:
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
            raise ValueError("date_range='custom' requires start_date and end_date (YYYY-MM-DD)")
        return date.fromisoformat(start_date), date.fromisoformat(end_date)
    else:
        raise ValueError(f"Unknown date_range '{date_range}'. Valid: {', '.join(DATE_RANGES)}")


def to_toast_datetime(d: date, end_of_day: bool = False) -> str:
    if end_of_day:
        return f"{d.isoformat()}T23:59:59.000+0000"
    return f"{d.isoformat()}T00:00:00.000+0000"


def qb_date(d: date) -> str:
    """Format date for QuickBooks API queries (YYYY-MM-DD)."""
    return d.strftime("%Y-%m-%d")


def month_range(year: int, month: int) -> Tuple[date, date]:
    """Return (first, last) dates for a given year/month."""
    from calendar import monthrange
    _, last_day = monthrange(year, month)
    return date(year, month, 1), date(year, month, last_day)

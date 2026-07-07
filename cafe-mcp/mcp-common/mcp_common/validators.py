"""Shared input validators for MCP tools. Raise ValueError with a
caller-safe message; @tool_errors/tool try-blocks surface them cleanly."""
from __future__ import annotations

import datetime as _dt

_MIN_DATE = _dt.date(2015, 1, 1)
_MAX_TEXT = 500


def parse_date(value: str, name: str = "date") -> _dt.date:
    try:
        d = _dt.date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be YYYY-MM-DD, got {value!r}")
    max_date = _dt.date.today() + _dt.timedelta(days=366)
    if not (_MIN_DATE <= d <= max_date):
        raise ValueError(f"{name} must be between {_MIN_DATE} and {max_date}")
    return d


def validate_date_range(start: str, end: str, max_days: int = 400) -> tuple[_dt.date, _dt.date]:
    s, e = parse_date(start, "start_date"), parse_date(end, "end_date")
    if e < s:
        raise ValueError("end_date must be on or after start_date")
    if (e - s).days > max_days:
        raise ValueError(f"date range too large (max {max_days} days)")
    return s, e


def validate_enum(value: str, allowed: set[str], name: str) -> str:
    if value not in allowed:
        raise ValueError(f"{name} must be one of {sorted(allowed)}, got {value!r}")
    return value


def validate_text(value: str, name: str, max_len: int = _MAX_TEXT) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    if len(value) > max_len:
        raise ValueError(f"{name} too long (max {max_len} chars)")
    return value


def validate_number(value: float, name: str, lo: float, hi: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number")
    if not (lo <= v <= hi):
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return v


def gaql_date(d) -> str:
    """Only date objects may be interpolated into GAQL — never raw strings."""
    if not isinstance(d, _dt.date):
        raise ValueError("gaql_date requires a datetime.date")
    return d.isoformat()

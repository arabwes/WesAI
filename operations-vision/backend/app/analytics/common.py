"""Shared analytics helpers: date ranges + event fetching.

Timestamps are stored UTC; analytics buckets use the store's local
timezone so "today" and "3 PM" match the clock on the wall.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import Event


def local_tz():
    return datetime.now().astimezone().tzinfo


def day_range(day: date) -> tuple[datetime, datetime]:
    """UTC datetimes spanning one local calendar day."""
    tz = local_tz()
    start = datetime.combine(day, time.min, tzinfo=tz)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


def parse_range(start: Optional[date], end: Optional[date]) -> tuple[datetime, datetime]:
    """[start, end] inclusive local dates -> UTC datetime range. Defaults to today."""
    today = datetime.now(local_tz()).date()
    s = start or today
    e = end or s
    s_utc, _ = day_range(s)
    _, e_utc = day_range(e)
    return s_utc, e_utc


def fetch_events(db: Session, event_types: list[str],
                 start_utc: datetime, end_utc: datetime) -> list[Event]:
    stmt = (
        select(Event)
        .where(Event.event_type.in_(event_types))
        .where(Event.timestamp >= start_utc)
        .where(Event.timestamp < end_utc)
        .order_by(Event.timestamp)
    )
    return list(db.execute(stmt).scalars())


def as_local(ts: datetime) -> datetime:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(local_tz())

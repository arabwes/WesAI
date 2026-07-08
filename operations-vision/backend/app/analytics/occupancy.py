"""Occupancy derived from entry/exit events (always reconcilable)."""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.analytics.common import as_local, day_range, fetch_events, local_tz
from app.events.event_types import EventType


def occupancy_now(db: Session) -> dict:
    """Current occupancy = today's entries minus exits, floored at 0."""
    today = datetime.now(local_tz()).date()
    start_utc, end_utc = day_range(today)
    events = fetch_events(
        db, [EventType.PERSON_ENTERED, EventType.PERSON_EXITED], start_utc, end_utc
    )
    entered = sum(1 for e in events if e.event_type == EventType.PERSON_ENTERED)
    exited = sum(1 for e in events if e.event_type == EventType.PERSON_EXITED)
    return {
        "current_occupancy": max(0, entered - exited),
        "entries_today": entered,
        "exits_today": exited,
        "raw_delta": entered - exited,  # negative = missed entries; reconciliation signal
    }


def occupancy_timeline(db: Session, start_utc: datetime, end_utc: datetime,
                       resolution_minutes: int = 15) -> dict:
    events = fetch_events(
        db, [EventType.PERSON_ENTERED, EventType.PERSON_EXITED], start_utc, end_utc
    )
    points: list[dict] = []
    occupancy = 0
    peak = 0
    peak_at: str | None = None

    if events:
        step = timedelta(minutes=resolution_minutes)
        bucket_end = as_local(events[0].timestamp).replace(
            minute=0, second=0, microsecond=0
        ) + step
        idx = 0
        last_local = as_local(events[-1].timestamp)
        while bucket_end - step <= last_local:
            while idx < len(events) and as_local(events[idx].timestamp) < bucket_end:
                if events[idx].event_type == EventType.PERSON_ENTERED:
                    occupancy += 1
                else:
                    occupancy = max(0, occupancy - 1)
                idx += 1
            label = bucket_end.strftime("%Y-%m-%d %H:%M")
            points.append({"time": label, "occupancy": occupancy})
            if occupancy > peak:
                peak, peak_at = occupancy, label
            bucket_end += step

    return {"timeline": points, "peak_occupancy": peak, "peak_at": peak_at}

"""Traffic analytics: entries/exits by hour and day."""

from __future__ import annotations

from collections import Counter
from datetime import date, datetime

from sqlalchemy.orm import Session

from app.analytics.common import as_local, fetch_events
from app.events.event_types import EventType


def traffic_summary(db: Session, start_utc: datetime, end_utc: datetime) -> dict:
    events = fetch_events(
        db, [EventType.PERSON_ENTERED, EventType.PERSON_EXITED], start_utc, end_utc
    )
    entries_by_hour: Counter[str] = Counter()
    exits_by_hour: Counter[str] = Counter()
    entries_by_day: Counter[str] = Counter()
    exits_by_day: Counter[str] = Counter()
    total_in = total_out = 0

    for ev in events:
        local = as_local(ev.timestamp)
        hour_key = local.strftime("%Y-%m-%d %H:00")
        day_key = local.strftime("%Y-%m-%d")
        if ev.event_type == EventType.PERSON_ENTERED:
            total_in += 1
            entries_by_hour[hour_key] += 1
            entries_by_day[day_key] += 1
        else:
            total_out += 1
            exits_by_hour[hour_key] += 1
            exits_by_day[day_key] += 1

    hours = sorted(set(entries_by_hour) | set(exits_by_hour))
    days = sorted(set(entries_by_day) | set(exits_by_day))
    busiest_hour = max(entries_by_hour, key=entries_by_hour.get) if entries_by_hour else None

    return {
        "entries": total_in,
        "exits": total_out,
        "busiest_hour": busiest_hour,
        "by_hour": [
            {"hour": h, "entries": entries_by_hour.get(h, 0), "exits": exits_by_hour.get(h, 0)}
            for h in hours
        ],
        "by_day": [
            {"day": d, "entries": entries_by_day.get(d, 0), "exits": exits_by_day.get(d, 0)}
            for d in days
        ],
    }

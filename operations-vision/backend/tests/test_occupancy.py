"""Occupancy derived from events."""

from datetime import datetime, timedelta, timezone

from app.analytics.occupancy import occupancy_now, occupancy_timeline
from app.database.models import Event


def ev(kind, ts):
    return Event(event_type=kind, timestamp=ts, confidence=1.0, meta={})


def test_occupancy_now_counts_today(db):
    now = datetime.now(timezone.utc)
    for dt_min, kind in [(50, "PERSON_ENTERED"), (40, "PERSON_ENTERED"),
                         (30, "PERSON_ENTERED"), (20, "PERSON_EXITED")]:
        db.add(ev(kind, now - timedelta(minutes=dt_min)))
    db.commit()
    o = occupancy_now(db)
    assert o["entries_today"] == 3
    assert o["exits_today"] == 1
    assert o["current_occupancy"] == 2


def test_occupancy_never_negative(db):
    now = datetime.now(timezone.utc)
    db.add(ev("PERSON_EXITED", now - timedelta(minutes=5)))
    db.add(ev("PERSON_EXITED", now - timedelta(minutes=4)))
    db.commit()
    o = occupancy_now(db)
    assert o["current_occupancy"] == 0
    assert o["raw_delta"] == -2  # reconciliation signal preserved


def test_occupancy_timeline_peak(db):
    base = datetime.now(timezone.utc) - timedelta(hours=2)
    for i in range(4):
        db.add(ev("PERSON_ENTERED", base + timedelta(minutes=i * 5)))
    db.add(ev("PERSON_EXITED", base + timedelta(minutes=30)))
    db.commit()
    t = occupancy_timeline(db, base - timedelta(hours=1), base + timedelta(hours=1))
    assert t["peak_occupancy"] == 4
    assert t["timeline"][-1]["occupancy"] == 3

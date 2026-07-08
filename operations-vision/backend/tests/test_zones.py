"""Zone transition debounce."""

from datetime import datetime, timedelta, timezone

from app.core.config import ZoneConfig
from app.vision.zones import ZoneTracker

T0 = datetime(2026, 7, 6, 12, 0, 0, tzinfo=timezone.utc)
ZONE = ZoneConfig(zone_id="q", type="queue", points=[[0, 0], [100, 0], [100, 100], [0, 100]])


def feed(tracker, track_id, points):
    out = []
    for i, p in enumerate(points):
        out.extend(tracker.update(track_id, p, T0 + timedelta(seconds=i * 0.2)))
    return out


def test_zone_entered_and_exited_with_debounce():
    zt = ZoneTracker([ZONE], debounce_samples=3)
    transitions = feed(zt, 1, [(150, 50)] * 3 + [(50, 50)] * 3 + [(150, 50)] * 3)
    assert [(t.zone_id, t.kind) for t in transitions] == [("q", "entered"), ("q", "exited")]


def test_single_sample_blip_is_ignored():
    zt = ZoneTracker([ZONE], debounce_samples=3)
    # one flicker inside, then back out - must not fire
    transitions = feed(zt, 1, [(150, 50), (50, 50), (150, 50), (150, 50), (150, 50)])
    assert transitions == []


def test_membership_query():
    zt = ZoneTracker([ZONE], debounce_samples=1)
    feed(zt, 5, [(50, 50)])
    assert zt.zones_of(5) == {"q"}

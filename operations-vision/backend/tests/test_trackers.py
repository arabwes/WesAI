"""IoU tracker lifecycle: confirm, persist, end."""

from datetime import datetime, timedelta, timezone

from app.vision.observations import Detection
from app.vision.trackers.iou_tracker import IouTracker, iou

T0 = datetime(2026, 7, 6, 12, 0, 0, tzinfo=timezone.utc)


def det(x, y, w=50, h=120):
    return Detection(class_name="person", confidence=0.9, bbox=(x, y, x + w, y + h))


def test_iou_math():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert 0.0 < iou((0, 0, 10, 10), (5, 0, 15, 10)) < 1.0


def test_track_confirmed_after_min_hits():
    tr = IouTracker("cam", min_hits=3)
    u1 = tr.update([det(100, 100)], T0)
    assert u1.started == [] and u1.active == []
    u2 = tr.update([det(102, 101)], T0 + timedelta(seconds=0.2))
    assert u2.started == []
    u3 = tr.update([det(104, 102)], T0 + timedelta(seconds=0.4))
    assert len(u3.started) == 1
    assert u3.started[0].confirmed


def test_track_keeps_same_id_while_moving():
    tr = IouTracker("cam", min_hits=1)
    first = tr.update([det(100, 100)], T0).active[0]
    for i in range(1, 10):
        active = tr.update([det(100 + i * 8, 100)], T0 + timedelta(seconds=i * 0.2)).active
        assert len(active) == 1
        assert active[0].track_id == first.track_id


def test_track_ends_after_max_age():
    tr = IouTracker("cam", min_hits=1, max_age_seconds=1.0)
    tr.update([det(100, 100)], T0)
    u = tr.update([], T0 + timedelta(seconds=2.0))
    assert len(u.ended) == 1
    assert u.active == []


def test_two_people_two_tracks():
    tr = IouTracker("cam", min_hits=1)
    u = tr.update([det(100, 100), det(500, 100)], T0)
    assert len(u.active) == 2
    ids = {t.track_id for t in u.active}
    u2 = tr.update([det(108, 100), det(492, 100)], T0 + timedelta(seconds=0.2))
    assert {t.track_id for t in u2.active} == ids


def test_flush_ends_all():
    tr = IouTracker("cam", min_hits=1)
    tr.update([det(100, 100), det(500, 100)], T0)
    u = tr.flush(T0 + timedelta(seconds=1))
    assert len(u.ended) == 2

"""Directional line crossing, hysteresis, cooldown, debounce."""

from datetime import datetime, timedelta, timezone

from app.core.config import LineConfig
from app.vision.line_crossing import LineCrossingDetector

T0 = datetime(2026, 7, 6, 12, 0, 0, tzinfo=timezone.utc)


def make_detector(direction_in="down", cooldown=2.0, hysteresis=12.0, min_disp=20.0):
    line = LineConfig(
        line_id="door",
        points=[[0, 100], [200, 100]],
        direction_in=direction_in,
        hysteresis_px=hysteresis,
        cooldown_seconds=cooldown,
        min_displacement_px=min_disp,
    )
    return LineCrossingDetector([line])


def walk(detector, track_id, ys, start=T0, dt=0.2, x=100.0):
    crossings = []
    for i, y in enumerate(ys):
        ts = start + timedelta(seconds=i * dt)
        crossings.extend(detector.update(track_id, (x, y), ts))
    return crossings


def test_inward_crossing_detected():
    det = make_detector(direction_in="down")
    crossings = walk(det, 1, [40, 60, 80, 120, 140, 160])
    assert len(crossings) == 1
    assert crossings[0].direction == "in"
    assert crossings[0].line_id == "door"


def test_outward_crossing_detected():
    det = make_detector(direction_in="down")
    crossings = walk(det, 1, [160, 140, 120, 80, 60, 40])
    assert len(crossings) == 1
    assert crossings[0].direction == "out"


def test_hover_on_line_no_event():
    """Jitter inside the hysteresis band must never fire."""
    det = make_detector()
    crossings = walk(det, 1, [95, 105, 96, 104, 99, 101, 95, 106])
    assert crossings == []


def test_bounce_beyond_hysteresis_but_within_cooldown_fires_once():
    det = make_detector(cooldown=10.0)
    # cross down, then immediately bounce back and cross again
    crossings = walk(det, 1, [40, 140, 40, 140], dt=0.3)
    assert len(crossings) == 1


def test_two_crossings_after_cooldown():
    det = make_detector(cooldown=1.0)
    ys = [40, 140]           # crossing 1 at ~0.2s
    ys += [140] * 10         # dwell 2s
    ys += [40]               # crossing 2 (out)
    crossings = walk(det, 1, ys, dt=0.2)
    assert [c.direction for c in crossings] == ["in", "out"]


def test_min_displacement_filters_tiny_hops():
    det = make_detector(hysteresis=5.0, min_disp=50.0)
    crossings = walk(det, 1, [94, 106])  # only 12px of movement
    assert crossings == []


def test_direction_left_right():
    line = LineConfig(line_id="v", points=[[100, 0], [100, 200]], direction_in="right",
                      hysteresis_px=5, min_displacement_px=10, cooldown_seconds=1)
    det = LineCrossingDetector([line])
    out = []
    for i, x in enumerate([60, 80, 120, 140]):
        out.extend(det.update(7, (x, 100.0), T0 + timedelta(seconds=i * 0.2)))
    assert len(out) == 1 and out[0].direction == "in"


def test_tracks_are_independent():
    det = make_detector()
    a = walk(det, 1, [40, 140])
    b = walk(det, 2, [40, 140])
    assert len(a) == 1 and len(b) == 1

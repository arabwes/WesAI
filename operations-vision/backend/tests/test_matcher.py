"""Cross-camera matcher: acceptance, rejection, global assignment."""

import time
from datetime import datetime, timedelta, timezone

import numpy as np

from app.core.config import MatchingSettings, TransitionConfig
from app.identity.cross_camera_matcher import (
    CrossCameraMatcher,
    NewTrackCandidate,
    PendingEndedTrack,
)
from app.identity.topology import Topology

T0 = datetime(2026, 7, 6, 14, 0, 0, tzinfo=timezone.utc)


def topo():
    return Topology([TransitionConfig(**{"from": "cam_a", "to": "cam_b"},
                                      min_seconds=1, expected_seconds=5, max_seconds=30)])


def settings(**kw):
    return MatchingSettings(new_track_batch_seconds=0.0, **kw)


def vec(seed):
    rng = np.random.default_rng(seed)
    v = rng.random(144).astype(np.float32)
    return v / v.sum() * 2.0  # normalized like a 2-band histogram


def ended(track_id, visit, app_vec, ended_at=None):
    return PendingEndedTrack(
        camera_id="cam_a", track_id=track_id, visit_id=visit,
        ended_at=ended_at or T0, velocity=(30.0, 0.0), appearance=app_vec,
        expires_monotonic=time.monotonic() + 60,
    )


def new_track(track_id, app_vec, started_at=None):
    c = NewTrackCandidate(
        camera_id="cam_b", track_id=track_id,
        started_at=started_at or (T0 + timedelta(seconds=5)),
        velocity=(30.0, 0.0), appearance=app_vec,
    )
    c.queued_monotonic = time.monotonic() - 10  # batch window elapsed
    return c


def test_high_confidence_match_accepted():
    m = CrossCameraMatcher(topo(), settings())
    v = vec(1)
    m.add_ended_track(ended(1, "V-1", v))
    m.queue_new_track(new_track(9, v))
    results = m.process()
    assert len(results) == 1
    assert results[0].ended_track.visit_id == "V-1"
    assert results[0].score.combined >= 0.9
    assert m.accepted_count == 1


def test_impossible_topology_rejected():
    """cam_b -> cam_a is not in the topology: no match, prefer unknown."""
    m = CrossCameraMatcher(topo(), settings())
    v = vec(1)
    # ended on cam_b, new on cam_b -> same camera, skipped; and reverse dir impossible
    t = ended(1, "V-1", v)
    t.camera_id = "cam_b"
    m.add_ended_track(t)
    m.queue_new_track(new_track(9, v))
    assert m.process() == []


def test_out_of_time_window_rejected():
    m = CrossCameraMatcher(topo(), settings())
    v = vec(1)
    m.add_ended_track(ended(1, "V-1", v))
    m.queue_new_track(new_track(9, v, started_at=T0 + timedelta(seconds=300)))
    assert m.process() == []


def test_low_appearance_similarity_rejected():
    """Different clothing + neutral timing must fall below thresholds."""
    s = settings(auto_associate_threshold=0.95, conditional_threshold=0.90)
    m = CrossCameraMatcher(topo(), s)
    m.add_ended_track(ended(1, "V-1", vec(1)))
    m.queue_new_track(new_track(9, vec(999), started_at=T0 + timedelta(seconds=25)))
    assert m.process() == []
    assert m.rejected_count == 1


def test_global_assignment_prefers_best_pairing():
    """Two people swap cameras simultaneously: Hungarian must pair by
    appearance, not greedily by arrival order."""
    m = CrossCameraMatcher(topo(), settings())
    red, blue = vec(7), vec(8)
    m.add_ended_track(ended(1, "V-red", red))
    m.add_ended_track(ended(2, "V-blue", blue))
    m.queue_new_track(new_track(10, blue))
    m.queue_new_track(new_track(11, red))
    results = m.process()
    pairing = {r.new_track.track_id: r.ended_track.visit_id for r in results}
    assert pairing == {10: "V-blue", 11: "V-red"}


def test_pending_tracks_expire():
    m = CrossCameraMatcher(topo(), settings())
    t = ended(1, "V-1", vec(1))
    t.expires_monotonic = time.monotonic() - 1
    m.add_ended_track(t)
    m.queue_new_track(new_track(9, vec(1)))
    assert m.process() == []

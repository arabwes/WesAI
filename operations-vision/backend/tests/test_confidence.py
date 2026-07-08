"""Transition timing + combined confidence scoring."""

import pytest

from app.core.config import MatchingWeights, TransitionConfig
from app.identity.confidence import combine, direction_score, temporal_score

SPEC = TransitionConfig(**{"from": "a", "to": "b"},
                        min_seconds=2, expected_seconds=10, max_seconds=30)


def test_temporal_score_peak_at_expected():
    assert temporal_score(10, SPEC) == 1.0


def test_temporal_score_zero_outside_bounds():
    assert temporal_score(1, SPEC) == 0.0
    assert temporal_score(31, SPEC) == 0.0


def test_temporal_score_monotonic_falloff():
    assert temporal_score(10, SPEC) > temporal_score(20, SPEC) > temporal_score(29, SPEC)
    assert temporal_score(10, SPEC) > temporal_score(4, SPEC) > temporal_score(2.1, SPEC)


def test_direction_score_aligned_and_opposed():
    aligned = direction_score((10, 0), (10, 0))
    opposed = direction_score((10, 0), (-10, 0))
    assert aligned == pytest.approx(1.0)
    assert opposed == pytest.approx(0.0)


def test_direction_score_none_when_stationary():
    assert direction_score((0.1, 0.1), (10, 0)) is None


def test_combine_weights_renormalize_when_missing():
    w = MatchingWeights(temporal=0.5, topology=0.5, direction=0.0, appearance=0.0)
    s = combine(0.8, 1.0, None, None, w)
    assert s.combined == pytest.approx(0.9)


def test_combine_full():
    w = MatchingWeights(temporal=0.25, topology=0.25, direction=0.25, appearance=0.25)
    s = combine(1.0, 1.0, 0.5, 0.5, w)
    assert s.combined == pytest.approx(0.75)
    d = s.as_dict()
    assert d["combined_score"] == 0.75
    assert d["temporal_score"] == 1.0

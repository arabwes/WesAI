"""Handoff confidence scoring.

Every candidate association gets component scores in [0,1] plus a
weighted combination. Missing components (e.g. no appearance vector)
are excluded and the remaining weights renormalized, so a missing
signal never silently counts as evidence for or against.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from app.core.config import MatchingWeights, TransitionConfig


@dataclass
class MatchScore:
    temporal: float
    topology: float
    direction: Optional[float]
    appearance: Optional[float]
    combined: float

    def as_dict(self) -> dict:
        return {
            "temporal_score": round(self.temporal, 3),
            "topology_score": round(self.topology, 3),
            "direction_score": None if self.direction is None else round(self.direction, 3),
            "appearance_score": None if self.appearance is None else round(self.appearance, 3),
            "combined_score": round(self.combined, 3),
        }


def temporal_score(dt_seconds: float, spec: TransitionConfig) -> float:
    """1.0 at the expected transit time, falling off toward min/max, 0 outside."""
    if dt_seconds < spec.min_seconds or dt_seconds > spec.max_seconds:
        return 0.0
    expected = spec.expected_seconds
    if dt_seconds == expected:
        return 1.0
    if dt_seconds < expected:
        span = max(expected - spec.min_seconds, 1e-6)
        frac = (expected - dt_seconds) / span
    else:
        span = max(spec.max_seconds - expected, 1e-6)
        frac = (dt_seconds - expected) / span
    # smooth falloff: 1.0 at expected, ~0.3 at the min/max boundary
    return max(0.0, 1.0 - 0.7 * frac)


def direction_score(exit_velocity: tuple[float, float],
                    entry_velocity: tuple[float, float]) -> Optional[float]:
    """Consistency of motion: leaving A moving right and appearing on B
    moving right is weak evidence of continuity. None if either side is
    (near) stationary - no signal, not negative evidence."""
    ex, ey = exit_velocity
    nx, ny = entry_velocity
    mag_e = math.hypot(ex, ey)
    mag_n = math.hypot(nx, ny)
    if mag_e < 5.0 or mag_n < 5.0:  # px/sec - too slow to be meaningful
        return None
    cos = (ex * nx + ey * ny) / (mag_e * mag_n)
    return (cos + 1.0) / 2.0


def combine(temporal: float, topology: float,
            direction: Optional[float], appearance: Optional[float],
            weights: MatchingWeights) -> MatchScore:
    parts: list[tuple[float, float]] = [
        (weights.temporal, temporal),
        (weights.topology, topology),
    ]
    if direction is not None:
        parts.append((weights.direction, direction))
    if appearance is not None:
        parts.append((weights.appearance, appearance))
    total_w = sum(w for w, _ in parts)
    combined = sum(w * s for w, s in parts) / total_w if total_w > 0 else 0.0
    return MatchScore(
        temporal=temporal,
        topology=topology,
        direction=direction,
        appearance=appearance,
        combined=combined,
    )

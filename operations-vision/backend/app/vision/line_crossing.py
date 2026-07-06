"""Directional line-crossing detection with debounce.

Robustness rules (spec section 11):
- hysteresis: a side is only "confirmed" when the point is at least
  `hysteresis_px` away from the line; hovering on the line is ignored
- cooldown: after a crossing, the same track+line pair is ignored for
  `cooldown_seconds`
- minimum displacement: the movement between the two confirming
  samples must exceed `min_displacement_px`
- direction: in/out classified by the movement vector against the
  configured `direction_in`
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, Optional

from app.core.config import LineConfig
from app.vision.observations import Point

Direction = Literal["in", "out"]

_DIR_VECTORS: dict[str, Point] = {
    "up": (0.0, -1.0),
    "down": (0.0, 1.0),
    "left": (-1.0, 0.0),
    "right": (1.0, 0.0),
}


@dataclass
class Crossing:
    line_id: str
    direction: Direction
    ts: datetime
    location: Point
    displacement: float


@dataclass
class _TrackLineState:
    confirmed_side: Optional[int] = None  # -1 / +1 once outside hysteresis band
    confirmed_point: Optional[Point] = None
    last_crossing_ts: Optional[datetime] = None


def signed_distance(p: Point, a: Point, b: Point) -> float:
    """Perpendicular distance of p from line a->b; sign = which side."""
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy)
    if length == 0:
        return 0.0
    return ((p[0] - ax) * dy - (p[1] - ay) * dx) / length


class LineCrossingDetector:
    def __init__(self, lines: list[LineConfig]) -> None:
        self.lines = [l for l in lines if len(l.points) == 2]
        # (track_id, line_id) -> state
        self._states: dict[tuple[int, str], _TrackLineState] = {}

    def reload(self, lines: list[LineConfig]) -> None:
        self.lines = [l for l in lines if len(l.points) == 2]
        self._states.clear()

    def update(self, track_id: int, point: Point, ts: datetime) -> list[Crossing]:
        crossings: list[Crossing] = []
        for line in self.lines:
            a = (line.points[0][0], line.points[0][1])
            b = (line.points[1][0], line.points[1][1])
            d = signed_distance(point, a, b)
            state = self._states.setdefault((track_id, line.line_id), _TrackLineState())

            if abs(d) < line.hysteresis_px:
                continue  # inside the dead band - not a confirmed side
            side = 1 if d > 0 else -1

            if state.confirmed_side is None:
                state.confirmed_side = side
                state.confirmed_point = point
                continue

            if side == state.confirmed_side:
                state.confirmed_point = point
                continue

            # side flipped with hysteresis satisfied -> candidate crossing
            prev_point = state.confirmed_point or point
            displacement = math.hypot(point[0] - prev_point[0], point[1] - prev_point[1])
            state.confirmed_side = side
            state.confirmed_point = point

            if displacement < line.min_displacement_px:
                continue
            if (
                state.last_crossing_ts is not None
                and (ts - state.last_crossing_ts).total_seconds() < line.cooldown_seconds
            ):
                continue

            move = (point[0] - prev_point[0], point[1] - prev_point[1])
            dir_vec = _DIR_VECTORS[line.direction_in]
            dot = move[0] * dir_vec[0] + move[1] * dir_vec[1]
            direction: Direction = "in" if dot > 0 else "out"

            state.last_crossing_ts = ts
            crossings.append(
                Crossing(
                    line_id=line.line_id,
                    direction=direction,
                    ts=ts,
                    location=point,
                    displacement=displacement,
                )
            )
        return crossings

    def forget_track(self, track_id: int) -> None:
        for key in [k for k in self._states if k[0] == track_id]:
            del self._states[key]

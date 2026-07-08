"""Polygon zones: membership tests + enter/exit transition detection."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from app.core.config import ZoneConfig
from app.vision.observations import Point


def point_in_polygon(p: Point, polygon: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon."""
    n = len(polygon)
    if n < 3:
        return False
    x, y = p
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if (yi > y) != (yj > y):
            x_int = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_int:
                inside = not inside
        j = i
    return inside


@dataclass
class ZoneTransition:
    zone_id: str
    zone_type: str
    kind: Literal["entered", "exited"]
    ts: datetime
    location: Point


@dataclass
class _TrackZoneState:
    # debounced membership + consecutive-sample counters
    inside: set[str] = field(default_factory=set)
    counters: dict[str, int] = field(default_factory=dict)


class ZoneTracker:
    """Per-camera zone membership with N-consecutive-sample debounce."""

    def __init__(self, zones: list[ZoneConfig], debounce_samples: int = 3) -> None:
        self.zones = [z for z in zones if len(z.points) >= 3]
        self.debounce = max(1, debounce_samples)
        self._states: dict[int, _TrackZoneState] = {}

    def reload(self, zones: list[ZoneConfig]) -> None:
        self.zones = [z for z in zones if len(z.points) >= 3]
        self._states.clear()

    def update(self, track_id: int, point: Point, ts: datetime) -> list[ZoneTransition]:
        state = self._states.setdefault(track_id, _TrackZoneState())
        transitions: list[ZoneTransition] = []
        for zone in self.zones:
            raw_inside = point_in_polygon(point, zone.points)
            was_inside = zone.zone_id in state.inside
            counter = state.counters.get(zone.zone_id, 0)

            if raw_inside == was_inside:
                state.counters[zone.zone_id] = 0
                continue
            counter += 1
            if counter < self.debounce:
                state.counters[zone.zone_id] = counter
                continue

            state.counters[zone.zone_id] = 0
            if raw_inside:
                state.inside.add(zone.zone_id)
                kind = "entered"
            else:
                state.inside.discard(zone.zone_id)
                kind = "exited"
            transitions.append(
                ZoneTransition(
                    zone_id=zone.zone_id,
                    zone_type=zone.type,
                    kind=kind,  # type: ignore[arg-type]
                    ts=ts,
                    location=point,
                )
            )
        return transitions

    def zones_of(self, track_id: int) -> set[str]:
        state = self._states.get(track_id)
        return set(state.inside) if state else set()

    def forget_track(self, track_id: int) -> list[ZoneTransition]:
        state = self._states.pop(track_id, None)
        return []

    @staticmethod
    def in_any(point: Point, zones: list[ZoneConfig]) -> bool:
        return any(point_in_polygon(point, z.points) for z in zones if len(z.points) >= 3)

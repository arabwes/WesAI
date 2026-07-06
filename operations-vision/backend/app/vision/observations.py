"""Core observation dataclasses shared across the vision pipeline.

These are deliberately generic: a Detection/Track can be any object
class (person today; milk jugs and trash bags later), so the future
operations features reuse the same plumbing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import numpy as np

BBox = tuple[float, float, float, float]  # x1, y1, x2, y2
Point = tuple[float, float]


@dataclass
class Detection:
    class_name: str
    confidence: float
    bbox: BBox

    @property
    def centroid(self) -> Point:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    @property
    def anchor(self) -> Point:
        """Bottom-center of the box - where the object touches the floor.

        Better than the centroid for zone membership on angled cameras.
        """
        x1, _y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, y2)

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)


@dataclass
class Track:
    """A temporarily tracked object on ONE camera. Anonymous by design."""

    track_id: int
    camera_id: str
    class_name: str
    bbox: BBox
    confidence: float
    first_seen: datetime
    last_seen: datetime
    hits: int = 1
    confirmed: bool = False
    # short position history for velocity / direction estimation
    history: list[tuple[datetime, Point]] = field(default_factory=list)
    zones: set[str] = field(default_factory=set)
    # visit-scoped, in-memory-only appearance vector (never persisted)
    appearance: Optional[np.ndarray] = None
    meta: dict[str, Any] = field(default_factory=dict)

    MAX_HISTORY = 60

    @property
    def centroid(self) -> Point:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    @property
    def anchor(self) -> Point:
        x1, _y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2.0, y2)

    @property
    def key(self) -> str:
        return f"{self.camera_id}:{self.track_id}"

    def push_history(self, ts: datetime, point: Point) -> None:
        self.history.append((ts, point))
        if len(self.history) > self.MAX_HISTORY:
            del self.history[: len(self.history) - self.MAX_HISTORY]

    def velocity(self, window: int = 5) -> Point:
        """Average px/sec velocity over the last `window` history samples."""
        if len(self.history) < 2:
            return (0.0, 0.0)
        pts = self.history[-window:]
        (t0, p0), (t1, p1) = pts[0], pts[-1]
        dt = (t1 - t0).total_seconds()
        if dt <= 0:
            return (0.0, 0.0)
        return ((p1[0] - p0[0]) / dt, (p1[1] - p0[1]) / dt)

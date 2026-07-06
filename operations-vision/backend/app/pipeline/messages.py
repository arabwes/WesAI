"""Messages flowing from camera worker threads to the coordinator.

Workers do per-frame vision work; the coordinator owns visits, events
and the database. These messages are the only contract between them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np

from app.vision.observations import Point


@dataclass
class TrackStartedMsg:
    camera_id: str
    track_id: int
    ts: datetime
    location: Point
    velocity: Point
    appearance: Optional[np.ndarray]


@dataclass
class TrackEndedMsg:
    camera_id: str
    track_id: int
    first_seen: datetime
    last_seen: datetime
    location: Point
    velocity: Point
    appearance: Optional[np.ndarray]
    zones: set[str] = field(default_factory=set)


@dataclass
class LineCrossingMsg:
    camera_id: str
    track_id: int
    line_id: str
    direction: str  # "in" | "out"
    ts: datetime
    location: Point
    camera_is_entrance: bool
    camera_is_exit: bool


@dataclass
class ZoneTransitionMsg:
    camera_id: str
    track_id: int
    zone_id: str
    zone_type: str
    kind: str  # "entered" | "exited"
    ts: datetime
    location: Point


@dataclass
class CameraStateMsg:
    camera_id: str
    state: str  # online | offline | reconnecting | disabled
    ts: datetime
    error: Optional[str] = None


PipelineMsg = (
    TrackStartedMsg | TrackEndedMsg | LineCrossingMsg | ZoneTransitionMsg | CameraStateMsg
)

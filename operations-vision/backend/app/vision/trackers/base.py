"""Tracker abstraction.

update() ingests one frame's detections and returns which tracks are
alive, newly started, and newly ended - the camera worker builds all
downstream logic (lines, zones, handoffs) purely from that.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING

from app.vision.observations import Detection, Track

if TYPE_CHECKING:
    from app.core.config import TrackingSettings


@dataclass
class TrackerUpdate:
    active: list[Track] = field(default_factory=list)
    started: list[Track] = field(default_factory=list)
    ended: list[Track] = field(default_factory=list)


class Tracker(ABC):
    @abstractmethod
    def update(self, detections: list[Detection], ts: datetime) -> TrackerUpdate: ...

    @abstractmethod
    def flush(self, ts: datetime) -> TrackerUpdate:
        """End all live tracks (camera going offline)."""


def build_tracker(settings: "TrackingSettings", camera_id: str,
                  detector_kind: str) -> Tracker:
    kind = settings.tracker
    if kind == "auto":
        # deterministic IoU tracker for mock pipelines; ByteTrack for real video
        kind = "iou" if detector_kind == "mock" else "bytetrack"
    if kind == "iou":
        from app.vision.trackers.iou_tracker import IouTracker

        return IouTracker(
            camera_id=camera_id,
            max_age_seconds=settings.max_age_seconds,
            min_hits=settings.min_hits,
            iou_threshold=settings.iou_threshold,
        )
    if kind == "bytetrack":
        from app.vision.trackers.bytetrack_tracker import ByteTrackTracker

        return ByteTrackTracker(
            camera_id=camera_id,
            max_age_seconds=settings.max_age_seconds,
            min_hits=settings.min_hits,
        )
    raise ValueError(f"unknown tracker: {kind}")

"""Deterministic IoU tracker with Hungarian assignment.

Good enough for clean detections (mock pipeline, tests) and useful as
a dependency-free fallback. Real noisy video should use ByteTrack.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np
from scipy.optimize import linear_sum_assignment

from app.vision.observations import BBox, Detection, Track
from app.vision.trackers.base import Tracker, TrackerUpdate


def iou(a: BBox, b: BBox) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / (area_a + area_b - inter)


class IouTracker(Tracker):
    def __init__(self, camera_id: str, max_age_seconds: float = 2.0,
                 min_hits: int = 3, iou_threshold: float = 0.25) -> None:
        self.camera_id = camera_id
        self.max_age = max_age_seconds
        self.min_hits = min_hits
        self.iou_threshold = iou_threshold
        self.tracks: dict[int, Track] = {}
        self._next_id = 1

    def update(self, detections: list[Detection], ts: datetime) -> TrackerUpdate:
        result = TrackerUpdate()
        live = list(self.tracks.values())

        matched_tracks: set[int] = set()
        matched_dets: set[int] = set()
        if live and detections:
            cost = np.ones((len(live), len(detections)), dtype=float)
            for i, tr in enumerate(live):
                for j, det in enumerate(detections):
                    if det.class_name != tr.class_name:
                        continue
                    cost[i, j] = 1.0 - iou(tr.bbox, det.bbox)
            rows, cols = linear_sum_assignment(cost)
            for i, j in zip(rows, cols):
                if 1.0 - cost[i, j] >= self.iou_threshold:
                    tr, det = live[i], detections[j]
                    tr.bbox = det.bbox
                    tr.confidence = det.confidence
                    tr.last_seen = ts
                    tr.hits += 1
                    tr.push_history(ts, det.anchor)
                    if not tr.confirmed and tr.hits >= self.min_hits:
                        tr.confirmed = True
                        result.started.append(tr)
                    matched_tracks.add(tr.track_id)
                    matched_dets.add(j)

        # new tracks for unmatched detections
        for j, det in enumerate(detections):
            if j in matched_dets:
                continue
            tr = Track(
                track_id=self._next_id,
                camera_id=self.camera_id,
                class_name=det.class_name,
                bbox=det.bbox,
                confidence=det.confidence,
                first_seen=ts,
                last_seen=ts,
            )
            tr.push_history(ts, det.anchor)
            if self.min_hits <= 1:
                tr.confirmed = True
                result.started.append(tr)
            self._next_id += 1
            self.tracks[tr.track_id] = tr

        # age out unmatched tracks
        for tid, tr in list(self.tracks.items()):
            if tid in matched_tracks:
                continue
            if (ts - tr.last_seen).total_seconds() > self.max_age:
                del self.tracks[tid]
                if tr.confirmed:
                    result.ended.append(tr)

        result.active = [t for t in self.tracks.values() if t.confirmed]
        return result

    def flush(self, ts: datetime) -> TrackerUpdate:
        ended = [t for t in self.tracks.values() if t.confirmed]
        self.tracks.clear()
        return TrackerUpdate(ended=ended)

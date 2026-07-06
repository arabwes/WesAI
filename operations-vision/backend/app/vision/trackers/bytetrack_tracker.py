"""ByteTrack (via `supervision`) wrapped in our Tracker interface.

supervision handles the Kalman/association internals; this wrapper
maintains our Track objects and start/end lifecycle semantics.
"""

from __future__ import annotations

from datetime import datetime

import numpy as np

from app.vision.observations import Detection, Track
from app.vision.trackers.base import Tracker, TrackerUpdate


class ByteTrackTracker(Tracker):
    def __init__(self, camera_id: str, max_age_seconds: float = 2.0,
                 min_hits: int = 3, frame_rate: float = 5.0) -> None:
        import supervision as sv

        self.camera_id = camera_id
        self.max_age = max_age_seconds
        self.min_hits = min_hits
        self._byte = sv.ByteTrack(
            frame_rate=int(max(frame_rate, 1)),
            lost_track_buffer=int(max_age_seconds * max(frame_rate, 1)),
        )
        self.tracks: dict[int, Track] = {}

    def update(self, detections: list[Detection], ts: datetime) -> TrackerUpdate:
        import supervision as sv

        result = TrackerUpdate()

        if detections:
            xyxy = np.array([d.bbox for d in detections], dtype=np.float32)
            conf = np.array([d.confidence for d in detections], dtype=np.float32)
            class_id = np.zeros(len(detections), dtype=int)
            sv_dets = sv.Detections(xyxy=xyxy, confidence=conf, class_id=class_id)
        else:
            sv_dets = sv.Detections.empty()

        tracked = self._byte.update_with_detections(sv_dets)

        seen: set[int] = set()
        for i in range(len(tracked)):
            tid = int(tracked.tracker_id[i])
            x1, y1, x2, y2 = (float(v) for v in tracked.xyxy[i])
            confidence = float(tracked.confidence[i]) if tracked.confidence is not None else 0.5
            seen.add(tid)
            tr = self.tracks.get(tid)
            if tr is None:
                tr = Track(
                    track_id=tid,
                    camera_id=self.camera_id,
                    class_name="person",
                    bbox=(x1, y1, x2, y2),
                    confidence=confidence,
                    first_seen=ts,
                    last_seen=ts,
                )
                self.tracks[tid] = tr
            tr.bbox = (x1, y1, x2, y2)
            tr.confidence = confidence
            tr.last_seen = ts
            tr.hits += 1
            tr.push_history(ts, tr.anchor)
            if not tr.confirmed and tr.hits >= self.min_hits:
                tr.confirmed = True
                result.started.append(tr)

        for tid, tr in list(self.tracks.items()):
            if tid in seen:
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

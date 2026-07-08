"""Per-camera processing worker.

One thread per camera: read frames -> throttle -> detect -> track ->
lines/zones -> emit messages. A worker failure or camera outage never
touches other cameras; the thread reconnects with capped exponential
backoff forever (or until disabled).
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from app.core.config import AppSettings, CameraConfig, LineConfig, ZoneConfig
from app.identity.appearance import extract_appearance
from app.pipeline.messages import (
    CameraStateMsg,
    LineCrossingMsg,
    PipelineMsg,
    TrackEndedMsg,
    TrackStartedMsg,
    ZoneTransitionMsg,
)
from app.vision.detectors import build_detector
from app.vision.line_crossing import LineCrossingDetector
from app.vision.observations import Detection
from app.vision.stream_reader import build_source
from app.vision.trackers import build_tracker
from app.vision.zones import ZoneTracker, point_in_polygon

log = logging.getLogger(__name__)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class CameraHealth:
    state: str = "offline"  # online | offline | reconnecting | disabled
    last_frame_at: Optional[datetime] = None
    frames_received: int = 0
    frames_processed: int = 0
    processing_fps: float = 0.0
    processing_latency_ms: float = 0.0
    decode_errors: int = 0
    reconnect_attempts: int = 0
    last_error: Optional[str] = None

    def snapshot(self) -> dict:
        return {
            "state": self.state,
            "last_frame_at": self.last_frame_at.isoformat() if self.last_frame_at else None,
            "frames_received": self.frames_received,
            "frames_processed": self.frames_processed,
            "processing_fps": round(self.processing_fps, 2),
            "processing_latency_ms": round(self.processing_latency_ms, 1),
            "decode_errors": self.decode_errors,
            "reconnect_attempts": self.reconnect_attempts,
            "last_error": self.last_error,
        }


class CameraWorker(threading.Thread):
    def __init__(self, cam: CameraConfig, settings: AppSettings,
                 out_queue: "queue.Queue[PipelineMsg]") -> None:
        super().__init__(name=f"camera-{cam.camera_id}", daemon=True)
        self.cam = cam
        self.settings = settings
        self.out = out_queue
        self.health = CameraHealth()
        self._stop_evt = threading.Event()
        self._lock = threading.Lock()
        self._last_frame: Optional[np.ndarray] = None
        self._spatial_lock = threading.Lock()
        self.line_detector = LineCrossingDetector(cam.lines)
        self.zone_tracker = ZoneTracker(cam.zones)
        self._ignore_zones: list[ZoneConfig] = list(cam.ignore_zones)
        self._fps_window: list[float] = []

    # ------------------------------------------------------------------ API

    def stop(self) -> None:
        self._stop_evt.set()

    def last_frame(self) -> Optional[np.ndarray]:
        with self._lock:
            return None if self._last_frame is None else self._last_frame.copy()

    def reload_spatial(self, lines: list[LineConfig], zones: list[ZoneConfig],
                       ignore_zones: list[ZoneConfig]) -> None:
        """Hot-reload calibration without restarting the worker."""
        with self._spatial_lock:
            self.line_detector.reload(lines)
            self.zone_tracker.reload(zones)
            self._ignore_zones = list(ignore_zones)
        log.info("camera %s: spatial config reloaded (%d lines, %d zones)",
                 self.cam.camera_id, len(lines), len(zones))

    # ------------------------------------------------------------ internals

    def _set_state(self, state: str, error: str | None = None) -> None:
        if self.health.state != state:
            self.health.state = state
            self.out.put(CameraStateMsg(
                camera_id=self.cam.camera_id, state=state, ts=utcnow(), error=error,
            ))
        if error:
            self.health.last_error = error

    def _filter_detections(self, detections: list[Detection]) -> list[Detection]:
        cfg = self.cam.processing
        out = []
        for d in detections:
            if d.class_name not in self.settings.detection.classes:
                continue
            if d.confidence < cfg.detection_confidence:
                continue
            if d.area < cfg.min_bbox_area:
                continue
            if self._ignore_zones and any(
                point_in_polygon(d.anchor, z.points)
                for z in self._ignore_zones if len(z.points) >= 3
            ):
                continue
            out.append(d)
        return out

    def run(self) -> None:  # noqa: C901 - the worker loop is inherently long
        if not self.cam.enabled:
            self._set_state("disabled")
            return

        try:
            detector = build_detector(self.settings.detection, self.cam.camera_id)
            tracker = build_tracker(
                self.settings.tracking, self.cam.camera_id,
                detector_kind=self.settings.detection.provider,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("camera %s: failed to build pipeline", self.cam.camera_id)
            self._set_state("offline", error=str(exc))
            return

        backoff = self.cam.processing.reconnect_delay_seconds
        max_backoff = self.cam.processing.max_reconnect_delay_seconds

        while not self._stop_evt.is_set():
            try:
                source = build_source(self.cam)
            except Exception as exc:  # noqa: BLE001
                self._set_state("offline", error=str(exc))
                log.error("camera %s: source config error: %s", self.cam.camera_id, exc)
                # configuration errors won't fix themselves quickly; slow retry
                if self._stop_evt.wait(max_backoff):
                    break
                continue

            if not source.open():
                self.health.reconnect_attempts += 1
                self._set_state("reconnecting", error=f"cannot open {source.describe}")
                source.close()
                if self._stop_evt.wait(backoff):
                    break
                backoff = min(backoff * 2, max_backoff)
                continue

            log.info("camera %s: connected to %s", self.cam.camera_id, source.describe)
            self._set_state("online")
            backoff = self.cam.processing.reconnect_delay_seconds
            consecutive_failures = 0
            interval = 1.0 / max(self.cam.processing.target_fps, 0.1)
            next_process = 0.0

            try:
                while not self._stop_evt.is_set():
                    ok, frame = source.read()
                    if not ok or frame is None:
                        self.health.decode_errors += 1
                        consecutive_failures += 1
                        if consecutive_failures >= 10:
                            raise ConnectionError("stream read failed repeatedly")
                        time.sleep(0.1)
                        continue
                    consecutive_failures = 0
                    self.health.frames_received += 1
                    self.health.last_frame_at = utcnow()
                    with self._lock:
                        self._last_frame = frame

                    now = time.monotonic()
                    if now < next_process:
                        continue  # frame skipping: decode all, process at target fps
                    next_process = now + interval

                    t0 = time.perf_counter()
                    ts = utcnow()
                    detections = self._filter_detections(detector.detect(frame))
                    update = tracker.update(detections, ts)
                    with self._spatial_lock:
                        self._process_tracks(frame, update, ts)
                    latency = (time.perf_counter() - t0) * 1000.0
                    self.health.frames_processed += 1
                    self.health.processing_latency_ms = latency
                    self._fps_window.append(now)
                    self._fps_window = [t for t in self._fps_window if now - t <= 5.0]
                    self.health.processing_fps = len(self._fps_window) / 5.0
            except Exception as exc:  # noqa: BLE001
                log.warning("camera %s: stream error: %s", self.cam.camera_id, exc)
                self.health.reconnect_attempts += 1
                self._set_state("reconnecting", error=str(exc))
            finally:
                # close out any live tracks so visits don't dangle
                flush = tracker.flush(utcnow())
                for tr in flush.ended:
                    self._emit_track_ended(tr, utcnow())
                source.close()

            if not self._stop_evt.is_set():
                if self._stop_evt.wait(backoff):
                    break
                backoff = min(backoff * 2, max_backoff)

        self._set_state("offline")
        try:
            detector.close()
        except Exception:  # noqa: BLE001
            pass
        log.info("camera %s: worker stopped", self.cam.camera_id)

    def _process_tracks(self, frame: np.ndarray, update, ts: datetime) -> None:
        for tr in update.started:
            tr.appearance = extract_appearance(frame, tr.bbox)
            self.out.put(TrackStartedMsg(
                camera_id=self.cam.camera_id,
                track_id=tr.track_id,
                ts=ts,
                location=tr.anchor,
                velocity=tr.velocity(),
                appearance=tr.appearance,
            ))

        for tr in update.active:
            # refresh appearance periodically (person may turn / lighting shifts)
            if tr.hits % 15 == 0:
                fresh = extract_appearance(frame, tr.bbox)
                if fresh is not None:
                    tr.appearance = fresh

            for crossing in self.line_detector.update(tr.track_id, tr.anchor, ts):
                self.out.put(LineCrossingMsg(
                    camera_id=self.cam.camera_id,
                    track_id=tr.track_id,
                    line_id=crossing.line_id,
                    direction=crossing.direction,
                    ts=crossing.ts,
                    location=crossing.location,
                    camera_is_entrance=self.cam.is_entrance,
                    camera_is_exit=self.cam.is_exit,
                ))

            for transition in self.zone_tracker.update(tr.track_id, tr.anchor, ts):
                if transition.kind == "entered":
                    tr.zones.add(transition.zone_id)
                else:
                    tr.zones.discard(transition.zone_id)
                self.out.put(ZoneTransitionMsg(
                    camera_id=self.cam.camera_id,
                    track_id=tr.track_id,
                    zone_id=transition.zone_id,
                    zone_type=transition.zone_type,
                    kind=transition.kind,
                    ts=transition.ts,
                    location=transition.location,
                ))

        for tr in update.ended:
            self._emit_track_ended(tr, ts)

    def _emit_track_ended(self, tr, ts: datetime) -> None:
        self.line_detector.forget_track(tr.track_id)
        self.zone_tracker.forget_track(tr.track_id)
        self.out.put(TrackEndedMsg(
            camera_id=self.cam.camera_id,
            track_id=tr.track_id,
            first_seen=tr.first_seen,
            last_seen=tr.last_seen,
            location=tr.anchor,
            velocity=tr.velocity(),
            appearance=tr.appearance,
            zones=set(tr.zones),
        ))

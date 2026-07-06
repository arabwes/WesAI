"""Frame sources: rtsp | video_file | webcam | mock.

All sources present the same tiny interface so the camera worker
doesn't care where frames come from.
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

import numpy as np

from app.core.config import PROJECT_ROOT, CameraConfig
from app.core.security import mask_credentials

log = logging.getLogger(__name__)


class FrameSource(ABC):
    @abstractmethod
    def open(self) -> bool: ...

    @abstractmethod
    def read(self) -> tuple[bool, Optional[np.ndarray]]: ...

    @abstractmethod
    def close(self) -> None: ...

    @property
    def describe(self) -> str:
        return type(self).__name__


class _OpenCVSource(FrameSource):
    """Shared plumbing for anything cv2.VideoCapture can open."""

    def __init__(self, target: str | int) -> None:
        self.target = target
        self.cap = None

    def open(self) -> bool:
        import cv2

        self.close()
        self.cap = cv2.VideoCapture(self.target)
        # keep latency low on live streams
        try:
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
        except Exception:  # noqa: BLE001
            pass
        ok = bool(self.cap.isOpened())
        if not ok:
            self.close()
        return ok

    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        if self.cap is None:
            return False, None
        ok, frame = self.cap.read()
        return (ok, frame if ok else None)

    def close(self) -> None:
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:  # noqa: BLE001
                pass
            self.cap = None


class RtspSource(_OpenCVSource):
    def __init__(self, url: str) -> None:
        super().__init__(url)

    @property
    def describe(self) -> str:
        return f"rtsp({mask_credentials(str(self.target))})"


class WebcamSource(_OpenCVSource):
    def __init__(self, device_index: int = 0) -> None:
        super().__init__(device_index)


class VideoFileSource(_OpenCVSource):
    """Plays a file at its native FPS; optionally loops forever."""

    def __init__(self, path: str, loop: bool = True) -> None:
        p = Path(path)
        if not p.is_absolute():
            p = PROJECT_ROOT / p
        super().__init__(str(p))
        self.path = p
        self.loop = loop
        self._frame_interval = 1 / 30.0
        self._last_read = 0.0

    def open(self) -> bool:
        import cv2

        if not self.path.exists():
            log.error("video file not found: %s", self.path)
            return False
        ok = super().open()
        if ok:
            fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
            self._frame_interval = 1.0 / max(fps, 1.0)
        return ok

    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        # pace playback to native fps so it behaves like a live camera
        now = time.monotonic()
        wait = self._frame_interval - (now - self._last_read)
        if wait > 0:
            time.sleep(wait)
        self._last_read = time.monotonic()

        ok, frame = super().read()
        if not ok and self.loop and self.cap is not None:
            import cv2

            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = super().read()
        return ok, frame


class MockSource(FrameSource):
    """Renders synthetic frames from the scenario engine.

    Actors are drawn as two-tone rectangles (shirt/pants) plus a neutral
    head disc - enough texture for appearance histograms, zero identity.
    """

    FPS = 12.0

    def __init__(self, camera_id: str) -> None:
        self.camera_id = camera_id
        self._open = False
        self._last_read = 0.0

    def open(self) -> bool:
        from app.vision.mock_scenario import get_engine

        self._open = get_engine() is not None
        if not self._open:
            log.error("mock source %s: scenario engine not initialized", self.camera_id)
        return self._open

    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        import cv2

        from app.vision.mock_scenario import get_engine

        engine = get_engine()
        if not self._open or engine is None:
            return False, None

        wait = (1.0 / self.FPS) - (time.monotonic() - self._last_read)
        if wait > 0:
            time.sleep(wait)
        self._last_read = time.monotonic()

        w, h = engine.frame_size
        frame = np.full((h, w, 3), 46, dtype=np.uint8)
        # faint floor grid so calibration screenshots have reference points
        for gx in range(0, w, 120):
            cv2.line(frame, (gx, 0), (gx, h), (58, 58, 58), 1)
        for gy in range(0, h, 120):
            cv2.line(frame, (0, gy), (w, gy), (58, 58, 58), 1)
        cv2.putText(frame, f"MOCK {self.camera_id}", (12, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (110, 110, 110), 1, cv2.LINE_AA)

        for actor, cx, cy in engine.actors_on_camera(self.camera_id):
            aw, ah = actor.size
            x1, y1 = int(cx - aw / 2), int(cy - ah)
            x2, y2 = int(cx + aw / 2), int(cy)
            mid = int(cy - ah * 0.45)
            head_r = int(aw * 0.28)
            cv2.rectangle(frame, (x1, y1 + head_r), (x2, mid), actor.shirt_color, -1)
            cv2.rectangle(frame, (x1, mid), (x2, y2), actor.pants_color, -1)
            cv2.circle(frame, (int(cx), y1 + head_r), head_r, (128, 128, 128), -1)
        return True, frame

    def close(self) -> None:
        self._open = False


def build_source(cam: CameraConfig) -> FrameSource:
    src = cam.source
    if src.type == "mock":
        return MockSource(cam.camera_id)
    if src.type == "video_file":
        return VideoFileSource(src.path or "", loop=src.loop)
    if src.type == "webcam":
        return WebcamSource(src.device_index)
    if src.type == "rtsp":
        url = src.resolve_rtsp_url()
        if not url:
            raise ValueError(
                f"camera {cam.camera_id}: RTSP url env var "
                f"{src.url_env!r} is not set"
            )
        return RtspSource(url)
    raise ValueError(f"unknown source type {src.type}")

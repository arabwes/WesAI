"""Temporary, visit-scoped appearance features.

PRIVACY DESIGN (spec sections 2 & 16):
- features are HSV color histograms of the WHOLE person crop split
  into upper/lower body bands - clothing color, not identity
- no face detection, no face crops, no embeddings from a recognition
  model, ever
- vectors live only in this in-memory store and expire on a TTL;
  they are never written to the database or disk
"""

from __future__ import annotations

import threading
import time
from typing import Optional

import numpy as np

from app.vision.observations import BBox

H_BINS = 12
S_BINS = 6
BANDS = 2  # upper body / lower body


def extract_appearance(frame: np.ndarray, bbox: BBox) -> Optional[np.ndarray]:
    """HSV histogram feature for a person crop. Returns None if unusable."""
    import cv2

    h_img, w_img = frame.shape[:2]
    x1 = int(max(0, min(bbox[0], w_img - 1)))
    y1 = int(max(0, min(bbox[1], h_img - 1)))
    x2 = int(max(0, min(bbox[2], w_img)))
    y2 = int(max(0, min(bbox[3], h_img)))
    if x2 - x1 < 8 or y2 - y1 < 16:
        return None
    crop = frame[y1:y2, x1:x2]
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)

    ch = hsv.shape[0]
    bands = [hsv[: ch // 2], hsv[ch // 2:]]
    feats = []
    for band in bands:
        hist = cv2.calcHist([band], [0, 1], None, [H_BINS, S_BINS],
                            [0, 180, 0, 256])
        hist = hist.flatten()
        total = hist.sum()
        if total > 0:
            hist = hist / total
        feats.append(hist)
    return np.concatenate(feats).astype(np.float32)


def appearance_similarity(a: Optional[np.ndarray], b: Optional[np.ndarray]) -> Optional[float]:
    """Histogram intersection in [0, 1]. None when either side is missing."""
    if a is None or b is None:
        return None
    if a.shape != b.shape:
        return None
    return float(np.minimum(a, b).sum() / BANDS)


class AppearanceStore:
    """TTL-bound in-memory store keyed by camera track."""

    def __init__(self, retention_minutes: float = 30.0) -> None:
        self.ttl = retention_minutes * 60.0
        self._data: dict[str, tuple[np.ndarray, float]] = {}
        self._lock = threading.Lock()

    def put(self, track_key: str, vector: np.ndarray) -> None:
        with self._lock:
            self._data[track_key] = (vector, time.monotonic() + self.ttl)

    def get(self, track_key: str) -> Optional[np.ndarray]:
        with self._lock:
            item = self._data.get(track_key)
            if item is None:
                return None
            vector, expires = item
            if time.monotonic() > expires:
                del self._data[track_key]
                return None
            return vector

    def drop(self, track_key: str) -> None:
        with self._lock:
            self._data.pop(track_key, None)

    def purge_expired(self) -> int:
        now = time.monotonic()
        with self._lock:
            expired = [k for k, (_, exp) in self._data.items() if now > exp]
            for k in expired:
                del self._data[k]
            return len(expired)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

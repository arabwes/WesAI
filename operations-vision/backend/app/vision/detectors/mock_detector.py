"""Mock detector: returns scenario-engine actors as detections."""

from __future__ import annotations

import random

import numpy as np

from app.vision.detectors.base import DetectionProvider
from app.vision.mock_scenario import get_engine
from app.vision.observations import Detection


class MockDetector(DetectionProvider):
    def __init__(self, camera_id: str) -> None:
        self.camera_id = camera_id
        self._noise = random.Random(hash(camera_id) & 0xFFFF)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        engine = get_engine()
        if engine is None:
            return []
        detections = []
        noise = engine.detection_noise_px
        for actor, cx, cy in engine.actors_on_camera(self.camera_id):
            w, h = actor.size
            jx = self._noise.uniform(-noise, noise)
            jy = self._noise.uniform(-noise, noise)
            x1, y1 = cx - w / 2 + jx, cy - h + jy  # (cx, cy) is the feet anchor
            x2, y2 = cx + w / 2 + jx, cy + jy
            detections.append(
                Detection(
                    class_name="person",
                    confidence=self._noise.uniform(0.82, 0.97),
                    bbox=(x1, y1, x2, y2),
                )
            )
        return detections

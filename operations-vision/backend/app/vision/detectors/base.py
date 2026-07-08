"""Detector abstraction.

The rest of the pipeline only ever sees `DetectionProvider.detect`,
so swapping YOLO for a custom model (or the mock) is a config change.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

import numpy as np

from app.vision.observations import Detection

if TYPE_CHECKING:
    from app.core.config import DetectionSettings


class DetectionProvider(ABC):
    @abstractmethod
    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Return raw detections for one frame (unfiltered)."""

    def close(self) -> None:  # pragma: no cover - optional cleanup hook
        pass


def build_detector(settings: "DetectionSettings", camera_id: str) -> DetectionProvider:
    if settings.provider == "mock":
        from app.vision.detectors.mock_detector import MockDetector

        return MockDetector(camera_id=camera_id)
    if settings.provider == "ultralytics":
        from app.vision.detectors.ultralytics_detector import UltralyticsDetector

        return UltralyticsDetector(
            model_name=settings.model,
            device=settings.device,
            classes=settings.classes,
        )
    raise ValueError(f"unknown detection provider: {settings.provider}")

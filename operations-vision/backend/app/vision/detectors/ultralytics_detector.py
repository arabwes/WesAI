"""YOLO person detector via Ultralytics.

Loaded lazily and shared per-process per model+device so multiple
camera workers reuse one model instance (inference is internally
locked; YOLO calls are thread-safe when serialized).
"""

from __future__ import annotations

import logging
import threading

import numpy as np

from app.vision.detectors.base import DetectionProvider
from app.vision.observations import Detection

log = logging.getLogger(__name__)

_models: dict[tuple[str, str], object] = {}
_models_lock = threading.Lock()
_infer_lock = threading.Lock()

# COCO ids for the classes we allow
_COCO_NAME_TO_ID = {"person": 0}


def _get_model(model_name: str, device: str):
    key = (model_name, device)
    with _models_lock:
        if key not in _models:
            from ultralytics import YOLO  # heavy import, deferred

            log.info("loading YOLO model %s on %s", model_name, device)
            model = YOLO(model_name)
            _models[key] = model
        return _models[key]


class UltralyticsDetector(DetectionProvider):
    def __init__(self, model_name: str = "yolov8n.pt", device: str = "cpu",
                 classes: list[str] | None = None) -> None:
        self.model_name = model_name
        self.device = device
        class_names = classes or ["person"]
        self.class_ids = [_COCO_NAME_TO_ID[c] for c in class_names if c in _COCO_NAME_TO_ID]
        self.id_to_name = {v: k for k, v in _COCO_NAME_TO_ID.items()}
        self._model = _get_model(model_name, device)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        with _infer_lock:
            results = self._model.predict(
                frame,
                classes=self.class_ids,
                device=self.device,
                verbose=False,
            )
        detections: list[Detection] = []
        for r in results:
            if r.boxes is None:
                continue
            boxes = r.boxes.xyxy.cpu().numpy()
            confs = r.boxes.conf.cpu().numpy()
            clss = r.boxes.cls.cpu().numpy().astype(int)
            for (x1, y1, x2, y2), conf, cls_id in zip(boxes, confs, clss):
                detections.append(
                    Detection(
                        class_name=self.id_to_name.get(cls_id, str(cls_id)),
                        confidence=float(conf),
                        bbox=(float(x1), float(y1), float(x2), float(y2)),
                    )
                )
        return detections

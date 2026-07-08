"""Calibration API: capture frames, save drawn lines/zones, hot-reload.

The frontend calibration page draws over a captured frame; PUT here
persists the geometry to cameras.yaml and reloads the running worker
without a restart.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.core.config import (
    LineConfig,
    ZoneConfig,
    cameras_file_path,
    load_cameras,
    save_cameras,
)
from app.identity.topology import Topology
from app.pipeline.manager import get_manager

router = APIRouter(prefix="/api/calibration", tags=["calibration"])


@router.get("/{camera_id}/frame")
def calibration_frame(camera_id: str) -> Response:
    import cv2

    manager = get_manager()
    frame = manager.snapshot(camera_id) if manager else None
    if frame is None:
        raise HTTPException(
            404,
            "no frame available - camera must be online to calibrate",
        )
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise HTTPException(500, "failed to encode frame")
    h, w = frame.shape[:2]
    return Response(
        content=buf.tobytes(),
        media_type="image/jpeg",
        headers={"X-Frame-Width": str(w), "X-Frame-Height": str(h)},
    )


class CalibrationPayload(BaseModel):
    lines: list[LineConfig] = Field(default_factory=list)
    zones: list[ZoneConfig] = Field(default_factory=list)
    ignore_zones: list[ZoneConfig] = Field(default_factory=list)
    role: list[str] | None = None


@router.put("/{camera_id}")
def save_calibration(camera_id: str, payload: CalibrationPayload) -> dict:
    cameras = load_cameras()
    target = next((c for c in cameras if c.camera_id == camera_id), None)
    if target is None:
        raise HTTPException(404, f"camera {camera_id} not found")

    target.lines = payload.lines
    target.zones = payload.zones
    target.ignore_zones = payload.ignore_zones
    if payload.role is not None:
        target.role = payload.role
    save_cameras(cameras)

    manager = get_manager()
    reloaded = False
    if manager is not None:
        worker = manager.get_worker(camera_id)
        if worker is not None:
            worker.cam.lines = payload.lines
            worker.cam.zones = payload.zones
            worker.cam.ignore_zones = payload.ignore_zones
            if payload.role is not None:
                worker.cam.role = payload.role
            worker.reload_spatial(payload.lines, payload.zones, payload.ignore_zones)
            reloaded = True
        # keep the manager's camera list in sync for the cameras API
        for i, cam in enumerate(manager.cameras):
            if cam.camera_id == camera_id:
                manager.cameras[i] = target

    return {
        "saved_to": str(cameras_file_path()),
        "worker_reloaded": reloaded,
        "lines": len(payload.lines),
        "zones": len(payload.zones),
        "ignore_zones": len(payload.ignore_zones),
    }


@router.get("/topology")
def get_topology() -> dict:
    manager = get_manager()
    topology = manager.topology if manager else Topology([])
    return {
        "transitions": [
            {
                "from": t.from_camera,
                "to": t.to_camera,
                "min_seconds": t.min_seconds,
                "expected_seconds": t.expected_seconds,
                "max_seconds": t.max_seconds,
            }
            for t in topology.as_list()
        ]
    }

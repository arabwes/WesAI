"""Camera listing, status, snapshots, reload."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import mask_credentials
from app.database.models import CameraStatus
from app.database.session import get_db
from app.pipeline.manager import get_manager

router = APIRouter(prefix="/api/cameras", tags=["cameras"])


def _camera_payload(cam, worker) -> dict:
    return {
        "camera_id": cam.camera_id,
        "name": cam.name or cam.camera_id,
        "enabled": cam.enabled,
        "source_type": cam.source.type,
        "role": cam.role,
        "lines": [l.model_dump() for l in cam.lines],
        "zones": [z.model_dump() for z in cam.zones],
        "ignore_zones": [z.model_dump() for z in cam.ignore_zones],
        "processing": cam.processing.model_dump(),
        "health": worker.health.snapshot() if worker else None,
    }


@router.get("")
def list_cameras() -> list[dict]:
    manager = get_manager()
    if manager is None:
        return []
    return [
        _camera_payload(cam, manager.get_worker(cam.camera_id))
        for cam in manager.cameras
    ]


@router.get("/{camera_id}")
def get_camera(camera_id: str) -> dict:
    manager = get_manager()
    if manager is None:
        raise HTTPException(503, "pipeline not running")
    for cam in manager.cameras:
        if cam.camera_id == camera_id:
            return _camera_payload(cam, manager.get_worker(camera_id))
    raise HTTPException(404, f"camera {camera_id} not found")


@router.get("/{camera_id}/status")
def camera_status(camera_id: str, db: Session = Depends(get_db)) -> dict:
    manager = get_manager()
    worker = manager.get_worker(camera_id) if manager else None
    if worker is not None:
        return {"camera_id": camera_id, "live": True, **worker.health.snapshot()}
    row = db.execute(
        select(CameraStatus).where(CameraStatus.camera_id == camera_id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"no status for camera {camera_id}")
    return {
        "camera_id": camera_id,
        "live": False,
        "state": row.state,
        "last_frame_at": row.last_frame_at.isoformat() if row.last_frame_at else None,
        "processing_fps": row.processing_fps,
        "decode_errors": row.decode_errors,
        "reconnect_attempts": row.reconnect_attempts,
        "last_error": mask_credentials(row.last_error or "") or None,
    }


@router.get("/{camera_id}/snapshot")
def camera_snapshot(camera_id: str) -> Response:
    import cv2

    manager = get_manager()
    frame = manager.snapshot(camera_id) if manager else None
    if frame is None:
        raise HTTPException(404, "no frame available (camera offline or unknown)")
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise HTTPException(500, "failed to encode frame")
    return Response(content=buf.tobytes(), media_type="image/jpeg")


@router.post("/reload")
def reload_cameras() -> dict:
    manager = get_manager()
    if manager is None:
        raise HTTPException(503, "pipeline not running")
    return manager.reload_cameras()

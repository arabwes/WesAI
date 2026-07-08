"""Health + system status endpoints."""

from __future__ import annotations

import shutil
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import __version__
from app.core.config import data_dir, load_app_settings
from app.database.session import get_db
from app.pipeline.manager import get_manager

router = APIRouter(tags=["health"])


@router.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict:
    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "version": __version__,
        "database": "ok" if db_ok else "error",
        "time": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/api/system/status")
def system_status(db: Session = Depends(get_db)) -> dict:
    settings = load_app_settings()
    manager = get_manager()

    cameras = {}
    workers_alive = 0
    if manager is not None:
        for cam_id, worker in manager.workers.items():
            cameras[cam_id] = worker.health.snapshot()
            if worker.is_alive():
                workers_alive += 1

    db_ok = True
    try:
        db.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001
        db_ok = False

    disk = shutil.disk_usage(data_dir())

    status: dict = {
        "backend": "ok",
        "database": "ok" if db_ok else "error",
        "demo_mode": settings.demo.enabled,
        "pipeline_running": manager is not None and manager.started,
        "camera_workers_alive": workers_alive,
        "cameras": cameras,
        "queue_depth": manager.msg_queue.qsize() if manager else None,
        "appearance_vectors_held": len(manager.appearance_store) if manager else 0,
        "disk": {
            "total_gb": round(disk.total / 1e9, 1),
            "free_gb": round(disk.free / 1e9, 1),
        },
    }
    try:
        import psutil  # optional

        status["cpu_percent"] = psutil.cpu_percent(interval=None)
        status["memory_percent"] = psutil.virtual_memory().percent
    except ImportError:
        pass
    return status

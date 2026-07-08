"""Pipeline manager: owns camera workers + the coordinator task.

Also persists camera health to the DB every few seconds and supports
hot-reloading camera configuration (used by the calibration API).
"""

from __future__ import annotations

import asyncio
import logging
import queue
from datetime import datetime, timezone
from typing import Optional

import numpy as np

from app.core.config import (
    AppSettings,
    CameraConfig,
    config_dir,
    load_cameras,
    load_topology,
)
from app.events.event_engine import EventEngine
from app.identity.appearance import AppearanceStore
from app.identity.cross_camera_matcher import CrossCameraMatcher
from app.identity.topology import Topology
from app.identity.visit_manager import VisitManager
from app.pipeline.coordinator import Coordinator
from app.pipeline.messages import PipelineMsg
from app.vision.camera_worker import CameraWorker

log = logging.getLogger(__name__)


class PipelineManager:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.msg_queue: "queue.Queue[PipelineMsg]" = queue.Queue(maxsize=10000)
        self.event_engine = EventEngine()
        self.cameras: list[CameraConfig] = []
        self.workers: dict[str, CameraWorker] = {}
        self.topology = Topology(load_topology())
        self.visit_manager = VisitManager(
            self.event_engine, settings.visits, is_demo=settings.demo.enabled
        )
        self.appearance_store = AppearanceStore(
            settings.matching.appearance_retention_minutes
        )
        self.matcher = CrossCameraMatcher(self.topology, settings.matching)
        self.coordinator = Coordinator(
            self.msg_queue, self.event_engine, self.visit_manager,
            self.matcher, self.appearance_store, settings,
        )
        self._coordinator_task: Optional[asyncio.Task] = None
        self._health_task: Optional[asyncio.Task] = None
        self.started = False

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        if self.settings.demo.enabled and self.settings.demo.scenario:
            from app.vision.mock_scenario import init_engine

            scenario_path = config_dir() / self.settings.demo.scenario
            init_engine(scenario_path)

        self.cameras = load_cameras()
        self._sync_camera_rows()

        problems = self.topology.validate({c.camera_id for c in self.cameras})
        for p in problems:
            log.warning("topology: %s", p)

        for cam in self.cameras:
            self._start_worker(cam)

        self._coordinator_task = asyncio.create_task(self.coordinator.run())
        self._health_task = asyncio.create_task(self._persist_health_loop())
        self.started = True
        log.info("pipeline started: %d cameras", len(self.workers))

    async def stop(self) -> None:
        self.coordinator.stop()
        for worker in self.workers.values():
            worker.stop()
        for task in (self._coordinator_task, self._health_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        for worker in self.workers.values():
            worker.join(timeout=5.0)
        self.started = False
        log.info("pipeline stopped")

    def _start_worker(self, cam: CameraConfig) -> None:
        worker = CameraWorker(cam, self.settings, self.msg_queue)
        self.workers[cam.camera_id] = worker
        worker.start()

    # ----------------------------------------------------------- camera ops

    def get_worker(self, camera_id: str) -> Optional[CameraWorker]:
        return self.workers.get(camera_id)

    def snapshot(self, camera_id: str) -> Optional[np.ndarray]:
        worker = self.workers.get(camera_id)
        return worker.last_frame() if worker else None

    def reload_cameras(self) -> dict:
        """Re-read cameras.yaml; restart changed/new workers, stop removed."""
        new_configs = {c.camera_id: c for c in load_cameras()}
        old_ids = set(self.workers)
        new_ids = set(new_configs)

        stopped, started_ids, reloaded = [], [], []

        for cam_id in old_ids - new_ids:
            self.workers[cam_id].stop()
            del self.workers[cam_id]
            stopped.append(cam_id)

        for cam_id in new_ids:
            new_cfg = new_configs[cam_id]
            existing = self.workers.get(cam_id)
            if existing is None:
                self._start_worker(new_cfg)
                started_ids.append(cam_id)
                continue
            old_cfg = existing.cam
            # spatial-only change: hot reload; source/processing change: restart
            if (old_cfg.source == new_cfg.source
                    and old_cfg.processing == new_cfg.processing
                    and old_cfg.enabled == new_cfg.enabled):
                existing.cam = new_cfg
                existing.reload_spatial(new_cfg.lines, new_cfg.zones,
                                        new_cfg.ignore_zones)
                reloaded.append(cam_id)
            else:
                existing.stop()
                self._start_worker(new_cfg)
                started_ids.append(cam_id)

        self.cameras = list(new_configs.values())
        self._sync_camera_rows()
        return {"stopped": stopped, "started": started_ids, "reloaded": reloaded}

    # -------------------------------------------------------------- storage

    def _sync_camera_rows(self) -> None:
        from app.database.models import Camera
        from app.database.session import new_session

        db = new_session()
        try:
            for cam in self.cameras:
                row = db.get(Camera, cam.camera_id)
                config_json = cam.model_dump_json(exclude={"source"})
                if row is None:
                    row = Camera(id=cam.camera_id)
                    db.add(row)
                row.name = cam.name or cam.camera_id
                row.enabled = cam.enabled
                row.source_type = cam.source.type
                row.config_json = config_json
            db.commit()
        finally:
            db.close()

    async def _persist_health_loop(self) -> None:
        from app.database.models import CameraStatus
        from app.database.session import new_session

        while True:
            await asyncio.sleep(5.0)
            try:
                db = new_session()
                try:
                    for cam_id, worker in self.workers.items():
                        h = worker.health
                        row = db.get(CameraStatus, cam_id)
                        if row is None:
                            row = CameraStatus(camera_id=cam_id)
                            db.add(row)
                        row.state = h.state
                        row.last_frame_at = h.last_frame_at
                        row.frames_received = h.frames_received
                        row.frames_processed = h.frames_processed
                        row.processing_fps = h.processing_fps
                        row.processing_latency_ms = h.processing_latency_ms
                        row.decode_errors = h.decode_errors
                        row.reconnect_attempts = h.reconnect_attempts
                        row.last_error = h.last_error
                        row.updated_at = datetime.now(timezone.utc)
                    db.commit()
                finally:
                    db.close()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("health persistence failed")


# process-wide singleton, set by main.py lifespan
_manager: Optional[PipelineManager] = None


def set_manager(m: Optional[PipelineManager]) -> None:
    global _manager
    _manager = m


def get_manager() -> Optional[PipelineManager]:
    return _manager

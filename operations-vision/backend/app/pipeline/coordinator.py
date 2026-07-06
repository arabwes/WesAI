"""Coordinator: consumes worker messages, owns visits/events/database.

Single consumer = single writer, so no cross-thread DB contention.
Runs as an asyncio task inside the FastAPI process.
"""

from __future__ import annotations

import asyncio
import logging
import queue
import time
from datetime import datetime, timezone

from app.core.config import AppSettings
from app.events.event_engine import BusinessEvent, EventEngine
from app.events.event_types import EventType
from app.identity.appearance import AppearanceStore
from app.identity.cross_camera_matcher import (
    CrossCameraMatcher,
    NewTrackCandidate,
    PendingEndedTrack,
)
from app.identity.visit_manager import VisitManager
from app.pipeline.messages import (
    CameraStateMsg,
    LineCrossingMsg,
    PipelineMsg,
    TrackEndedMsg,
    TrackStartedMsg,
    ZoneTransitionMsg,
)

log = logging.getLogger(__name__)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Coordinator:
    def __init__(self, msg_queue: "queue.Queue[PipelineMsg]",
                 event_engine: EventEngine,
                 visit_manager: VisitManager,
                 matcher: CrossCameraMatcher,
                 appearance_store: AppearanceStore,
                 settings: AppSettings) -> None:
        self.queue = msg_queue
        self.events = event_engine
        self.visits = visit_manager
        self.matcher = matcher
        self.appearance = appearance_store
        self.settings = settings
        self.is_demo = settings.demo.enabled
        self._running = False
        self._last_tick = 0.0

    # ------------------------------------------------------------ lifecycle

    async def run(self) -> None:
        from app.database.session import new_session

        self._running = True
        log.info("coordinator started (demo=%s)", self.is_demo)
        while self._running:
            batch: list[PipelineMsg] = []
            try:
                while len(batch) < 200:
                    batch.append(self.queue.get_nowait())
            except queue.Empty:
                pass

            now_mono = time.monotonic()
            do_tick = now_mono - self._last_tick >= 1.0

            if batch or do_tick:
                db = new_session()
                try:
                    for msg in batch:
                        try:
                            self._handle(db, msg)
                        except Exception:  # noqa: BLE001
                            log.exception("failed handling %s", type(msg).__name__)
                    if do_tick:
                        self._tick(db)
                        self._last_tick = now_mono
                    db.commit()
                except Exception:  # noqa: BLE001
                    log.exception("coordinator batch failed; rolling back")
                    db.rollback()
                finally:
                    db.close()

            if not batch:
                await asyncio.sleep(0.1)

    def stop(self) -> None:
        self._running = False

    def drain_once(self) -> None:
        """Synchronous single pass - used by tests and the validator."""
        from app.database.session import new_session

        db = new_session()
        try:
            try:
                while True:
                    self._handle(db, self.queue.get_nowait())
            except queue.Empty:
                pass
            self._tick(db)
            db.commit()
        finally:
            db.close()

    # ------------------------------------------------------------- handling

    def _handle(self, db, msg: PipelineMsg) -> None:
        if isinstance(msg, TrackStartedMsg):
            self._on_track_started(msg)
        elif isinstance(msg, TrackEndedMsg):
            self._on_track_ended(db, msg)
        elif isinstance(msg, LineCrossingMsg):
            self._on_line_crossing(db, msg)
        elif isinstance(msg, ZoneTransitionMsg):
            self._on_zone_transition(db, msg)
        elif isinstance(msg, CameraStateMsg):
            self._on_camera_state(db, msg)

    def _on_track_started(self, msg: TrackStartedMsg) -> None:
        key = f"{msg.camera_id}:{msg.track_id}"
        if msg.appearance is not None:
            self.appearance.put(key, msg.appearance)
        self.matcher.queue_new_track(NewTrackCandidate(
            camera_id=msg.camera_id,
            track_id=msg.track_id,
            started_at=msg.ts,
            velocity=msg.velocity,
            appearance=msg.appearance,
        ))

    def _on_track_ended(self, db, msg: TrackEndedMsg) -> None:
        key = f"{msg.camera_id}:{msg.track_id}"
        self.matcher.dequeue_new_track(key)  # died before it ever matched
        visit_id = self.visits.track_ended(db, key, msg.last_seen)
        if visit_id is not None:
            appearance = msg.appearance
            if appearance is None:
                appearance = self.appearance.get(key)
            # visit still active: candidate for reappearing on a neighbor cam
            self.matcher.add_ended_track(PendingEndedTrack(
                camera_id=msg.camera_id,
                track_id=msg.track_id,
                visit_id=visit_id,
                ended_at=msg.last_seen,
                velocity=msg.velocity,
                appearance=appearance,
                expires_monotonic=time.monotonic() + self.settings.matching.pending_track_ttl_seconds,
            ))
        self.appearance.drop(key)  # matcher holds its own reference if needed

    def _on_line_crossing(self, db, msg: LineCrossingMsg) -> None:
        key = f"{msg.camera_id}:{msg.track_id}"
        visit_id = self.visits.visit_for_track(key)

        if msg.direction == "in" and msg.camera_is_entrance:
            if visit_id is None:
                visit = self.visits.create_visit(db, msg.camera_id, msg.track_id, msg.ts)
                visit_id = visit.visit_id
                # it has a visit now; no longer a handoff candidate
                self.matcher.dequeue_new_track(key)
            self.events.emit(db, BusinessEvent(
                event_type=EventType.PERSON_ENTERED,
                timestamp=msg.ts,
                camera_id=msg.camera_id,
                visit_id=visit_id,
                track_id=str(msg.track_id),
                metadata={"line_id": msg.line_id,
                          "location": [round(msg.location[0], 1), round(msg.location[1], 1)],
                          "direction": msg.direction},
                is_demo=self.is_demo,
            ))
        elif msg.direction == "out" and msg.camera_is_exit:
            self.events.emit(db, BusinessEvent(
                event_type=EventType.PERSON_EXITED,
                timestamp=msg.ts,
                camera_id=msg.camera_id,
                visit_id=visit_id,
                track_id=str(msg.track_id),
                metadata={"line_id": msg.line_id,
                          "location": [round(msg.location[0], 1), round(msg.location[1], 1)],
                          "direction": msg.direction},
                is_demo=self.is_demo,
            ))
            if visit_id is not None:
                self.visits.complete_visit(db, visit_id, msg.ts,
                                           camera_id=msg.camera_id)
                self.matcher.remove_visit(visit_id)

    def _on_zone_transition(self, db, msg: ZoneTransitionMsg) -> None:
        key = f"{msg.camera_id}:{msg.track_id}"
        visit_id = self.visits.update_zone(
            db, key, msg.zone_id, msg.zone_type, msg.kind == "entered", msg.ts
        )
        self.events.emit(db, BusinessEvent(
            event_type=(EventType.ZONE_ENTERED if msg.kind == "entered"
                        else EventType.ZONE_EXITED),
            timestamp=msg.ts,
            camera_id=msg.camera_id,
            visit_id=visit_id,
            track_id=str(msg.track_id),
            metadata={"zone_id": msg.zone_id, "zone_type": msg.zone_type},
            is_demo=self.is_demo,
        ))

    def _on_camera_state(self, db, msg: CameraStateMsg) -> None:
        if msg.state == "online":
            event_type = EventType.CAMERA_ONLINE
        elif msg.state in ("offline", "reconnecting"):
            event_type = EventType.CAMERA_OFFLINE
        else:
            return
        self.events.emit(db, BusinessEvent(
            event_type=event_type,
            timestamp=msg.ts,
            camera_id=msg.camera_id,
            metadata={"state": msg.state, "error": msg.error},
            is_demo=self.is_demo,
        ))

    # ----------------------------------------------------------------- tick

    def _tick(self, db) -> None:
        for match in self.matcher.process():
            self.visits.record_handoff(
                db,
                visit_id=match.ended_track.visit_id,
                from_camera=match.ended_track.camera_id,
                to_camera=match.new_track.camera_id,
                to_track_id=match.new_track.track_id,
                ts=match.new_track.started_at,
                score=match.score.as_dict(),
                combined=match.score.combined,
            )
        self.visits.expire_visits(db, utcnow())
        self.appearance.purge_expired()

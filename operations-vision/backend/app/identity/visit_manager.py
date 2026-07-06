"""Anonymous visit lifecycle.

A visit is an opaque id (V-YYYYMMDD-NNNNN) spanning entry to exit.
It is never linked to any identity - only to camera tracks while they
are alive, and to permanent business events.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import VisitSettings
from app.database.models import Visit, VisitObservation
from app.events.event_engine import BusinessEvent, EventEngine
from app.events.event_types import EventType

log = logging.getLogger(__name__)


class VisitManager:
    def __init__(self, event_engine: EventEngine, settings: VisitSettings,
                 is_demo: bool = False) -> None:
        self.events = event_engine
        self.settings = settings
        self.is_demo = is_demo
        # track_key ("camera:track_id") -> visit_id, in-memory only
        self.assoc: dict[str, str] = {}
        # visit_id -> last activity timestamp
        self.last_activity: dict[str, datetime] = {}
        # track_key -> visit_observations row id
        self._obs_ids: dict[str, int] = {}
        self._seq_day: Optional[str] = None
        self._seq = 0

    # ------------------------------------------------------------ helpers

    def visit_for_track(self, track_key: str) -> Optional[str]:
        return self.assoc.get(track_key)

    def _next_visit_id(self, db: Session, ts: datetime) -> str:
        day = ts.strftime("%Y%m%d")
        if self._seq_day != day:
            prefix = f"V-{day}-"
            max_id = db.execute(
                select(func.max(Visit.visit_id)).where(Visit.visit_id.like(prefix + "%"))
            ).scalar()
            self._seq = int(max_id.rsplit("-", 1)[1]) if max_id else 0
            self._seq_day = day
        self._seq += 1
        return f"V-{day}-{self._seq:05d}"

    def _touch(self, visit_id: str, ts: datetime) -> None:
        self.last_activity[visit_id] = ts

    # ---------------------------------------------------------- lifecycle

    def create_visit(self, db: Session, camera_id: str, track_id: int,
                     ts: datetime) -> Visit:
        visit_id = self._next_visit_id(db, ts)
        visit = Visit(
            visit_id=visit_id,
            entry_time=ts,
            status="active",
            entry_camera=camera_id,
            current_camera=camera_id,
            match_confidence=1.0,
            handoff_count=0,
            cameras_observed=1,
            is_demo=self.is_demo,
        )
        db.add(visit)
        key = f"{camera_id}:{track_id}"
        self.assoc[key] = visit_id
        self._touch(visit_id, ts)
        self._add_observation(db, visit_id, camera_id, track_id, ts)
        self.events.emit(db, BusinessEvent(
            event_type=EventType.VISIT_CREATED,
            timestamp=ts,
            camera_id=camera_id,
            visit_id=visit_id,
            track_id=str(track_id),
            is_demo=self.is_demo,
        ))
        log.info("visit created %s (camera %s, track %d)", visit_id, camera_id, track_id)
        return visit

    def _add_observation(self, db: Session, visit_id: str, camera_id: str,
                         track_id: int, ts: datetime,
                         confidence: float = 1.0) -> None:
        obs = VisitObservation(
            visit_id=visit_id,
            camera_id=camera_id,
            camera_track_id=str(track_id),
            first_seen=ts,
            last_seen=ts,
            confidence=confidence,
        )
        db.add(obs)
        db.flush()
        self._obs_ids[f"{camera_id}:{track_id}"] = obs.id

    def record_handoff(self, db: Session, visit_id: str, from_camera: str,
                       to_camera: str, to_track_id: int, ts: datetime,
                       score: dict, combined: float) -> None:
        visit = db.get(Visit, visit_id)
        if visit is None or visit.status not in ("active", "uncertain"):
            return
        key = f"{to_camera}:{to_track_id}"
        self.assoc[key] = visit_id
        visit.current_camera = to_camera
        visit.handoff_count += 1
        visit.cameras_observed += 1
        visit.match_confidence = min(visit.match_confidence, combined)
        if visit.status == "uncertain":
            visit.status = "active"
        self._touch(visit_id, ts)
        self._add_observation(db, visit_id, to_camera, to_track_id, ts,
                              confidence=combined)
        self.events.emit(db, BusinessEvent(
            event_type=EventType.CAMERA_HANDOFF,
            timestamp=ts,
            camera_id=to_camera,
            visit_id=visit_id,
            track_id=str(to_track_id),
            confidence=combined,
            metadata={"from_camera": from_camera, **score},
            is_demo=self.is_demo,
        ))

    def update_zone(self, db: Session, track_key: str, zone_id: str,
                    zone_type: str, entered: bool, ts: datetime) -> Optional[str]:
        visit_id = self.assoc.get(track_key)
        if visit_id is None:
            return None
        visit = db.get(Visit, visit_id)
        if visit is not None:
            visit.current_zone = zone_id if entered else None
        self._touch(visit_id, ts)
        obs_id = self._obs_ids.get(track_key)
        if obs_id is not None:
            obs = db.get(VisitObservation, obs_id)
            if obs is not None:
                obs.last_seen = ts
                if entered:
                    obs.zone = zone_id
        return visit_id

    def track_ended(self, db: Session, track_key: str, ts: datetime) -> Optional[str]:
        """Detach a dead camera track; returns the visit it belonged to."""
        visit_id = self.assoc.pop(track_key, None)
        obs_id = self._obs_ids.pop(track_key, None)
        if obs_id is not None:
            obs = db.get(VisitObservation, obs_id)
            if obs is not None:
                obs.last_seen = ts
        if visit_id:
            self._touch(visit_id, ts)
        return visit_id

    def complete_visit(self, db: Session, visit_id: str, ts: datetime,
                       camera_id: str | None = None,
                       reason: str = "exit_line") -> Optional[Visit]:
        visit = db.get(Visit, visit_id)
        if visit is None or visit.status == "completed":
            return visit
        visit.exit_time = ts
        entry = visit.entry_time
        if entry.tzinfo is None and ts.tzinfo is not None:
            from datetime import timezone
            entry = entry.replace(tzinfo=timezone.utc)
        visit.dwell_seconds = max(0.0, (ts - entry).total_seconds())
        visit.status = "completed"
        visit.completion_reason = reason
        # drop all track associations for this visit
        for key in [k for k, v in self.assoc.items() if v == visit_id]:
            del self.assoc[key]
        self.last_activity.pop(visit_id, None)
        self.events.emit(db, BusinessEvent(
            event_type=EventType.VISIT_COMPLETED,
            timestamp=ts,
            camera_id=camera_id,
            visit_id=visit_id,
            confidence=visit.match_confidence,
            metadata={"dwell_seconds": visit.dwell_seconds, "reason": reason},
            is_demo=self.is_demo,
        ))
        log.info("visit completed %s (dwell %.0fs, confidence %.2f)",
                 visit_id, visit.dwell_seconds, visit.match_confidence)
        return visit

    # ------------------------------------------------------------- expiry

    def expire_visits(self, db: Session, now: datetime) -> None:
        """active -> uncertain -> lost as activity goes quiet."""
        uncertain_after = timedelta(minutes=self.settings.uncertain_after_minutes)
        lost_after = timedelta(minutes=self.settings.lost_after_minutes)

        for visit_id, last in list(self.last_activity.items()):
            idle = now - last
            visit = db.get(Visit, visit_id)
            if visit is None or visit.status in ("completed", "lost"):
                self.last_activity.pop(visit_id, None)
                continue
            has_live_track = visit_id in self.assoc.values()
            if idle >= lost_after:
                visit.status = "lost"
                visit.completion_reason = "tracking_lost"
                visit.exit_time = None
                for key in [k for k, v in self.assoc.items() if v == visit_id]:
                    del self.assoc[key]
                self.last_activity.pop(visit_id, None)
                self.events.emit(db, BusinessEvent(
                    event_type=EventType.VISIT_LOST,
                    timestamp=now,
                    visit_id=visit_id,
                    is_demo=self.is_demo,
                ))
            elif idle >= uncertain_after and not has_live_track and visit.status == "active":
                visit.status = "uncertain"
                self.events.emit(db, BusinessEvent(
                    event_type=EventType.VISIT_UNCERTAIN,
                    timestamp=now,
                    visit_id=visit_id,
                    is_demo=self.is_demo,
                ))

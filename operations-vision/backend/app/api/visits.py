"""Visit query endpoints. Visits are anonymous by construction."""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analytics.common import parse_range
from app.database.models import Visit, VisitObservation
from app.database.session import get_db

router = APIRouter(prefix="/api/visits", tags=["visits"])


def _visit_payload(v: Visit) -> dict:
    return {
        "visit_id": v.visit_id,
        "entry_time": v.entry_time.isoformat() if v.entry_time else None,
        "exit_time": v.exit_time.isoformat() if v.exit_time else None,
        "dwell_seconds": v.dwell_seconds,
        "status": v.status,
        "entry_camera": v.entry_camera,
        "current_camera": v.current_camera,
        "current_zone": v.current_zone,
        "match_confidence": v.match_confidence,
        "handoff_count": v.handoff_count,
        "cameras_observed": v.cameras_observed,
        "completion_reason": v.completion_reason,
        "is_demo": v.is_demo,
    }


@router.get("")
def list_visits(
    start: Optional[date] = None,
    end: Optional[date] = None,
    status: Optional[str] = None,
    limit: int = Query(200, le=2000),
    offset: int = 0,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    stmt = (
        select(Visit)
        .where(Visit.entry_time >= start_utc)
        .where(Visit.entry_time < end_utc)
    )
    if status:
        stmt = stmt.where(Visit.status == status)
    stmt = stmt.order_by(Visit.entry_time.desc()).limit(limit).offset(offset)
    visits = list(db.execute(stmt).scalars())
    return {"visits": [_visit_payload(v) for v in visits], "count": len(visits)}


@router.get("/active")
def active_visits(db: Session = Depends(get_db)) -> dict:
    visits = list(db.execute(
        select(Visit)
        .where(Visit.status.in_(["active", "uncertain"]))
        .order_by(Visit.entry_time.desc())
        .limit(500)
    ).scalars())
    return {"visits": [_visit_payload(v) for v in visits], "count": len(visits)}


@router.get("/{visit_id}")
def get_visit(visit_id: str, db: Session = Depends(get_db)) -> dict:
    visit = db.get(Visit, visit_id)
    if visit is None:
        raise HTTPException(404, f"visit {visit_id} not found")
    observations = list(db.execute(
        select(VisitObservation)
        .where(VisitObservation.visit_id == visit_id)
        .order_by(VisitObservation.first_seen)
    ).scalars())
    return {
        **_visit_payload(visit),
        "observations": [
            {
                "camera_id": o.camera_id,
                "camera_track_id": o.camera_track_id,
                "first_seen": o.first_seen.isoformat(),
                "last_seen": o.last_seen.isoformat(),
                "zone": o.zone,
                "confidence": o.confidence,
            }
            for o in observations
        ],
    }

"""Event query endpoints."""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analytics.common import parse_range
from app.database.models import Event
from app.database.session import get_db

router = APIRouter(prefix="/api/events", tags=["events"])


def _event_payload(e: Event) -> dict:
    return {
        "event_id": e.event_id,
        "event_type": e.event_type,
        "timestamp": e.timestamp.isoformat(),
        "camera_id": e.camera_id,
        "visit_id": e.visit_id,
        "track_id": e.track_id,
        "confidence": e.confidence,
        "metadata": e.meta,
        "is_demo": e.is_demo,
    }


@router.get("")
def list_events(
    start: Optional[date] = None,
    end: Optional[date] = None,
    event_type: Optional[str] = None,
    camera_id: Optional[str] = None,
    visit_id: Optional[str] = None,
    limit: int = Query(200, le=2000),
    offset: int = 0,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    stmt = (
        select(Event)
        .where(Event.timestamp >= start_utc)
        .where(Event.timestamp < end_utc)
    )
    if event_type:
        stmt = stmt.where(Event.event_type == event_type)
    if camera_id:
        stmt = stmt.where(Event.camera_id == camera_id)
    if visit_id:
        stmt = stmt.where(Event.visit_id == visit_id)
    stmt = stmt.order_by(Event.timestamp.desc()).limit(limit).offset(offset)
    events = list(db.execute(stmt).scalars())
    return {"events": [_event_payload(e) for e in events], "count": len(events)}


@router.get("/recent")
def recent_events(
    limit: int = Query(50, le=500),
    db: Session = Depends(get_db),
) -> dict:
    events = list(db.execute(
        select(Event).order_by(Event.event_id.desc()).limit(limit)
    ).scalars())
    return {"events": [_event_payload(e) for e in events]}

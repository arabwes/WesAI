"""Tracking-quality analytics: how trustworthy are the numbers?"""

from __future__ import annotations

import statistics
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analytics.common import fetch_events
from app.database.models import Visit
from app.events.event_types import EventType


def quality_summary(db: Session, start_utc: datetime, end_utc: datetime) -> dict:
    visits = list(db.execute(
        select(Visit)
        .where(Visit.entry_time >= start_utc)
        .where(Visit.entry_time < end_utc)
    ).scalars())

    by_status: dict[str, int] = {}
    for v in visits:
        by_status[v.status] = by_status.get(v.status, 0) + 1

    completed = [v for v in visits if v.status == "completed"]
    high = sum(1 for v in completed if v.match_confidence >= 0.90)
    moderate = sum(1 for v in completed if 0.75 <= v.match_confidence < 0.90)

    handoffs = fetch_events(db, [EventType.CAMERA_HANDOFF], start_utc, end_utc)
    handoff_confidences = [e.confidence for e in handoffs]

    # live matcher counters (rejections aren't persisted as events)
    from app.pipeline.manager import get_manager

    manager = get_manager()
    accepted = rejected = None
    if manager is not None:
        accepted = manager.matcher.accepted_count
        rejected = manager.matcher.rejected_count

    total_visits = len(visits)
    return {
        "visits_total": total_visits,
        "visits_by_status": by_status,
        "high_confidence_visits": high,
        "moderate_confidence_visits": moderate,
        "lost_visits": by_status.get("lost", 0),
        "uncertain_visits": by_status.get("uncertain", 0),
        "completion_rate": round(len(completed) / total_visits, 3) if total_visits else None,
        "handoffs": len(handoffs),
        "avg_handoff_confidence": (
            round(statistics.fmean(handoff_confidences), 3) if handoff_confidences else None
        ),
        "session_handoffs_accepted": accepted,
        "session_handoffs_rejected": rejected,
        "session_handoff_acceptance_rate": (
            round(accepted / (accepted + rejected), 3)
            if accepted is not None and (accepted + rejected) > 0 else None
        ),
    }

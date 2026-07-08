"""Analytics endpoints."""

from __future__ import annotations

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.analytics.common import parse_range
from app.analytics.dwell import dwell_summary
from app.analytics.occupancy import occupancy_now, occupancy_timeline
from app.analytics.quality import quality_summary
from app.analytics.traffic import traffic_summary
from app.core.config import load_app_settings
from app.database.session import get_db

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/overview")
def overview(
    start: Optional[date] = None,
    end: Optional[date] = None,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    settings = load_app_settings()
    traffic = traffic_summary(db, start_utc, end_utc)
    occupancy = occupancy_now(db)
    timeline = occupancy_timeline(db, start_utc, end_utc)
    dwell = dwell_summary(db, start_utc, end_utc)
    quality = quality_summary(db, start_utc, end_utc)

    from app.pipeline.manager import get_manager

    manager = get_manager()
    cameras_online = cameras_total = 0
    if manager is not None:
        cameras_total = len(manager.workers)
        cameras_online = sum(
            1 for w in manager.workers.values() if w.health.state == "online"
        )

    return {
        "demo_mode": settings.demo.enabled,
        "customers_today": traffic["entries"],
        "current_occupancy": occupancy["current_occupancy"],
        "peak_occupancy": timeline["peak_occupancy"],
        "peak_at": timeline["peak_at"],
        "avg_dwell_seconds": dwell["all_completed"]["avg_seconds"],
        "median_dwell_seconds": dwell["all_completed"]["median_seconds"],
        "completion_rate": quality["completion_rate"],
        "cameras_online": cameras_online,
        "cameras_total": cameras_total,
        "visitors_by_hour": traffic["by_hour"],
        "occupancy_timeline": timeline["timeline"],
        "dwell_buckets": dwell["buckets"],
    }


@router.get("/traffic")
def traffic(
    start: Optional[date] = None,
    end: Optional[date] = None,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    return traffic_summary(db, start_utc, end_utc)


@router.get("/occupancy")
def occupancy(
    start: Optional[date] = None,
    end: Optional[date] = None,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    return {**occupancy_now(db), **occupancy_timeline(db, start_utc, end_utc)}


@router.get("/dwell")
def dwell(
    start: Optional[date] = None,
    end: Optional[date] = None,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    return dwell_summary(db, start_utc, end_utc)


@router.get("/tracking-quality")
def tracking_quality(
    start: Optional[date] = None,
    end: Optional[date] = None,
    db: Session = Depends(get_db),
) -> dict:
    start_utc, end_utc = parse_range(start, end)
    return quality_summary(db, start_utc, end_utc)

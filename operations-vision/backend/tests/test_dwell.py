"""Dwell buckets + statistics + summary segmentation."""

from datetime import datetime, timedelta, timezone

from app.analytics.dwell import bucket_for, dwell_summary
from app.database.models import Visit


def test_bucket_boundaries():
    assert bucket_for(0) == "0-5 min"
    assert bucket_for(4 * 60 + 59) == "0-5 min"
    assert bucket_for(5 * 60) == "5-15 min"
    assert bucket_for(29 * 60) == "15-30 min"
    assert bucket_for(45 * 60) == "45-60 min"
    assert bucket_for(89 * 60) == "60-90 min"
    assert bucket_for(1000 * 60) == "90+ min"


def _visit(i, entry, dwell=None, status="completed", confidence=1.0):
    return Visit(
        visit_id=f"V-TEST-{i:05d}",
        entry_time=entry,
        exit_time=entry + timedelta(seconds=dwell) if dwell else None,
        dwell_seconds=dwell,
        status=status,
        match_confidence=confidence,
    )


def test_dwell_summary_segments_confidence(db):
    now = datetime.now(timezone.utc)
    db.add(_visit(1, now, 600, confidence=0.95))
    db.add(_visit(2, now, 1200, confidence=0.95))
    db.add(_visit(3, now, 3000, confidence=0.80))   # completed, moderate conf
    db.add(_visit(4, now, None, status="lost"))
    db.add(_visit(5, now, None, status="uncertain"))
    db.commit()

    s = dwell_summary(db, now - timedelta(hours=1), now + timedelta(hours=1))
    assert s["all_completed"]["count"] == 3
    assert s["high_confidence"]["count"] == 2
    assert s["high_confidence"]["avg_seconds"] == 900.0
    assert s["all_completed"]["median_seconds"] == 1200.0
    assert s["lost_count"] == 1
    assert s["uncertain_count"] == 1
    buckets = {b["bucket"]: b["count"] for b in s["buckets"]}
    assert buckets["5-15 min"] == 1
    assert buckets["15-30 min"] == 1
    assert buckets["45-60 min"] == 1


def test_dwell_summary_empty(db):
    now = datetime.now(timezone.utc)
    s = dwell_summary(db, now - timedelta(hours=1), now)
    assert s["all_completed"]["count"] == 0
    assert s["all_completed"]["avg_seconds"] is None

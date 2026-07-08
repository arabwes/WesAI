"""Dwell time analytics over completed visits.

High-confidence and uncertain visits are always segmented so bad
matches can't silently corrupt the primary numbers (spec section 17).
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.analytics.common import as_local
from app.database.models import Visit

HIGH_CONFIDENCE = 0.90

BUCKETS = [
    ("0-5 min", 0, 5),
    ("5-15 min", 5, 15),
    ("15-30 min", 15, 30),
    ("30-45 min", 30, 45),
    ("45-60 min", 45, 60),
    ("60-90 min", 60, 90),
    ("90+ min", 90, 10**9),
]


def bucket_for(dwell_seconds: float) -> str:
    minutes = dwell_seconds / 60.0
    for label, lo, hi in BUCKETS:
        if lo <= minutes < hi:
            return label
    return BUCKETS[-1][0]


def _stats(dwells: list[float]) -> dict:
    if not dwells:
        return {"count": 0, "avg_seconds": None, "median_seconds": None,
                "p25_seconds": None, "p75_seconds": None, "p90_seconds": None}
    s = sorted(dwells)

    def pct(p: float) -> float:
        k = (len(s) - 1) * p
        f = int(k)
        c = min(f + 1, len(s) - 1)
        return s[f] + (s[c] - s[f]) * (k - f)

    return {
        "count": len(s),
        "avg_seconds": round(statistics.fmean(s), 1),
        "median_seconds": round(statistics.median(s), 1),
        "p25_seconds": round(pct(0.25), 1),
        "p75_seconds": round(pct(0.75), 1),
        "p90_seconds": round(pct(0.90), 1),
    }


def dwell_summary(db: Session, start_utc: datetime, end_utc: datetime) -> dict:
    visits = list(db.execute(
        select(Visit)
        .where(Visit.entry_time >= start_utc)
        .where(Visit.entry_time < end_utc)
    ).scalars())

    completed = [v for v in visits if v.status == "completed" and v.dwell_seconds is not None]
    high_conf = [v for v in completed if v.match_confidence >= HIGH_CONFIDENCE]
    lost = [v for v in visits if v.status == "lost"]
    uncertain = [v for v in visits if v.status == "uncertain"]

    buckets: Counter[str] = Counter()
    by_hour: dict[int, list[float]] = defaultdict(list)
    by_weekday: dict[str, list[float]] = defaultdict(list)
    for v in completed:
        buckets[bucket_for(v.dwell_seconds)] += 1
        local_entry = as_local(v.entry_time)
        by_hour[local_entry.hour].append(v.dwell_seconds)
        by_weekday[local_entry.strftime("%A")].append(v.dwell_seconds)

    weekday_order = ["Monday", "Tuesday", "Wednesday", "Thursday",
                     "Friday", "Saturday", "Sunday"]
    return {
        "high_confidence": _stats([v.dwell_seconds for v in high_conf]),
        "all_completed": _stats([v.dwell_seconds for v in completed]),
        "lost_count": len(lost),
        "uncertain_count": len(uncertain),
        "buckets": [
            {"bucket": label, "count": buckets.get(label, 0)}
            for label, _, _ in BUCKETS
        ],
        "by_hour_of_entry": [
            {"hour": h, **_stats(by_hour[h])} for h in sorted(by_hour)
        ],
        "by_weekday": [
            {"weekday": w, **_stats(by_weekday[w])}
            for w in weekday_order if w in by_weekday
        ],
    }

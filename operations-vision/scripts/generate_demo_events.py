"""Seed the database with realistic historical DEMO visits and events.

All rows are flagged is_demo=true so they can never be confused with
real data and can be purged with purge_temporary_data.py --demo.

Usage (from operations-vision/):
    backend\\.venv\\Scripts\\python scripts\\generate_demo_events.py --days 14
"""

from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

# hour-of-day arrival weights for a coffee shop (open 7:00-19:00)
HOUR_WEIGHTS = {
    7: 8, 8: 12, 9: 10, 10: 6, 11: 5, 12: 8,
    13: 7, 14: 5, 15: 4, 16: 4, 17: 3, 18: 2,
}

CAMERAS = ["entrance_front", "service_area", "seating_main"]


def make_day(db, day_start_local, n_visits, rng, seq_offset):
    from app.database.models import Event, Visit

    day_key = day_start_local.strftime("%Y%m%d")
    hours = list(HOUR_WEIGHTS)
    weights = list(HOUR_WEIGHTS.values())

    for i in range(n_visits):
        hour = rng.choices(hours, weights=weights, k=1)[0]
        entry = day_start_local.replace(hour=hour) + timedelta(
            minutes=rng.uniform(0, 59), seconds=rng.uniform(0, 59)
        )
        entry_utc = entry.astimezone(timezone.utc)

        r = rng.random()
        if r < 0.45:      # grab and go
            dwell = rng.uniform(3 * 60, 9 * 60)
        elif r < 0.85:    # sit for a while
            dwell = rng.uniform(15 * 60, 55 * 60)
        else:             # camper
            dwell = rng.uniform(60 * 60, 110 * 60)

        status_roll = rng.random()
        visit_id = f"V-{day_key}-{seq_offset + i + 1:05d}"
        handoffs = rng.choice([1, 2, 2, 3])
        confidence = round(rng.uniform(0.86, 0.99), 3)

        if status_roll < 0.88:
            status, exit_utc, dwell_s = "completed", entry_utc + timedelta(seconds=dwell), dwell
        elif status_roll < 0.96:
            status, exit_utc, dwell_s = "lost", None, None
        else:
            status, exit_utc, dwell_s = "uncertain", None, None

        db.add(Visit(
            visit_id=visit_id, entry_time=entry_utc, exit_time=exit_utc,
            dwell_seconds=dwell_s, status=status, entry_camera="entrance_front",
            current_camera=None if status == "completed" else rng.choice(CAMERAS),
            match_confidence=confidence, handoff_count=handoffs,
            cameras_observed=handoffs + 1,
            completion_reason="exit_line" if status == "completed" else (
                "tracking_lost" if status == "lost" else None),
            is_demo=True,
        ))
        db.add(Event(event_type="PERSON_ENTERED", timestamp=entry_utc,
                     camera_id="entrance_front", visit_id=visit_id,
                     confidence=1.0, meta={"line_id": "front_door"}, is_demo=True))
        if exit_utc is not None:
            db.add(Event(event_type="PERSON_EXITED", timestamp=exit_utc,
                         camera_id="entrance_front", visit_id=visit_id,
                         confidence=1.0, meta={"line_id": "front_door"}, is_demo=True))
        for h in range(handoffs):
            db.add(Event(
                event_type="CAMERA_HANDOFF",
                timestamp=entry_utc + timedelta(seconds=(h + 1) * 30),
                camera_id=CAMERAS[min(h + 1, len(CAMERAS) - 1)],
                visit_id=visit_id, confidence=confidence,
                meta={"temporal_score": round(rng.uniform(0.8, 1.0), 2),
                      "topology_score": 1.0,
                      "appearance_score": round(rng.uniform(0.8, 0.97), 2)},
                is_demo=True,
            ))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--visits-per-day", type=int, default=110)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    from app.database.session import init_db, new_session

    init_db()
    rng = random.Random(args.seed)
    local_tz = datetime.now().astimezone().tzinfo
    today = datetime.now(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)

    db = new_session()
    total = 0
    try:
        for d in range(args.days, 0, -1):
            day = today - timedelta(days=d)
            n = max(20, int(rng.gauss(args.visits_per_day, 18)))
            # weekends busier
            if day.weekday() >= 5:
                n = int(n * 1.35)
            make_day(db, day, n, rng, seq_offset=90000)
            total += n
        db.commit()
    finally:
        db.close()

    print(f"Seeded {total} demo visits across {args.days} days (all flagged is_demo=true).")
    return 0


if __name__ == "__main__":
    sys.exit(main())

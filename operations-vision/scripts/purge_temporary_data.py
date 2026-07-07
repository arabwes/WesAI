"""Data hygiene: purge demo rows and/or old events.

Appearance features never touch the database (in-memory TTL only), so
this script is about long-term DB hygiene:

    python scripts/purge_temporary_data.py --demo            # remove all demo rows
    python scripts/purge_temporary_data.py --older-than 90   # trim old events/visits
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="delete all demo-flagged rows")
    parser.add_argument("--older-than", type=int, metavar="DAYS",
                        help="delete events/visits older than DAYS")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.demo and args.older_than is None:
        parser.error("nothing to do: pass --demo and/or --older-than DAYS")

    from sqlalchemy import delete, func, select

    from app.database.models import Event, Visit, VisitObservation
    from app.database.session import init_db, new_session

    init_db()
    db = new_session()
    try:
        conditions = []
        if args.demo:
            conditions.append(("demo rows", Event.is_demo.is_(True), Visit.is_demo.is_(True)))
        if args.older_than is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(days=args.older_than)
            conditions.append((f"rows older than {args.older_than}d",
                               Event.timestamp < cutoff, Visit.entry_time < cutoff))

        for label, ev_cond, visit_cond in conditions:
            n_events = db.execute(select(func.count()).select_from(Event).where(ev_cond)).scalar()
            visit_ids = [v for v in db.execute(select(Visit.visit_id).where(visit_cond)).scalars()]
            print(f"{label}: {n_events} events, {len(visit_ids)} visits"
                  + (" (dry run)" if args.dry_run else ""))
            if args.dry_run:
                continue
            db.execute(delete(Event).where(ev_cond))
            if visit_ids:
                db.execute(delete(VisitObservation).where(
                    VisitObservation.visit_id.in_(visit_ids)))
                db.execute(delete(Visit).where(Visit.visit_id.in_(visit_ids)))
        if not args.dry_run:
            db.commit()
            print("Purge complete.")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

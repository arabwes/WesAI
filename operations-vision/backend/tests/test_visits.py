"""Visit lifecycle: create -> handoff -> complete; uncertain/lost expiry."""

from datetime import datetime, timedelta, timezone

from app.core.config import VisitSettings
from app.database.models import Event, Visit, VisitObservation
from app.events.event_engine import EventEngine
from app.identity.visit_manager import VisitManager

T0 = datetime(2026, 7, 6, 14, 0, 0, tzinfo=timezone.utc)


def make_vm():
    return VisitManager(EventEngine(), VisitSettings(uncertain_after_minutes=10,
                                                     lost_after_minutes=60))


def test_visit_create_and_complete(db):
    vm = make_vm()
    visit = vm.create_visit(db, "entrance", 42, T0)
    db.commit()
    assert visit.visit_id.startswith("V-20260706-")
    assert visit.status == "active"
    assert vm.visit_for_track("entrance:42") == visit.visit_id

    exit_ts = T0 + timedelta(minutes=53, seconds=19)
    vm.complete_visit(db, visit.visit_id, exit_ts, camera_id="entrance")
    db.commit()

    fresh = db.get(Visit, visit.visit_id)
    assert fresh.status == "completed"
    assert fresh.dwell_seconds == 53 * 60 + 19
    assert vm.visit_for_track("entrance:42") is None

    types = [e.event_type for e in db.query(Event).all()]
    assert "VISIT_CREATED" in types and "VISIT_COMPLETED" in types


def test_visit_ids_are_sequential_per_day(db):
    vm = make_vm()
    v1 = vm.create_visit(db, "entrance", 1, T0)
    v2 = vm.create_visit(db, "entrance", 2, T0)
    db.commit()
    n1 = int(v1.visit_id.rsplit("-", 1)[1])
    n2 = int(v2.visit_id.rsplit("-", 1)[1])
    assert n2 == n1 + 1


def test_handoff_updates_confidence_and_observations(db):
    vm = make_vm()
    visit = vm.create_visit(db, "entrance", 1, T0)
    vm.record_handoff(db, visit.visit_id, "entrance", "service", 9,
                      T0 + timedelta(seconds=12),
                      score={"temporal_score": 0.9}, combined=0.88)
    db.commit()

    fresh = db.get(Visit, visit.visit_id)
    assert fresh.handoff_count == 1
    assert fresh.cameras_observed == 2
    assert fresh.match_confidence == 0.88  # min() of chain
    assert fresh.current_camera == "service"
    assert vm.visit_for_track("service:9") == visit.visit_id

    obs = db.query(VisitObservation).filter_by(visit_id=visit.visit_id).all()
    assert {o.camera_id for o in obs} == {"entrance", "service"}


def test_visit_goes_uncertain_then_lost(db):
    vm = make_vm()
    visit = vm.create_visit(db, "entrance", 1, T0)
    vm.track_ended(db, "entrance:1", T0 + timedelta(minutes=1))
    db.commit()

    vm.expire_visits(db, T0 + timedelta(minutes=15))
    db.commit()
    assert db.get(Visit, visit.visit_id).status == "uncertain"

    vm.expire_visits(db, T0 + timedelta(minutes=90))
    db.commit()
    fresh = db.get(Visit, visit.visit_id)
    assert fresh.status == "lost"
    assert fresh.dwell_seconds is None  # lost visits never get dwell

    types = [e.event_type for e in db.query(Event).all()]
    assert "VISIT_UNCERTAIN" in types and "VISIT_LOST" in types


def test_active_visit_with_live_track_stays_active(db):
    vm = make_vm()
    visit = vm.create_visit(db, "entrance", 1, T0)
    db.commit()
    # track is still associated (someone sitting still) -> only lost applies
    vm.expire_visits(db, T0 + timedelta(minutes=15))
    db.commit()
    assert db.get(Visit, visit.visit_id).status == "active"

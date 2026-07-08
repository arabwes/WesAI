"""Integration tests over the FastAPI app (pipeline disabled)."""

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.database.models import Event, Visit


CAMERAS_YAML = """
cameras:
  - camera_id: cam1
    name: Cam One
    enabled: true
    source: { type: mock }
    role: [entrance, exit]
    lines:
      - line_id: door
        points: [[0, 100], [200, 100]]
        direction_in: down
"""


@pytest.fixture()
def client(env):
    (env / "config" / "cameras.yaml").write_text(CAMERAS_YAML, encoding="utf-8")
    from app.main import create_app

    with TestClient(create_app()) as c:
        yield c


def seed(db):
    now = datetime.now(timezone.utc)
    db.add(Event(event_type="PERSON_ENTERED", timestamp=now - timedelta(minutes=30),
                 camera_id="cam1", visit_id="V-X-00001", confidence=1.0, meta={}))
    db.add(Event(event_type="PERSON_EXITED", timestamp=now - timedelta(minutes=5),
                 camera_id="cam1", visit_id="V-X-00001", confidence=1.0, meta={}))
    db.add(Visit(visit_id="V-X-00001", entry_time=now - timedelta(minutes=30),
                 exit_time=now - timedelta(minutes=5), dwell_seconds=1500,
                 status="completed", entry_camera="cam1", match_confidence=0.95))
    db.commit()


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["database"] == "ok"


def test_system_status(client):
    r = client.get("/api/system/status")
    assert r.status_code == 200
    assert r.json()["backend"] == "ok"


def test_events_create_and_read(client, db):
    seed(db)
    r = client.get("/api/events")
    assert r.status_code == 200
    events = r.json()["events"]
    assert len(events) == 2
    assert {e["event_type"] for e in events} == {"PERSON_ENTERED", "PERSON_EXITED"}

    r2 = client.get("/api/events?event_type=PERSON_ENTERED")
    assert len(r2.json()["events"]) == 1


def test_visit_lifecycle_via_api(client, db):
    seed(db)
    r = client.get("/api/visits")
    assert r.status_code == 200
    visits = r.json()["visits"]
    assert len(visits) == 1
    assert visits[0]["status"] == "completed"
    assert visits[0]["dwell_seconds"] == 1500

    detail = client.get("/api/visits/V-X-00001")
    assert detail.status_code == 200
    assert detail.json()["visit_id"] == "V-X-00001"

    assert client.get("/api/visits/V-NOPE").status_code == 404


def test_analytics_endpoints(client, db):
    seed(db)
    overview = client.get("/api/analytics/overview").json()
    assert overview["customers_today"] == 1
    assert overview["current_occupancy"] == 0
    assert overview["avg_dwell_seconds"] == 1500

    traffic = client.get("/api/analytics/traffic").json()
    assert traffic["entries"] == 1 and traffic["exits"] == 1

    dwell = client.get("/api/analytics/dwell").json()
    assert dwell["all_completed"]["count"] == 1

    quality = client.get("/api/analytics/tracking-quality").json()
    assert quality["visits_total"] == 1
    assert quality["high_confidence_visits"] == 1

    occ = client.get("/api/analytics/occupancy").json()
    assert occ["entries_today"] == 1


def test_analytics_date_range(client, db):
    seed(db)
    r = client.get("/api/analytics/traffic?start=2020-01-01&end=2020-01-02").json()
    assert r["entries"] == 0


def test_cameras_endpoint_without_pipeline(client):
    # pipeline disabled -> empty list, but no crash
    r = client.get("/api/cameras")
    assert r.status_code == 200


def test_calibration_save_persists_yaml(client, env):
    payload = {
        "lines": [{"line_id": "door", "name": "Door", "points": [[10, 90], [190, 90]],
                   "direction_in": "up"}],
        "zones": [{"zone_id": "lobby", "name": "Lobby", "type": "queue",
                   "points": [[0, 0], [50, 0], [50, 50]]}],
        "ignore_zones": [],
    }
    r = client.put("/api/calibration/cam1", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["lines"] == 1 and body["zones"] == 1

    from app.core.config import load_cameras

    cam = load_cameras()[0]
    assert cam.lines[0].direction_in == "up"
    assert cam.zones[0].type == "queue"

    assert client.put("/api/calibration/ghost", json=payload).status_code == 404

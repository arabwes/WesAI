"""End-to-end system validation.

Runs the REAL pipeline (mock cameras, demo scenario) inside a test
client and verifies the full chain:

    config -> migrations -> health -> workers -> events -> visit
    -> cross-camera handoff -> completed visit with dwell -> analytics

Usage (from operations-vision/):
    backend\\.venv\\Scripts\\python scripts\\validate_system.py
    backend\\.venv\\Scripts\\python scripts\\validate_system.py --with-detector

Exit code 0 = all pass.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND))

RESULTS: list[tuple[str, bool, str]] = []


def step(name: str):
    def deco(fn):
        def wrapper(*args, **kwargs):
            try:
                detail = fn(*args, **kwargs) or ""
                RESULTS.append((name, True, str(detail)))
                print(f"  [PASS] {name}" + (f" — {detail}" if detail else ""))
                return True
            except Exception as exc:  # noqa: BLE001
                RESULTS.append((name, False, str(exc)))
                print(f"  [FAIL] {name} — {exc}")
                return False
        return wrapper
    return deco


def poll(fn, timeout_s: float, interval: float = 1.0, what: str = "condition"):
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise TimeoutError(f"timed out after {timeout_s:.0f}s waiting for {what}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-detector", action="store_true",
                        help="also validate the real YOLO detector (downloads yolov8n.pt)")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="max seconds to wait for a completed visit")
    args = parser.parse_args()

    tmp = tempfile.mkdtemp(prefix="opsvision_validate_")
    os.environ["OPSVISION_CONFIG_DIR"] = str(PROJECT_ROOT / "config" / "demo")
    os.environ["OPSVISION_DATA_DIR"] = tmp
    os.environ["OPSVISION_DATABASE_URL"] = f"sqlite:///{Path(tmp, 'validate.db').as_posix()}"
    os.environ.pop("OPSVISION_DISABLE_PIPELINE", None)

    print("Operations Vision — system validation")
    print(f"  scratch dir: {tmp}\n")

    # ---------------- static steps ----------------

    @step("configuration loads (app, cameras, topology)")
    def check_config():
        from app.core.config import load_app_settings, load_cameras, load_topology

        settings = load_app_settings()
        cameras = load_cameras()
        topology = load_topology()
        assert settings.demo.enabled, "demo config should have demo.enabled"
        assert len(cameras) >= 2, "need at least 2 cameras for handoff validation"
        assert topology, "topology must not be empty"
        return f"{len(cameras)} cameras, {len(topology)} transitions"

    @step("topology validates against camera list")
    def check_topology():
        from app.core.config import load_cameras, load_topology
        from app.identity.topology import Topology

        topo = Topology(load_topology())
        problems = topo.validate({c.camera_id for c in load_cameras()})
        assert not problems, "; ".join(problems)

    @step("database migrations apply (alembic upgrade head)")
    def check_migrations():
        from alembic import command
        from alembic.config import Config

        cfg = Config(str(BACKEND / "alembic.ini"))
        cfg.set_main_option("script_location", str(BACKEND / "alembic"))
        command.upgrade(cfg, "head")

    @step("database connects")
    def check_db():
        from sqlalchemy import text

        from app.database.session import new_session

        db = new_session()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()

    ok = all([check_config(), check_topology(), check_migrations(), check_db()])
    if not ok:
        return finish()

    if args.with_detector:
        @step("real YOLO detector finds people (ultralytics sample image)")
        def check_detector():
            import numpy as np
            from urllib.request import urlretrieve

            import cv2

            from app.vision.detectors.ultralytics_detector import UltralyticsDetector

            img_path = Path(tmp) / "bus.jpg"
            urlretrieve("https://ultralytics.com/images/bus.jpg", img_path)
            frame = cv2.imread(str(img_path))
            assert frame is not None
            det = UltralyticsDetector()
            people = [d for d in det.detect(frame) if d.class_name == "person"]
            assert len(people) >= 2, f"expected people on bus.jpg, got {len(people)}"
            return f"{len(people)} persons detected"

        check_detector()

    # ---------------- live pipeline ----------------

    print("\n  starting live pipeline (mock cameras + demo scenario)...")
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as client:

        @step("backend health endpoint")
        def check_health():
            r = client.get("/api/health")
            assert r.status_code == 200 and r.json()["status"] == "ok"

        @step("mock camera workers come online")
        def check_workers():
            def all_online():
                s = client.get("/api/system/status").json()
                cams = s["cameras"]
                return cams if cams and all(
                    h["state"] == "online" for h in cams.values()
                ) else None
            cams = poll(all_online, 30, what="all cameras online")
            return f"{len(cams)} online"

        @step("business events are created and stored")
        def check_events():
            def has_entry():
                evs = client.get("/api/events/recent?limit=100").json()["events"]
                return [e for e in evs if e["event_type"] == "PERSON_ENTERED"] or None
            entries = poll(has_entry, 90, what="PERSON_ENTERED event")
            assert entries[0]["visit_id"], "entry event must reference a visit"
            return f"first entry event visit={entries[0]['visit_id']}"

        @step("anonymous visit is created")
        def check_visit_created():
            def has_visit():
                vs = client.get("/api/visits").json()["visits"]
                return vs or None
            visits = poll(has_visit, 30, what="a visit row")
            v = visits[-1]
            assert v["status"] in ("active", "completed", "uncertain")
            assert v["is_demo"] is True, "demo visits must be labeled"
            return v["visit_id"]

        @step("cross-camera handoff with confidence")
        def check_handoff():
            def has_handoff():
                evs = client.get(
                    "/api/events?event_type=CAMERA_HANDOFF&limit=10"
                ).json()["events"]
                return evs or None
            handoffs = poll(has_handoff, args.timeout, what="CAMERA_HANDOFF event")
            h = handoffs[0]
            assert 0.75 <= h["confidence"] <= 1.0
            assert "temporal_score" in h["metadata"]
            return f"confidence={h['confidence']:.2f}"

        @step("visit completes with dwell time")
        def check_completed():
            def has_completed():
                vs = client.get("/api/visits?status=completed").json()["visits"]
                return [v for v in vs if v["dwell_seconds"]] or None
            done = poll(has_completed, args.timeout, what="completed visit with dwell")
            v = done[0]
            assert v["exit_time"], "completed visit needs exit_time"
            assert v["dwell_seconds"] > 0
            return f"{v['visit_id']} dwell={v['dwell_seconds']:.0f}s conf={v['match_confidence']:.2f}"

        @step("analytics endpoints return coherent results")
        def check_analytics():
            o = client.get("/api/analytics/overview").json()
            assert o["customers_today"] > 0
            assert o["current_occupancy"] >= 0
            assert o["cameras_online"] == o["cameras_total"] >= 2
            t = client.get("/api/analytics/traffic").json()
            assert t["entries"] > 0 and t["by_hour"]
            d = client.get("/api/analytics/dwell").json()
            assert d["all_completed"]["count"] > 0
            assert d["all_completed"]["avg_seconds"] > 0
            q = client.get("/api/analytics/tracking-quality").json()
            assert q["visits_total"] > 0
            assert q["handoffs"] > 0
            return (f"customers={o['customers_today']} occupancy={o['current_occupancy']} "
                    f"avg_dwell={d['all_completed']['avg_seconds']:.0f}s handoffs={q['handoffs']}")

        @step("camera snapshot endpoint serves frames")
        def check_snapshot():
            from app.core.config import load_cameras

            cam_id = load_cameras()[0].camera_id
            r = client.get(f"/api/cameras/{cam_id}/snapshot")
            assert r.status_code == 200
            assert r.headers["content-type"] == "image/jpeg"
            assert len(r.content) > 1000

        steps_ok = check_health() and check_workers()
        if steps_ok:
            check_events()
            check_visit_created()
            check_handoff()
            check_completed()
            check_analytics()
            check_snapshot()

    return finish()


def finish() -> int:
    passed = sum(1 for _, p, _ in RESULTS if p)
    failed = len(RESULTS) - passed
    print(f"\n{'=' * 60}")
    print(f"VALIDATION {'PASSED' if failed == 0 else 'FAILED'}: "
          f"{passed} passed, {failed} failed")
    if failed:
        for name, p, detail in RESULTS:
            if not p:
                print(f"  FAILED: {name} — {detail}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

"""Camera config loading, saving, credential masking."""

import pytest

from app.core.config import load_app_settings, load_cameras, save_cameras
from app.core.security import mask_credentials


CAMERAS_YAML = """
cameras:
  - camera_id: test_cam
    name: Test Camera
    enabled: true
    source:
      type: rtsp
      url_env: TEST_CAM_URL
    processing:
      target_fps: 4
      detection_confidence: 0.5
    role: [entrance, exit]
    lines:
      - line_id: door
        points: [[0, 100], [200, 100]]
        direction_in: down
    zones:
      - zone_id: lobby
        type: transition
        points: [[0, 0], [10, 0], [10, 10]]
"""


def test_load_cameras_from_yaml(env):
    (env / "config" / "cameras.yaml").write_text(CAMERAS_YAML, encoding="utf-8")
    cams = load_cameras()
    assert len(cams) == 1
    cam = cams[0]
    assert cam.camera_id == "test_cam"
    assert cam.is_entrance and cam.is_exit
    assert cam.processing.target_fps == 4
    assert cam.lines[0].direction_in == "down"
    assert len(cam.zones[0].points) == 3


def test_example_fallback_when_real_missing(env):
    (env / "config" / "cameras.example.yaml").write_text(CAMERAS_YAML, encoding="utf-8")
    cams = load_cameras()
    assert cams[0].camera_id == "test_cam"


def test_save_cameras_round_trip(env):
    (env / "config" / "cameras.yaml").write_text(CAMERAS_YAML, encoding="utf-8")
    cams = load_cameras()
    cams[0].lines[0].direction_in = "up"
    save_cameras(cams)
    reloaded = load_cameras()
    assert reloaded[0].lines[0].direction_in == "up"


def test_rtsp_url_from_env(env, monkeypatch):
    (env / "config" / "cameras.yaml").write_text(CAMERAS_YAML, encoding="utf-8")
    monkeypatch.setenv("TEST_CAM_URL", "rtsp://user:secret@10.0.0.5/Preview_01_sub")
    cam = load_cameras()[0]
    assert cam.source.resolve_rtsp_url() == "rtsp://user:secret@10.0.0.5/Preview_01_sub"


def test_line_requires_two_points(env):
    bad = CAMERAS_YAML.replace("[[0, 100], [200, 100]]", "[[0, 100]]")
    (env / "config" / "cameras.yaml").write_text(bad, encoding="utf-8")
    with pytest.raises(Exception):
        load_cameras()


def test_app_settings_defaults(env):
    s = load_app_settings()
    assert s.matching.auto_associate_threshold == 0.90
    assert s.detection.provider == "ultralytics"
    assert s.resolved_database_url().startswith("sqlite")


def test_credentials_masked():
    msg = "cannot open rtsp://admin:hunter2@192.168.1.50/Preview_01_sub"
    masked = mask_credentials(msg)
    assert "hunter2" not in masked
    assert "***:***@192.168.1.50" in masked

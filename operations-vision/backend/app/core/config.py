"""Configuration loading.

Three YAML files (in the directory pointed to by OPSVISION_CONFIG_DIR,
default ``<repo>/config``):

- app.yaml       global application settings
- cameras.yaml   per-camera sources, lines, zones
- topology.yaml  camera-to-camera transition graph

Falls back to the ``*.example.yaml`` variants when the real files are
absent so a fresh checkout runs out of the box.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal, Optional

import yaml
from pydantic import BaseModel, Field, field_validator

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

BACKEND_DIR = Path(__file__).resolve().parents[2]  # .../operations-vision/backend
PROJECT_ROOT = BACKEND_DIR.parent                  # .../operations-vision


def config_dir() -> Path:
    return Path(os.environ.get("OPSVISION_CONFIG_DIR", PROJECT_ROOT / "config"))


def data_dir() -> Path:
    d = Path(os.environ.get("OPSVISION_DATA_DIR", PROJECT_ROOT / "data"))
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------
# Camera configuration models (spec section 8)
# --------------------------------------------------------------------------

SourceType = Literal["rtsp", "video_file", "webcam", "mock"]


class SourceConfig(BaseModel):
    type: SourceType = "mock"
    # rtsp: env var name that holds the URL (never the URL itself in YAML)
    url_env: Optional[str] = None
    # video_file: path relative to project root or absolute
    path: Optional[str] = None
    loop: bool = True
    # webcam: device index
    device_index: int = 0

    def resolve_rtsp_url(self) -> Optional[str]:
        if self.type != "rtsp" or not self.url_env:
            return None
        return os.environ.get(self.url_env)


class ProcessingConfig(BaseModel):
    stream: Literal["sub", "main"] = "sub"
    target_fps: float = 5.0
    detection_confidence: float = 0.45
    min_bbox_area: int = 400
    reconnect_delay_seconds: float = 5.0
    max_reconnect_delay_seconds: float = 60.0


class LineConfig(BaseModel):
    line_id: str
    name: str = ""
    points: list[list[float]] = Field(default_factory=list)  # [[x1,y1],[x2,y2]]
    direction_in: Literal["up", "down", "left", "right"] = "down"
    # crossing robustness
    hysteresis_px: float = 12.0
    cooldown_seconds: float = 2.0
    min_displacement_px: float = 20.0

    @field_validator("points")
    @classmethod
    def _two_points(cls, v: list[list[float]]) -> list[list[float]]:
        if v and len(v) != 2:
            raise ValueError("a crossing line needs exactly 2 points")
        return v


ZoneType = Literal[
    "entrance", "transition", "queue", "order", "pickup",
    "seating", "exit", "ignore", "staff_only",
]


class ZoneConfig(BaseModel):
    zone_id: str
    name: str = ""
    type: ZoneType = "transition"
    points: list[list[float]] = Field(default_factory=list)  # polygon


class CameraConfig(BaseModel):
    camera_id: str
    name: str = ""
    enabled: bool = True
    source: SourceConfig = Field(default_factory=SourceConfig)
    processing: ProcessingConfig = Field(default_factory=ProcessingConfig)
    role: list[str] = Field(default_factory=list)  # entrance / exit / ...
    lines: list[LineConfig] = Field(default_factory=list)
    zones: list[ZoneConfig] = Field(default_factory=list)
    ignore_zones: list[ZoneConfig] = Field(default_factory=list)

    @property
    def is_entrance(self) -> bool:
        return "entrance" in self.role

    @property
    def is_exit(self) -> bool:
        return "exit" in self.role


class CamerasFile(BaseModel):
    cameras: list[CameraConfig] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Topology (spec section 22)
# --------------------------------------------------------------------------

class TransitionConfig(BaseModel):
    from_camera: str = Field(alias="from")
    to_camera: str = Field(alias="to")
    min_seconds: float = 1.0
    expected_seconds: float = 10.0
    max_seconds: float = 60.0
    bidirectional: bool = False

    model_config = {"populate_by_name": True}


class TopologyFile(BaseModel):
    transitions: list[TransitionConfig] = Field(default_factory=list)


# --------------------------------------------------------------------------
# App settings (app.yaml)
# --------------------------------------------------------------------------

class DetectionSettings(BaseModel):
    provider: Literal["ultralytics", "mock"] = "ultralytics"
    model: str = "yolov8n.pt"
    device: str = "cpu"          # "cpu" | "cuda" | "cuda:0"
    classes: list[str] = Field(default_factory=lambda: ["person"])


class TrackingSettings(BaseModel):
    tracker: Literal["auto", "iou", "bytetrack"] = "auto"
    max_age_seconds: float = 2.0     # drop a track after this long unseen
    min_hits: int = 3                # confirm a track after N detections
    iou_threshold: float = 0.25


class MatchingWeights(BaseModel):
    temporal: float = 0.30
    topology: float = 0.20
    direction: float = 0.15
    appearance: float = 0.35


class MatchingSettings(BaseModel):
    auto_associate_threshold: float = 0.90
    conditional_threshold: float = 0.75
    # in the conditional band, require these minimums as extra evidence
    conditional_min_temporal: float = 0.60
    weights: MatchingWeights = Field(default_factory=MatchingWeights)
    appearance_retention_minutes: float = 30.0
    pending_track_ttl_seconds: float = 120.0   # ended tracks stay matchable this long
    new_track_batch_seconds: float = 2.0       # batch window for global assignment


class VisitSettings(BaseModel):
    lost_after_minutes: float = 120.0    # active visit with no updates -> lost
    uncertain_after_minutes: float = 10.0  # no updates -> uncertain (pre-lost)


class DemoSettings(BaseModel):
    enabled: bool = False
    scenario: Optional[str] = None  # path to scenario yaml, relative to config dir


class ServerSettings(BaseModel):
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )


class AppSettings(BaseModel):
    log_level: str = "INFO"
    database_url: Optional[str] = None  # default: sqlite file under data dir
    detection: DetectionSettings = Field(default_factory=DetectionSettings)
    tracking: TrackingSettings = Field(default_factory=TrackingSettings)
    matching: MatchingSettings = Field(default_factory=MatchingSettings)
    visits: VisitSettings = Field(default_factory=VisitSettings)
    demo: DemoSettings = Field(default_factory=DemoSettings)
    server: ServerSettings = Field(default_factory=ServerSettings)

    def resolved_database_url(self) -> str:
        if os.environ.get("OPSVISION_DATABASE_URL"):
            return os.environ["OPSVISION_DATABASE_URL"]
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(data_dir() / 'operations.db').as_posix()}"


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def _read_yaml(path: Path) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _load_with_example_fallback(name: str) -> dict[str, Any]:
    d = config_dir()
    real = d / f"{name}.yaml"
    example = d / f"{name}.example.yaml"
    if real.exists():
        return _read_yaml(real)
    if example.exists():
        return _read_yaml(example)
    return {}


def load_app_settings() -> AppSettings:
    return AppSettings.model_validate(_load_with_example_fallback("app"))


def load_cameras() -> list[CameraConfig]:
    return CamerasFile.model_validate(_load_with_example_fallback("cameras")).cameras


def load_topology() -> list[TransitionConfig]:
    return TopologyFile.model_validate(_load_with_example_fallback("topology")).transitions


def cameras_file_path() -> Path:
    """The file calibration edits should be written to (never the example)."""
    return config_dir() / "cameras.yaml"


def save_cameras(cameras: list[CameraConfig]) -> None:
    payload = {
        "cameras": [
            c.model_dump(mode="json", exclude_none=True) for c in cameras
        ]
    }
    path = cameras_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(payload, f, sort_keys=False, allow_unicode=True)

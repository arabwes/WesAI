"""SQLAlchemy models.

Design notes:
- Everything is anonymous. Visits are opaque ids; no imagery, no
  appearance vectors, and no identity data are ever persisted.
- Occupancy is derived from stored entry/exit events, never a mutable
  counter, so it can always be reconciled.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Camera(Base):
    __tablename__ = "cameras"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    source_type: Mapped[str] = mapped_column(String(16), default="mock")
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class CameraStatus(Base):
    __tablename__ = "camera_status"

    camera_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    state: Mapped[str] = mapped_column(String(16), default="offline")
    last_frame_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    frames_received: Mapped[int] = mapped_column(Integer, default=0)
    frames_processed: Mapped[int] = mapped_column(Integer, default=0)
    processing_fps: Mapped[float] = mapped_column(Float, default=0.0)
    processing_latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    decode_errors: Mapped[int] = mapped_column(Integer, default=0)
    reconnect_attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Visit(Base):
    __tablename__ = "visits"

    visit_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    entry_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    exit_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dwell_seconds: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    entry_camera: Mapped[str | None] = mapped_column(String(64))
    current_camera: Mapped[str | None] = mapped_column(String(64))
    current_zone: Mapped[str | None] = mapped_column(String(64))
    match_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    handoff_count: Mapped[int] = mapped_column(Integer, default=0)
    cameras_observed: Mapped[int] = mapped_column(Integer, default=1)
    completion_reason: Mapped[str | None] = mapped_column(String(64))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class VisitObservation(Base):
    __tablename__ = "visit_observations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    visit_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("visits.visit_id"), index=True
    )
    camera_id: Mapped[str] = mapped_column(String(64))
    camera_track_id: Mapped[str] = mapped_column(String(64))
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    zone: Mapped[str | None] = mapped_column(String(64))
    confidence: Mapped[float] = mapped_column(Float, default=1.0)


class Event(Base):
    __tablename__ = "events"

    event_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    camera_id: Mapped[str | None] = mapped_column(String(64))
    visit_id: Mapped[str | None] = mapped_column(String(32), index=True)
    track_id: Mapped[str | None] = mapped_column(String(64))
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)

    __table_args__ = (
        Index("ix_events_type_ts", "event_type", "timestamp"),
    )


class CameraTransition(Base):
    __tablename__ = "camera_transitions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    from_camera: Mapped[str] = mapped_column(String(64))
    to_camera: Mapped[str] = mapped_column(String(64))
    min_seconds: Mapped[float] = mapped_column(Float, default=1.0)
    expected_seconds: Mapped[float] = mapped_column(Float, default=10.0)
    max_seconds: Mapped[float] = mapped_column(Float, default=60.0)


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )

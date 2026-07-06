"""Business event engine.

Persists structured events and fans them out to in-process rules.
Camera workers never write events directly; everything funnels through
here so persistence, subscriptions and future rule evaluation stay in
one place.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.database.models import Event
from app.events.event_types import EventType

log = logging.getLogger(__name__)


@dataclass
class BusinessEvent:
    event_type: EventType | str
    timestamp: datetime
    camera_id: str | None = None
    visit_id: str | None = None
    track_id: str | None = None
    confidence: float = 1.0
    metadata: dict[str, Any] = field(default_factory=dict)
    is_demo: bool = False


Subscriber = Callable[[BusinessEvent], None]


class EventEngine:
    def __init__(self) -> None:
        self._subscribers: list[Subscriber] = []

    def subscribe(self, fn: Subscriber) -> None:
        self._subscribers.append(fn)

    def emit(self, db: Session, event: BusinessEvent) -> Event:
        """Persist an event and notify subscribers. Caller owns commit."""
        row = Event(
            event_type=str(event.event_type),
            timestamp=event.timestamp,
            camera_id=event.camera_id,
            visit_id=event.visit_id,
            track_id=event.track_id,
            confidence=event.confidence,
            meta=event.metadata,
            is_demo=event.is_demo,
        )
        db.add(row)
        for fn in self._subscribers:
            try:
                fn(event)
            except Exception:  # noqa: BLE001 - a bad rule must not break the pipeline
                log.exception("event subscriber failed for %s", event.event_type)
        return row

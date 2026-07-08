"""Business event vocabulary.

New event types (future: MILK_JUG_DISCARDED, QUEUE_TOO_LONG, ...) are
added here; nothing else in the engine needs to change.
"""

from __future__ import annotations

from enum import StrEnum


class EventType(StrEnum):
    PERSON_DETECTED = "PERSON_DETECTED"
    PERSON_ENTERED = "PERSON_ENTERED"
    PERSON_EXITED = "PERSON_EXITED"
    ZONE_ENTERED = "ZONE_ENTERED"
    ZONE_EXITED = "ZONE_EXITED"
    CAMERA_HANDOFF = "CAMERA_HANDOFF"
    VISIT_CREATED = "VISIT_CREATED"
    VISIT_COMPLETED = "VISIT_COMPLETED"
    VISIT_LOST = "VISIT_LOST"
    VISIT_UNCERTAIN = "VISIT_UNCERTAIN"
    CAMERA_ONLINE = "CAMERA_ONLINE"
    CAMERA_OFFLINE = "CAMERA_OFFLINE"

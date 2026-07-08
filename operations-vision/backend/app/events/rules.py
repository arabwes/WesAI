"""Rule abstraction for future operations features.

A rule listens to business events and may emit derived events, e.g.

    WHEN object_class = whole_milk_jug
    AND object enters trash_disposal_zone
    AND object disappears inside zone
    THEN CREATE MILK_JUG_DISCARDED

The MVP registers no derived rules, but the extension point exists so
inventory/queue/seating analytics can be added without touching the
camera pipeline.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.events.event_engine import BusinessEvent


class Rule(ABC):
    """Stateful event listener that may produce derived business events."""

    @abstractmethod
    def handle(self, event: BusinessEvent) -> list[BusinessEvent]:
        """Return zero or more derived events."""


class RuleSet:
    def __init__(self, rules: list[Rule] | None = None) -> None:
        self.rules = rules or []

    def process(self, event: BusinessEvent) -> list[BusinessEvent]:
        derived: list[BusinessEvent] = []
        for rule in self.rules:
            derived.extend(rule.handle(event))
        return derived

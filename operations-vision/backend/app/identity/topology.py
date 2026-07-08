"""Camera topology: which camera-to-camera transitions are physically
possible and how long they take."""

from __future__ import annotations

from typing import Optional

from app.core.config import TransitionConfig


class Topology:
    def __init__(self, transitions: list[TransitionConfig]) -> None:
        self._map: dict[tuple[str, str], TransitionConfig] = {}
        for t in transitions:
            self._map[(t.from_camera, t.to_camera)] = t
            if t.bidirectional:
                self._map.setdefault(
                    (t.to_camera, t.from_camera),
                    TransitionConfig(
                        **{"from": t.to_camera, "to": t.from_camera},
                        min_seconds=t.min_seconds,
                        expected_seconds=t.expected_seconds,
                        max_seconds=t.max_seconds,
                    ),
                )

    def get(self, from_camera: str, to_camera: str) -> Optional[TransitionConfig]:
        return self._map.get((from_camera, to_camera))

    def possible(self, from_camera: str, to_camera: str) -> bool:
        return (from_camera, to_camera) in self._map

    def neighbors(self, from_camera: str) -> list[str]:
        return [to for (frm, to) in self._map if frm == from_camera]

    def validate(self, camera_ids: set[str]) -> list[str]:
        """Return human-readable problems (unknown cameras, bad timing)."""
        problems = []
        for (frm, to), t in self._map.items():
            if frm not in camera_ids:
                problems.append(f"transition references unknown camera '{frm}'")
            if to not in camera_ids:
                problems.append(f"transition references unknown camera '{to}'")
            if not (0 <= t.min_seconds <= t.expected_seconds <= t.max_seconds):
                problems.append(
                    f"transition {frm}->{to}: need min <= expected <= max seconds"
                )
        return problems

    def as_list(self) -> list[TransitionConfig]:
        return list(self._map.values())

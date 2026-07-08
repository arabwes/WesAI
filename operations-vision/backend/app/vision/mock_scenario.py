"""Scripted scenario engine for mock cameras.

Drives BOTH the MockSource (renders synthetic frames) and the
MockDetector (returns the same actors as detections), so the entire
real pipeline - tracking, line crossing, zones, visits, cross-camera
matching - runs without hardware.

Actors are anonymous colored rectangles following journey scripts:
a journey is a sequence of per-camera path segments separated by
off-camera gaps (which is exactly what exercises handoff matching).
"""

from __future__ import annotations

import itertools
import logging
import random
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import yaml

log = logging.getLogger(__name__)


@dataclass
class JourneyStep:
    camera: Optional[str]  # None = off-camera gap
    path: list[tuple[float, float]] = field(default_factory=list)
    duration: float = 5.0


@dataclass
class JourneyTemplate:
    name: str
    weight: float
    steps: list[JourneyStep]

    @property
    def total_duration(self) -> float:
        return sum(s.duration for s in self.steps)


@dataclass
class Actor:
    actor_id: int
    spawn_time: float          # engine clock seconds
    steps: list[JourneyStep]
    shirt_color: tuple[int, int, int]   # BGR
    pants_color: tuple[int, int, int]
    size: tuple[float, float] = (56.0, 140.0)  # w, h px

    def position_at(self, t: float) -> Optional[tuple[str, float, float]]:
        """(camera_id, x, y) at engine time t, or None if off-camera/done."""
        rel = t - self.spawn_time
        if rel < 0:
            return None
        for step in self.steps:
            if rel <= step.duration:
                if step.camera is None or len(step.path) < 2:
                    return None
                frac = rel / step.duration if step.duration > 0 else 1.0
                # interpolate along polyline
                x, y = _interp_polyline(step.path, frac)
                return (step.camera, x, y)
            rel -= step.duration
        return None

    def finished(self, t: float) -> bool:
        return (t - self.spawn_time) > sum(s.duration for s in self.steps)


def _interp_polyline(points: list[tuple[float, float]], frac: float) -> tuple[float, float]:
    frac = min(max(frac, 0.0), 1.0)
    if len(points) == 2:
        (x0, y0), (x1, y1) = points
        return (x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac)
    # multi-point: proportional to segment lengths
    lengths = []
    for a, b in itertools.pairwise(points):
        lengths.append(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5)
    total = sum(lengths) or 1.0
    target = frac * total
    acc = 0.0
    for (a, b), seg in zip(itertools.pairwise(points), lengths):
        if acc + seg >= target and seg > 0:
            f = (target - acc) / seg
            return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
        acc += seg
    return points[-1]


class ScenarioEngine:
    """Process-wide clock + actor simulator."""

    def __init__(self, config: dict, start_clock: float | None = None) -> None:
        self._lock = threading.Lock()
        self._start = start_clock if start_clock is not None else time.monotonic()
        self.seed = int(config.get("seed", 1234))
        self.rng = random.Random(self.seed)
        self.frame_size: tuple[int, int] = tuple(config.get("frame_size", [960, 540]))  # type: ignore[assignment]
        self.arrivals_per_minute = float(config.get("arrivals_per_minute", 0.0))
        self.duration_jitter = float(config.get("duration_jitter", 0.25))
        self.detection_noise_px = float(config.get("detection_noise_px", 1.5))
        self.templates = self._parse_templates(config.get("journeys", []))
        self.actors: list[Actor] = []
        self._next_actor_id = 1
        self._next_arrival: float = 0.0  # engine time of next auto spawn
        if self.arrivals_per_minute > 0:
            self._next_arrival = self._sample_gap()

    # -- configuration -----------------------------------------------------

    @staticmethod
    def _parse_templates(raw: list[dict]) -> list[JourneyTemplate]:
        templates = []
        for j in raw:
            steps = []
            for s in j.get("steps", []):
                if "gap" in s:
                    steps.append(JourneyStep(camera=None, duration=float(s["gap"])))
                else:
                    steps.append(
                        JourneyStep(
                            camera=s["camera"],
                            path=[tuple(p) for p in s.get("path", [])],
                            duration=float(s.get("duration", 5.0)),
                        )
                    )
            templates.append(
                JourneyTemplate(
                    name=j.get("name", "journey"),
                    weight=float(j.get("weight", 1.0)),
                    steps=steps,
                )
            )
        return templates

    # -- clock -------------------------------------------------------------

    def now(self) -> float:
        return time.monotonic() - self._start

    # -- spawning ----------------------------------------------------------

    def _sample_gap(self) -> float:
        mean_gap = 60.0 / self.arrivals_per_minute
        return self.now() + self.rng.expovariate(1.0 / mean_gap)

    def _pick_template(self) -> JourneyTemplate:
        weights = [t.weight for t in self.templates]
        return self.rng.choices(self.templates, weights=weights, k=1)[0]

    def spawn_actor(self, template: JourneyTemplate | None = None,
                    at: float | None = None) -> Actor:
        with self._lock:
            template = template or self._pick_template()
            jitter = self.duration_jitter
            steps = [
                JourneyStep(
                    camera=s.camera,
                    path=list(s.path),
                    duration=max(0.5, s.duration * self.rng.uniform(1 - jitter, 1 + jitter)),
                )
                for s in template.steps
            ]
            actor = Actor(
                actor_id=self._next_actor_id,
                spawn_time=self.now() if at is None else at,
                steps=steps,
                shirt_color=self._random_color(),
                pants_color=self._random_color(),
            )
            self._next_actor_id += 1
            self.actors.append(actor)
            log.debug("spawned actor %d (%s)", actor.actor_id, template.name)
            return actor

    def spawn_by_name(self, name: str, at: float | None = None) -> Actor:
        for t in self.templates:
            if t.name == name:
                return self.spawn_actor(t, at=at)
        raise KeyError(f"no journey template named {name!r}")

    def _random_color(self) -> tuple[int, int, int]:
        # saturated distinct colors so appearance histograms carry signal
        h = self.rng.random()
        import colorsys

        r, g, b = colorsys.hsv_to_rgb(h, self.rng.uniform(0.6, 1.0), self.rng.uniform(0.5, 0.95))
        return (int(b * 255), int(g * 255), int(r * 255))

    # -- simulation --------------------------------------------------------

    def tick(self) -> None:
        """Auto-spawn actors and cull finished ones."""
        t = self.now()
        with self._lock:
            if self.arrivals_per_minute > 0 and self.templates:
                while self._next_arrival <= t:
                    self._next_arrival += self.rng.expovariate(
                        self.arrivals_per_minute / 60.0
                    )
                    # spawn outside lock is nicer but keep it simple: inline
                    template = self._pick_template()
                    jitter = self.duration_jitter
                    steps = [
                        JourneyStep(
                            camera=s.camera,
                            path=list(s.path),
                            duration=max(
                                0.5, s.duration * self.rng.uniform(1 - jitter, 1 + jitter)
                            ),
                        )
                        for s in template.steps
                    ]
                    self.actors.append(
                        Actor(
                            actor_id=self._next_actor_id,
                            spawn_time=t,
                            steps=steps,
                            shirt_color=self._random_color(),
                            pants_color=self._random_color(),
                        )
                    )
                    self._next_actor_id += 1
            self.actors = [a for a in self.actors if not a.finished(t)]

    def actors_on_camera(self, camera_id: str) -> list[tuple[Actor, float, float]]:
        """(actor, cx, cy) for actors currently visible on this camera."""
        self.tick()
        t = self.now()
        out = []
        with self._lock:
            for a in self.actors:
                pos = a.position_at(t)
                if pos and pos[0] == camera_id:
                    out.append((a, pos[1], pos[2]))
        return out


# --------------------------------------------------------------------------
# Process-wide registry
# --------------------------------------------------------------------------

_engine: ScenarioEngine | None = None
_engine_lock = threading.Lock()


def init_engine(scenario_path: str | Path) -> ScenarioEngine:
    global _engine
    with _engine_lock:
        with open(scenario_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        _engine = ScenarioEngine(config)
        log.info(
            "scenario engine loaded: %d journeys, %.1f arrivals/min",
            len(_engine.templates), _engine.arrivals_per_minute,
        )
        return _engine


def init_engine_from_dict(config: dict) -> ScenarioEngine:
    global _engine
    with _engine_lock:
        _engine = ScenarioEngine(config)
        return _engine


def get_engine() -> ScenarioEngine | None:
    return _engine


def reset_engine() -> None:
    global _engine
    with _engine_lock:
        _engine = None

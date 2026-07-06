"""Cross-camera anonymous visit association.

When a track ends on camera A it becomes a "pending" candidate; when
new tracks start elsewhere they are batched briefly and matched
GLOBALLY (Hungarian assignment) against all pending candidates, so
three people moving together don't get greedily mis-assigned.

The system prefers "unknown" over a bad match: pairs below the
confidence thresholds are rejected and the new track simply starts
unassociated (spec section 15).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
from scipy.optimize import linear_sum_assignment

from app.core.config import MatchingSettings
from app.identity.appearance import appearance_similarity
from app.identity.confidence import MatchScore, combine, direction_score, temporal_score
from app.identity.topology import Topology

log = logging.getLogger(__name__)


@dataclass
class PendingEndedTrack:
    """A track that disappeared and may reappear on a neighboring camera."""
    camera_id: str
    track_id: int
    visit_id: str
    ended_at: datetime
    velocity: tuple[float, float]
    appearance: Optional[np.ndarray]
    expires_monotonic: float

    @property
    def key(self) -> str:
        return f"{self.camera_id}:{self.track_id}"


@dataclass
class NewTrackCandidate:
    camera_id: str
    track_id: int
    started_at: datetime
    velocity: tuple[float, float]
    appearance: Optional[np.ndarray]
    queued_monotonic: float = field(default_factory=time.monotonic)

    @property
    def key(self) -> str:
        return f"{self.camera_id}:{self.track_id}"


@dataclass
class MatchResult:
    new_track: NewTrackCandidate
    ended_track: PendingEndedTrack
    score: MatchScore


class CrossCameraMatcher:
    def __init__(self, topology: Topology, settings: MatchingSettings) -> None:
        self.topology = topology
        self.settings = settings
        self.pending: dict[str, PendingEndedTrack] = {}
        self.queue: dict[str, NewTrackCandidate] = {}
        self.rejected_count = 0
        self.accepted_count = 0

    # ------------------------------------------------------------- intake

    def add_ended_track(self, track: PendingEndedTrack) -> None:
        self.pending[track.key] = track

    def remove_visit(self, visit_id: str) -> None:
        """Visit completed/lost -> its pending tracks can no longer match."""
        for key in [k for k, p in self.pending.items() if p.visit_id == visit_id]:
            del self.pending[key]

    def queue_new_track(self, candidate: NewTrackCandidate) -> None:
        self.queue[candidate.key] = candidate

    def dequeue_new_track(self, key: str) -> None:
        """Track got a visit some other way (e.g. entrance) or already died."""
        self.queue.pop(key, None)

    # ------------------------------------------------------------ matching

    def _score_pair(self, new: NewTrackCandidate,
                    ended: PendingEndedTrack) -> Optional[MatchScore]:
        if new.camera_id == ended.camera_id:
            return None  # same-camera re-id is the tracker's job, not ours
        spec = self.topology.get(ended.camera_id, new.camera_id)
        if spec is None:
            return None  # physically impossible transition
        dt = (new.started_at - ended.ended_at).total_seconds()
        t_score = temporal_score(dt, spec)
        if t_score <= 0.0:
            return None
        d_score = direction_score(ended.velocity, new.velocity)
        a_score = appearance_similarity(ended.appearance, new.appearance)
        return combine(t_score, 1.0, d_score, a_score, self.settings.weights)

    def process(self, now_monotonic: float | None = None) -> list[MatchResult]:
        """Run global assignment over candidates whose batch window elapsed."""
        now = time.monotonic() if now_monotonic is None else now_monotonic

        # expire stale pending tracks
        for key in [k for k, p in self.pending.items() if now > p.expires_monotonic]:
            del self.pending[key]

        ready = [
            c for c in self.queue.values()
            if now - c.queued_monotonic >= self.settings.new_track_batch_seconds
        ]
        if not ready or not self.pending:
            # nothing to match against: release ready candidates as unmatched
            for c in ready:
                del self.queue[c.key]
            return []

        pending_list = list(self.pending.values())
        scores: dict[tuple[int, int], MatchScore] = {}
        cost = np.ones((len(ready), len(pending_list)), dtype=float)
        for i, new in enumerate(ready):
            for j, ended in enumerate(pending_list):
                s = self._score_pair(new, ended)
                if s is not None:
                    scores[(i, j)] = s
                    cost[i, j] = 1.0 - s.combined

        rows, cols = linear_sum_assignment(cost)
        results: list[MatchResult] = []
        for i, j in zip(rows, cols):
            new, ended = ready[i], pending_list[j]
            s = scores.get((i, j))
            if s is None:
                del self.queue[new.key]  # no feasible pairing -> unmatched
                continue
            if self._accept(s):
                results.append(MatchResult(new_track=new, ended_track=ended, score=s))
                self.accepted_count += 1
                del self.queue[new.key]
                del self.pending[ended.key]
            else:
                self.rejected_count += 1
                log.debug(
                    "handoff rejected %s -> %s (combined=%.2f)",
                    ended.key, new.key, s.combined,
                )
                del self.queue[new.key]

        # unmatched ready candidates leave the queue too
        for i, new in enumerate(ready):
            self.queue.pop(new.key, None)
        return results

    def _accept(self, s: MatchScore) -> bool:
        if s.combined >= self.settings.auto_associate_threshold:
            return True
        if s.combined >= self.settings.conditional_threshold:
            # moderate band: only with strong topology+timing evidence
            return s.temporal >= self.settings.conditional_min_temporal
        return False

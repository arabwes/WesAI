# Architecture

```
                 ┌──────────── per camera (thread) ────────────┐
RTSP/video/mock →│ StreamReader → fps throttle → Detector      │
                 │   → Tracker → LineCrossing + ZoneTracker    │──┐
                 └─────────────────────────────────────────────┘  │ queue.Queue
                                                                   ▼
                 ┌──────────── coordinator (asyncio) ──────────────────────┐
                 │ VisitManager ── CrossCameraMatcher ── AppearanceStore   │
                 │        └────────── EventEngine ──────────┘              │
                 └──────────────────────────┬─────────────────────────────┘
                                            ▼
                                     SQLite (WAL)  ←→  Analytics  ←→  FastAPI  ←→  React
```

## Key decisions

**Workers are isolated threads.** OpenCV capture blocks, so each camera
gets a daemon thread with its own source, detector handle, tracker, and
spatial detectors. A camera failing only affects itself; reconnect uses
capped exponential backoff. Workers never touch the database.

**One writer.** Workers emit typed messages (`TrackStarted/Ended`,
`LineCrossing`, `ZoneTransition`, `CameraState`) onto a bounded queue.
The coordinator (single asyncio task) consumes them, owns all visit
state, and is the only DB writer — no cross-thread session juggling.

**Events are the source of truth.** Occupancy is derived from stored
PERSON_ENTERED/EXITED events (reconcilable), never a mutable counter.
The `EventEngine` is the single funnel for persistence + in-process
subscription; `events/rules.py` is the extension point for future
derived events (MILK_JUG_DISCARDED, QUEUE_TOO_LONG, ...).

**Everything is behind an abstraction:**

| seam | interface | implementations |
|---|---|---|
| frame source | `FrameSource` | rtsp, video_file, webcam, mock |
| detection | `DetectionProvider` | UltralyticsDetector (YOLOv8n), MockDetector |
| tracking | `Tracker` | IouTracker (deterministic), ByteTrackTracker (supervision) |
| matching signals | `confidence.py` | temporal, topology, direction, appearance |

**Cross-camera matching** (identity/cross_camera_matcher.py): ended
tracks wait in a TTL pool; new tracks batch for ~2 s, then a global
Hungarian assignment (scipy) pairs them using
`w·temporal + w·topology + w·direction + w·appearance` with weights
renormalized over available signals. Acceptance: ≥0.90 auto; 0.75–0.90
only with strong timing evidence; below → rejected (visit stays
unmatched). All thresholds live in `config/app.yaml`.

**Mock scenario engine** (vision/mock_scenario.py) drives both the
MockSource (renders frames) and MockDetector (returns the same actors
as detections), so demo mode exercises the entire real pipeline —
tracking, crossings, zones, visits, handoffs — with zero hardware.

**Database** is SQLite in WAL mode via SQLAlchemy 2 + Alembic;
`database_url` accepts Postgres when multi-store aggregation ever
matters.

## Scaling notes

- Detection FPS is per-camera configurable (`processing.target_fps`);
  frames are always decoded (keeps streams healthy) but only sampled
  frames run inference.
- YOLO model instances are shared per (model, device) across workers
  with a serializing lock — one model in RAM regardless of camera count.
- The 6 GB GTX 1660 can run yolov8n on `device: cuda` if CPU becomes the
  bottleneck with more cameras.

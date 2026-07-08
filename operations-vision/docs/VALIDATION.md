# Validation

## Automated

```powershell
# unit + integration tests (fast, isolated temp DBs)
cd backend
.venv\Scripts\python -m pytest tests -q

# full end-to-end validation (~2 min): boots the real pipeline on mock
# cameras and checks config → migrations → health → workers → events →
# visit → handoff → completed visit with dwell → analytics
cd ..
backend\.venv\Scripts\python scripts\validate_system.py

# additionally proves the real YOLO path (downloads yolov8n.pt once,
# runs it on ultralytics' sample image and expects people)
backend\.venv\Scripts\python scripts\validate_system.py --with-detector
```

## What the test suite covers

Geometry (point-in-polygon, signed line distance), directional line
crossing with hysteresis/cooldown/min-displacement/debounce, zone
transition debounce, IoU tracker lifecycle, dwell buckets + statistics +
confidence segmentation, visit lifecycle (create → handoff → complete;
uncertain → lost expiry), occupancy derivation (incl. negative-delta
reconciliation), topology validation, transition timing score, combined
confidence with missing signals, cross-camera matcher accept/reject +
global Hungarian pairing + TTL expiry, appearance store TTL, camera
config load/save round-trips, credential masking, and the REST API
(health, events, visits, analytics, calibration persistence).

## Hardware-dependent validation (pending real cameras)

| item | status | alternative validation done |
|---|---|---|
| Reolink RTSP ingest | BLOCKED — no camera on this network | `RtspSource` shares the OpenCV capture path with `VideoFileSource`, which is tested against a generated mp4; URL/env config validated in tests; `scripts/test_rtsp.py` ready |
| Real-footage detection accuracy | BLOCKED — no store footage | YOLO path validated on ultralytics sample image (`--with-detector`); thresholds configurable + calibration UI |
| GPU (CUDA) inference | not tested here | `detection.device` flag wired through; CPU path validated |

## First real-world test (recommended order)

1. Mount the entrance camera, add the RTSP URL to `.env`, run
   `scripts/test_rtsp.py --env CAMERA_ENTRANCE_RTSP_URL`.
2. Run backend with real config, calibrate the door line.
3. **Walk in and out 10 times** (vary speed, pause in the doorway twice,
   walk in pairs once). Expect: 10 entries / 10 exits, no double counts
   from the doorway pauses, and paired walkers counted as 2.
4. Compare a full day's entry count against the POS transaction count —
   they won't match 1:1 (groups, browsers) but should correlate day over day.

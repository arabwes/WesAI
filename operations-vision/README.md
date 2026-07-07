# Operations Vision

Anonymous multi-camera business operations platform for my coffee shop.
Counts entries/exits, estimates occupancy, measures dwell time, and follows
**anonymous** visits across cameras — with no facial recognition and no
identity data, ever. See [docs/PRIVACY_MODEL.md](docs/PRIVACY_MODEL.md).

```
CAMERAS (Reolink RTSP) → DETECTION (YOLO) → TRACKING → LINES/ZONES
      → ANONYMOUS VISITS → CROSS-CAMERA MATCHING → EVENTS → SQLITE
      → ANALYTICS API (FastAPI) → DASHBOARD (React)
```

## Quick start (Windows, from this directory)

```powershell
# 1. Backend
python -m venv backend\.venv
backend\.venv\Scripts\python -m pip install -r backend\requirements.txt

# 2. Frontend
npm install --prefix frontend

# 3. Run everything in DEMO MODE (no cameras needed)
$env:OPSVISION_CONFIG_DIR = "$PWD\config\demo"
cd backend
.venv\Scripts\python -m alembic upgrade head
.venv\Scripts\python -m uvicorn app.main:app --port 8000
# ...in a second terminal:
npm run dev --prefix frontend
```

Open **http://localhost:5173**. A yellow DEMO MODE banner confirms you are
looking at simulated data; simulated customers flow through three mock
cameras and the dashboard fills up within a couple of minutes.

Optionally seed two weeks of historical demo data so charts are full
immediately:

```powershell
$env:OPSVISION_CONFIG_DIR = "$PWD\config\demo"
backend\.venv\Scripts\python scripts\generate_demo_events.py --days 14
```

## Run the tests and system validation

```powershell
cd backend
.venv\Scripts\python -m pytest tests -q          # 73 unit + integration tests
cd ..
backend\.venv\Scripts\python scripts\validate_system.py                  # full E2E (~2 min)
backend\.venv\Scripts\python scripts\validate_system.py --with-detector  # + real YOLO check
```

`validate_system.py` boots the real pipeline against mock cameras and
verifies: config → migrations → health → workers online → events →
visit created → cross-camera handoff → completed visit with dwell →
analytics coherent. Clear PASS/FAIL output, exit code 0 on success.

## Adding your first real camera

1. In the Reolink app/web UI, create a camera user and note the RTSP URL.
   Use the **substream** for AI processing (low res is plenty):
   `rtsp://USER:PASS@192.168.1.50/Preview_01_sub`
2. Copy `.env.example` to `.env` and put the URL there (never in YAML/git):
   ```
   CAMERA_ENTRANCE_RTSP_URL=rtsp://USER:PASS@192.168.1.50/Preview_01_sub
   ```
3. Test connectivity:
   ```powershell
   backend\.venv\Scripts\python scripts\test_rtsp.py --env CAMERA_ENTRANCE_RTSP_URL
   ```
4. Copy `config\cameras.example.yaml` → `config\cameras.yaml`, keep the
   entrance camera, set `enabled: true` (leave others `enabled: false`
   until installed). Copy `app.example.yaml` → `app.yaml` and
   `topology.example.yaml` → `topology.yaml` the same way.
5. Start the backend **without** the demo config dir
   (`Remove-Item Env:OPSVISION_CONFIG_DIR` or point it at `config\`).
6. Open **Calibration** in the dashboard, capture a frame, draw the door
   line, set the inward direction, save. Done — entries/exits start
   counting immediately. See [docs/CALIBRATION.md](docs/CALIBRATION.md).

Camera-to-camera handoff needs `config\topology.yaml` — see
[docs/CAMERA_SETUP.md](docs/CAMERA_SETUP.md).

## Docker

```bash
docker compose up -d --build
# dashboard http://localhost:8080, API http://localhost:8000
```

## Repository layout

```
backend/app/vision/     stream sources, detectors, trackers, lines, zones, camera workers
backend/app/identity/   anonymous visits, appearance (TTL memory only), cross-camera matcher
backend/app/events/     business event engine + rule abstraction
backend/app/analytics/  traffic, occupancy, dwell, tracking quality
backend/app/api/        REST endpoints
frontend/               React dashboard + SVG calibration editor
config/                 app / cameras / topology YAML (+ demo mode configs)
scripts/                validate_system, generate_demo_events, test_rtsp, purge, sample video
docs/                   architecture, camera setup, calibration, privacy, remote deployment
```

## Known limitations

- **Accuracy is untuned against real footage.** Detection thresholds,
  line hysteresis, and matching weights are sensible starting points;
  expect a calibration pass once real cameras are mounted.
- **Direction score is a weak signal** between arbitrarily oriented
  cameras; it is deliberately low-weighted. Topology + timing +
  appearance carry the match.
- **Appearance matching uses clothing color histograms** — two people in
  near-identical outfits arriving within seconds of each other can
  confuse it; the system prefers `unknown` (visit marked uncertain/lost)
  over guessing.
- **Occupancy needs both an entry and exit line** actually covering every
  door; a missed exit inflates occupancy until the daily reset.
- **Single process, SQLite.** Fine for one store and a handful of
  cameras; Postgres migration is a config change when needed.
- **GPU inference untested** in this environment (device flag `cuda`
  exists; CPU validated at 3–5 fps/camera with yolov8n).

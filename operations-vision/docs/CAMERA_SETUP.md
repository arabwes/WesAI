# Camera Setup

## Reolink RTSP

1. In the Reolink app: **Settings → Network → Advanced → Port Settings**
   and make sure **RTSP** is enabled.
2. Create a dedicated user for this system (don't use admin).
3. URL patterns (channel 1):
   - substream (low res — use this): `rtsp://USER:PASS@IP/Preview_01_sub`
   - mainstream (full res): `rtsp://USER:PASS@IP/Preview_01_main`
   Some models use `h264Preview_01_sub`; `scripts/test_rtsp.py` will tell
   you quickly which works.
4. Give each camera a **DHCP reservation or static IP** on the store
   router so URLs don't rot.

## Wiring URLs into the app

URLs live in `.env` only (git-ignored). `config/cameras.yaml` references
the environment variable *name*:

```yaml
source:
  type: rtsp
  url_env: CAMERA_ENTRANCE_RTSP_URL
```

Test before wiring in:

```powershell
backend\.venv\Scripts\python scripts\test_rtsp.py --env CAMERA_ENTRANCE_RTSP_URL
```

## Per-camera processing settings

```yaml
processing:
  target_fps: 5              # AI frames/sec (decoding runs at native fps)
  detection_confidence: 0.45 # raise if you get ghost detections
  min_bbox_area: 400         # filters far-away/partial boxes
  reconnect_delay_seconds: 5 # backoff doubles up to 60s
```

3–5 fps is plenty for people analytics. Prefer more cameras at low fps
over one camera at high fps.

## Roles, lines, zones

- `role: [entrance, exit]` on any camera that sees a door. Entry/exit
  lines are drawn in the **Calibration** page — you never type pixel
  coordinates by hand.
- Zones (queue/order/pickup/seating/ignore) are also drawn there.

## Topology (`config/topology.yaml`)

Tell the matcher which camera-to-camera walks are physically possible
and how long they take. Walk each path yourself with a stopwatch:

```yaml
transitions:
  - from: entrance_front
    to: order_queue
    min_seconds: 1        # fastest plausible
    expected_seconds: 7   # typical
    max_seconds: 30       # slower than this = not the same person
```

Add a transition for every real path (including grab-and-go back to the
door). A transition that isn't listed can never produce a handoff —
missing edges show up as `lost` visits on the Dwell page.

## Applying changes

- Calibration page saves + hot-reloads automatically.
- Manual YAML edits: click **Reload configuration** on the Cameras page
  (or `POST /api/cameras/reload`). Only changed workers restart.

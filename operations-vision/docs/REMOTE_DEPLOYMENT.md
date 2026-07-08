# Remote Deployment

Target: a small PC in the store on the camera VLAN/LAN, managed remotely.

```
Reolink cameras ──(RTSP, LAN only)──► store PC (backend + dashboard)
                                          │
                                     Tailscale (private mesh)
                                          │
                                     your laptop/phone
```

## Rules

- **Never expose RTSP or the API to the public internet.** No router
  port-forwards. Cameras should ideally have no internet route at all.
- Remote access goes over **Tailscale** (free tier is fine):
  1. Install Tailscale on the store PC and your devices, same tailnet.
  2. The dashboard is then reachable at `http://<store-pc-tailscale-ip>:8080`
     (Docker) or `:5173`/`:8000` (dev) from your devices only.
  3. Optional hardening: Tailscale ACLs so only your devices reach those
     ports, and MagicDNS for a friendly name like `http://shibam-pc:8080`.
- Tailscale is **not** required for local development — everything binds
  to localhost by default.

## Store PC install (Docker, recommended)

```bash
git clone <this repo> && cd operations-vision
cp .env.example .env      # fill in real RTSP URLs
cp config/app.example.yaml config/app.yaml
cp config/cameras.example.yaml config/cameras.yaml
cp config/topology.example.yaml config/topology.yaml
docker compose up -d --build
```

`restart: unless-stopped` in docker-compose gives you start-on-boot as
long as Docker Desktop / the docker service itself starts on boot.

## Native Windows start-on-boot (alternative)

Task Scheduler → Create Task → trigger *At startup* → action:

```
Program:  C:\opsvision\operations-vision\backend\.venv\Scripts\python.exe
Args:     -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Start in: C:\opsvision\operations-vision\backend
```

Serve the dashboard by any static server pointing at `frontend\dist`
(after `npm run build`), or just use the Docker route above.

## Environment variables in production

Set real values in `.env` (compose reads it automatically):
RTSP URLs, optionally `OPSVISION_DATA_DIR` for where the SQLite DB and
snapshots live. Secrets never go in YAML or git.

## Remote operations checklist

- Health: `GET /api/health`, `GET /api/system/status`
- Camera trouble: Cameras page shows state/errors (credentials masked);
  `POST /api/cameras/reload` after config edits.
- Logs: `docker compose logs -f backend`
- DB hygiene: `scripts/purge_temporary_data.py --older-than 365`

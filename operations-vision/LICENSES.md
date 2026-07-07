# Dependency Licenses

Internal-use software for my own businesses; not distributed or sold.
Major dependencies and their licenses, for the record:

| Dependency | License | Notes |
|---|---|---|
| FastAPI, Starlette, Uvicorn | MIT | |
| Pydantic | MIT | |
| SQLAlchemy, Alembic | MIT | |
| NumPy | BSD-3 | |
| SciPy | BSD-3 | Hungarian assignment |
| OpenCV (opencv-python) | Apache-2.0 | |
| **Ultralytics (YOLOv8)** | **AGPL-3.0** | Fine for internal use. If this project were ever distributed/sold as a service, either comply with AGPL source-sharing or swap the detector (the `DetectionProvider` abstraction exists for exactly this). |
| supervision (Roboflow) | MIT | ByteTrack implementation |
| PyYAML | MIT | |
| pytest, httpx | MIT / BSD | dev/test |
| React, react-dom, react-router | MIT | |
| Recharts | MIT | |
| Vite, TypeScript | MIT / Apache-2.0 | build tooling |
| yolov8n.pt weights | AGPL-3.0 (Ultralytics) | downloaded at first run, not committed |

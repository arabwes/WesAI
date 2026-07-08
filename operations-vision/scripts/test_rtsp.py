"""Quick RTSP connectivity check for a Reolink (or any) camera.

    python scripts/test_rtsp.py rtsp://user:pass@192.168.1.50/Preview_01_sub
    python scripts/test_rtsp.py --env CAMERA_ENTRANCE_RTSP_URL

Reads a few frames, reports resolution/fps, and saves a snapshot next
to this script so you can verify the view. The URL is never printed
with credentials.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

from app.core.security import mask_credentials  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", help="rtsp:// url (or use --env)")
    parser.add_argument("--env", help="name of the environment variable holding the url")
    parser.add_argument("--frames", type=int, default=30)
    args = parser.parse_args()

    url = args.url or (os.environ.get(args.env) if args.env else None)
    if not url:
        parser.error("provide a URL or --env VAR_NAME (is your .env loaded?)")

    import cv2

    print(f"Connecting to {mask_credentials(url)} ...")
    cap = cv2.VideoCapture(url)
    if not cap.isOpened():
        print("FAILED to open stream. Check: camera IP, credentials, RTSP enabled "
              "in the Reolink app (Settings > Network > Advanced > Port Settings).")
        return 1

    t0 = time.monotonic()
    frames = 0
    frame = None
    while frames < args.frames:
        ok, frame = cap.read()
        if not ok:
            print(f"stream read failed after {frames} frames")
            return 1
        frames += 1
    elapsed = time.monotonic() - t0
    h, w = frame.shape[:2]
    print(f"OK: {frames} frames in {elapsed:.1f}s ({frames / elapsed:.1f} fps), {w}x{h}")

    snap = PROJECT_ROOT / "data" / "rtsp_test_snapshot.jpg"
    snap.parent.mkdir(exist_ok=True)
    cv2.imwrite(str(snap), frame)
    print(f"snapshot saved: {snap}")
    cap.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())

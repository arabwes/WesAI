"""Generate a synthetic walking-figure video for video_file source testing.

    python scripts/generate_sample_video.py
    -> sample_data/sample_walk.mp4 (20s, 15fps, 960x540)

Note: the figures are simple two-tone shapes. They exercise the
video_file source + tracking pipeline with the mock detector, but a
real YOLO detector needs real footage to detect anything.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    import cv2

    out_dir = PROJECT_ROOT / "sample_data"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "sample_walk.mp4"

    w, h, fps, seconds = 960, 540, 15, 20
    writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not writer.isOpened():
        print("failed to open VideoWriter (mp4v codec missing?)")
        return 1

    total = fps * seconds
    for i in range(total):
        frame = np.full((h, w, 3), 46, dtype=np.uint8)
        t = i / total
        # figure 1: walks top to bottom
        cx, cy = int(480 + 60 * np.sin(t * 6)), int(60 + t * 420)
        cv2.rectangle(frame, (cx - 28, cy - 100), (cx + 28, cy - 45), (60, 170, 230), -1)
        cv2.rectangle(frame, (cx - 28, cy - 45), (cx + 28, cy), (140, 80, 40), -1)
        # figure 2: walks right to left, offset in time
        if t > 0.3:
            t2 = (t - 0.3) / 0.7
            cx2, cy2 = int(900 - t2 * 800), 400
            cv2.rectangle(frame, (cx2 - 28, cy2 - 100), (cx2 + 28, cy2 - 45), (90, 200, 90), -1)
            cv2.rectangle(frame, (cx2 - 28, cy2 - 45), (cx2 + 28, cy2), (50, 50, 160), -1)
        writer.write(frame)
    writer.release()
    print(f"wrote {out_path} ({seconds}s @ {fps}fps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

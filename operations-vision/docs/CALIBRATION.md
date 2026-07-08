# Calibration

Open **Calibration** in the dashboard. Everything is drawn on a live
captured frame — no manual pixel math.

## Entry/exit lines

1. Pick the camera, click **Capture new frame**.
2. Click **+ Line**, then click two points spanning the doorway.
   Put the line ~1–2 m inside the door on the floor, not on the door
   itself (people pause in doorways).
3. With the line selected, choose the **inward direction** — the way a
   person moves *into* the store when crossing (usually `down` for a
   ceiling camera facing the door).
4. Name it and **Save & reload**.

Crossings are debounced (hysteresis band, per-track cooldown, minimum
displacement), so hovering on the line does not double-count. Those
knobs are per-line in `cameras.yaml` if a doorway needs tuning:
`hysteresis_px`, `cooldown_seconds`, `min_displacement_px`.

## Zones

**+ Zone** → click the corners of the area → **Finish polygon** → set
the type (queue / order / pickup / seating / transition / staff_only).
Zone membership uses the person's *feet* (bottom-center of the box), so
draw zones on the floor, not at head height.

## Ignore areas

**+ Ignore area** for anything the detector should never consider:
sidewalk visible through the window, TV screens, posters of people.

## Editing

Click any shape to select it: drag its points, rename it, change type or
direction, or delete it. **Save & reload** persists to
`config/cameras.yaml` and hot-reloads the running camera worker —
no restart, and crossing state resets cleanly.

## Sanity check after calibrating

Walk through the door yourself:
- Overview → "Customers today" increments on the way in.
- Visits → a new active visit appears; leaving completes it.
- If a crossing counts backwards, flip the line's inward direction.

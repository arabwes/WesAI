# Privacy Model

This system is built so that it **cannot** identify anyone, by design.

## What it never does

- No facial recognition, no face detection, no face crops, no face embeddings.
- No attempt to determine names, phone numbers, emails, loyalty/payment
  identity, demographics, age, gender, ethnicity, or religion.
- No recognition of returning customers. Someone who visits twice is two
  unrelated anonymous visits. There is no gallery, no long-term feature
  database, nothing to match against.

## What it does instead

A customer's time in the store is one **anonymous visit**:

```
enters → V-20260706-00842 created → tracked between cameras → exits → visit closed
```

Identifiers used:

| id | scope | lifetime |
|---|---|---|
| `camera_track_id` | one person on one camera | seconds–minutes (in memory) |
| `visit_id` | one anonymous in-store visit | permanent (opaque id + timestamps only) |
| `event_id` | one business event | permanent |

## Temporary appearance features

To hand a visit from one camera to the next, the matcher compares
clothing-level color histograms (HSV, upper/lower body bands) of the
whole person crop. These vectors:

- carry no identity — they are literally "wearing something teal on top",
- live **only in RAM** (`AppearanceStore`), never in the database or on disk,
- expire automatically after `matching.appearance_retention_minutes`
  (default 30) and are dropped when a visit closes,
- are never compared across days — the pending-match pool only holds
  tracks from the last `pending_track_ttl_seconds` (default 120 s).

The System Health page shows how many vectors are currently held.

## What is stored permanently

Events (entered/exited/zone/handoff with confidence scores), visits
(timestamps, dwell, status, confidence), and aggregates. **No imagery is
persisted** — camera snapshots are served live from memory for
diagnostics/calibration only.

## Preference for "unknown"

Handoffs below the confidence thresholds are rejected: a visit is marked
`uncertain`/`lost` rather than merged on a guess, because a wrong merge
corrupts dwell analytics *and* would amount to inventing a journey that
never happened.

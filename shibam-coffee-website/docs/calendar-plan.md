# Portal calendar and booking links — implementation plan

Status: proposal, nothing built yet. Review the decisions and open questions
at the bottom before work starts.

## Goal

Add a Calendly-style calendar to the team portal:

1. A Lead or Management user configures event types (first use case: a
   "30-minute interview") and their weekly availability.
2. They send one reusable link to a client or job candidate. The invitee picks
   a slot and books without logging in.
3. A shared team calendar shows upcoming events for everyone.
4. A booked meeting's details are visible only to the person who owns the
   link and to Management (the portal's admin role).

## How it fits the existing stack

| Concern | Reuse |
|---|---|
| Hosting, routing | Cloudflare Pages + Functions. Authenticated calls go through the `ACTIONS` map in `functions/api/team/index.js`. |
| Public, no-login endpoint | Same pattern as `functions/api/contact-request.js` and `catering-request.js`. |
| Auth and roles | `getSession`/`requireRole` in `functions/_lib/auth.js`. Roles are `barista`, `lead`, `management`. "Admin" means `management`. |
| Storage | D1 (`TEAM_DB`), new migration `0012_calendar.sql`. |
| Email | `NOTIFICATIONS` queue and `workers/notifications` (Resend). |
| Audit | Existing `audit(...)` helper. |
| Front end | New `team/calendar.html`, `team/js/calendar.js`, public `book.html`, `js/book.js`. Vanilla JS, `?v=N` cache strings in `/team` as the README requires. |
| Existing availability | `availability_rules` / `time_off_requests` are for shift scheduling. Booking availability is a separate model so work-shift preferences never leak into client-facing slots. |

## Privacy model (the hard requirement)

Two different things appear on the team calendar:

- **Team events** (shop events, closures, catering dates, meetings an owner
  chooses to share): visible to every signed-in employee with full details.
- **Client bookings**: stored with the client's name, email, phone and notes.
  The full record is returned only if `actor.id === booking.owner_id` or
  `actor.role === 'management'`. For everyone else the team calendar returns a
  redacted row: time range and "Booked" only, no title, no client, no owner
  name. This keeps the team calendar useful for seeing who is busy without
  exposing the meeting.

Enforcement lives in one server-side function, `redactBooking(actor, row)`.
Every query that returns bookings goes through it. The browser never receives
the hidden fields, so hiding in the UI is not the security boundary, matching
the rule already stated in `team/README.md`. Tests assert that a barista
calling each calendar action cannot read another user's booking fields.

## Data model (`migrations/0012_calendar.sql`)

- `meeting_locations`: `id, name, address_line1, address_line2, city, state,
  postal_code, notes (parking, which door), active, created_by, created_at`.
  The saved-address list. Lead and above can add and edit entries; entries are
  archived, never deleted, so old bookings keep their address.
- `event_types`: `id, owner_id, name, slug, description, duration_minutes,
  buffer_before, buffer_after, location_id (required, FK to
  `meeting_locations`), min_notice_minutes, max_days_ahead,
  slot_interval_minutes, questions_json, active, created_at, updated_at`.
  Unique on `(owner_id, slug)`. Meetings are in-person only, so there is no
  phone or video type.
- `booking_availability`: `id, owner_id, weekday, start_time, end_time` plus
  `booking_date_overrides` (`owner_id, date, start_time, end_time, is_blocked`)
  for one-off days off or extra hours. Times are wall-clock in the owner's
  timezone, stored on the owner row (`booking_timezone`, default
  `STORE_TIMEZONE`).
- `booking_links`: `id, event_type_id, token_hash, label, expires_at,
  max_uses, use_count, revoked_at, created_at`. Links are reusable by
  default (`max_uses` empty), so one link can go to many candidates. An
  optional expiry or use cap can be set, and a link can be revoked at any time
  without affecting bookings already made. Only a
  SHA-256 hash of the token is stored, the same approach as `calendar_tokens`.
  Tokens are 32 random bytes, base64url.
- `bookings`: `id, event_type_id, owner_id, link_id, location_id,
  location_snapshot_json (address as it was when booked), start_utc, end_utc,
  status (confirmed | cancelled | rescheduled), client_name, client_email,
  client_phone (optional), answers_json, manage_token_hash, created_at, cancelled_at,
  cancel_reason`.
- `team_events`: `id, created_by, title, description, start_utc, end_utc,
  all_day, location, visibility, created_at, updated_at`.
- Indexes: `bookings (owner_id, start_utc)`, `bookings (status, start_utc)`,
  `team_events (start_utc)`, `booking_links (token_hash)`.
- Double-booking guard: partial unique index
  `UNIQUE (owner_id, start_utc) WHERE status = 'confirmed'`, plus an overlap
  check in the same batch statement. Two clients racing for one slot cannot
  both succeed. The loser gets `slot_taken` and a refreshed slot list. This
  mirrors the conditional-write approach used for open shifts.

All times stored in UTC. Display converts using the viewer's timezone on the
client and the owner's timezone for availability rules, with DST handled by
`Intl.DateTimeFormat` rather than hand-rolled offsets.

## API

Authenticated (added to `ACTIONS` in `functions/api/team/index.js`, new file
`functions/_lib/calendar.js`):

| Action | Min role | Notes |
|---|---|---|
| `getCalendar` | barista | Range query. Returns team events plus bookings, passed through `redactBooking`. |
| `saveTeamEvent`, `deleteTeamEvent` | lead | Team-wide events. Management can edit any, leads their own. |
| `listEventTypes`, `saveEventType`, `archiveEventType` | lead | Own event types only. Management can view all. |
| `listMeetingLocations` | lead | Fills the address drop-down. |
| `saveMeetingLocation`, `archiveMeetingLocation` | lead | Add or edit saved addresses. |
| `getBookingAvailability`, `saveBookingAvailability`, `saveDateOverride` | lead | Own only. |
| `createBookingLink`, `listBookingLinks`, `revokeBookingLink` | lead | Own links only. Returns the full URL once, at creation. |
| `getMyBookings`, `getBooking` | barista | Owner or management, else `forbidden`. |
| `cancelBooking`, `rescheduleBooking` | barista | Owner or management. Emails the client. |
| `getAllBookings` | management | Admin view across owners. |

Public, no login (`functions/api/book/[token].js`, plus
`functions/api/book/[token]/slots.js`, `book.js`, `manage.js`):

- `GET  /api/book/:token`: event type name, duration, owner first name,
  the meeting address, questions. 404 for unknown, revoked, expired or exhausted tokens. The
  response is identical for "unknown" and "revoked" so tokens cannot be probed.
- `GET  /api/book/:token/slots?from=&to=&tz=`: available start times.
- `POST /api/book/:token/book`: creates the booking.
- `GET/POST /api/book/manage/:manage_token`: client views, cancels or
  reschedules their own booking from the confirmation email.

## Availability and slot generation

For a requested range, per event type:

1. Expand the owner's weekly windows and date overrides into UTC intervals.
2. Subtract: confirmed bookings (including buffers), team events marked
   "blocks my availability", approved time off from `time_off_requests`, and
   published shifts only if the owner opts in ("don't book me over my work
   shift").
3. Apply `min_notice_minutes` and `max_days_ahead`.
4. Step through the free intervals at `slot_interval_minutes` and keep slots
   that fit `duration + buffers`.

Slots are recomputed server-side again at booking time, inside the write, so a
stale page can never book an unavailable time.

## Notifications

- Invitee: confirmation email with the address, an `.ics` attachment and a
  private manage link, sent through the existing Resend setup
  (`EMAIL_FROM` in the notifications worker). Reminder 24 hours before (queue with delay, or a scheduled worker
  using the existing notifications worker).
- Owner: portal notification and email on new, cancelled and rescheduled
  bookings, reusing the notification rows the scheduling code already writes.
- Management does not get an email per booking, to avoid noise. They see it in
  the admin view.

## Abuse protection for the public endpoints

- Per-IP and per-token rate limits (the login limiter in `auth.js` is the
  model), tighter on `POST /book`.
- Honeypot field plus Cloudflare Turnstile on the booking form. Needs a
  Turnstile site key and secret in Pages variables.
- Input validation and length caps on every client field; reject past times
  and anything outside the generated slot set.
- Responses carry `Cache-Control: no-store` and `X-Robots-Tag: noindex`;
  `/book/*` is excluded from `sitemap.xml` and disallowed in `robots.txt`.
- Invitee name and email are personal data, and for interviews they are
  hiring data. See "Data collected" below for what is stored, who sees it and
  how long it is kept.

## Data collected

Collected from the invitee on the booking page:

| Field | Required | Why |
|---|---|---|
| Full name | Yes | Identify who is coming. |
| Email | Yes | Send the confirmation, reminder and cancel/reschedule link. |
| Phone | Optional | Reach them if they are running late. |
| Answers to the owner's custom questions | Optional per question | For example "Which position are you applying for?" |

Collected automatically: the chosen time, the address that applied at booking
time, the invitee's timezone, and when the booking was created or cancelled. No
IP address is stored with the booking (the rate limiter keys on a hash that
expires). No resume upload and no payment details in v1.

Who sees it: the link owner and Management only (see the privacy model above).

Retention (proposed, since you were not sure): delete or anonymise name,
email, phone and answers 12 months after the meeting date, and sooner on
request. The meeting row stays with the personal fields blanked, so history
and counts survive. A scheduled worker does the cleanup. Because these are job
candidates, keep the period short and do not store interview notes in this
feature. Before launch, add a short line to `privacy-policy.html` saying what
the booking form collects and how long it is kept. This is practical guidance,
not legal advice; if you want certainty, have someone qualified review the
policy wording.

## Front end

- `team/calendar.html`: month, week and agenda views of team events and
  bookings. Own bookings are fully detailed; others show as "Booked". Filters:
  mine, everyone, team events only. Add the page to the dashboard tiles and
  the README table.
- `team/event-types.html` (Lead+): create and edit event types, pick the
  address from a drop-down with an "Add new address" option, set weekly hours
  and date overrides, generate, copy and revoke links.
- `book.html` (public): pick date, then time, shown in the client's timezone
  with a timezone selector, then a form, then a confirmation screen. Matches
  the public site styling, mobile first, no framework.
- Add skeleton placeholders (the portal currently only shows "Loading…" text)
  for every calendar list so views do not flash empty states.

## Delivery phases

1. **Foundation**: migration, `calendar.js` with availability maths and
   `redactBooking`, unit tests. No UI.
2. **Owner setup**: event types, availability, links, and the
   `event-types.html` page.
3. **Public booking flow**: slots, booking, double-booking guard, emails with
   `.ics`, manage link, Turnstile and rate limiting.
4. **Team calendar**: `calendar.html`, team events, redacted bookings, admin
   view.
5. **Hardening**: reminders, retention job, Playwright tests on mobile,
   privacy-policy update, runbook entry in `CLOUDFLARE_SETUP.md`.

Each phase ships behind the unlinked `/team` pages, and public booking stays
off until phase 3 passes review.

## Testing

- Unit (`node --test`, using the existing `tests/helpers/d1-sqlite.js`):
  slot generation across DST changes, buffers, overrides, min notice;
  concurrent booking race (second insert fails); token revoke, expiry and
  max-use; every redaction path for barista, lead, owner and management.
- Contract: a barista cannot fetch another user's `getBooking`, cannot list
  their links, and sees only time ranges in `getCalendar`.
- Playwright: complete a booking on a phone viewport; cancel from the manage
  link.

## Decisions

Confirmed by you:

1. Lead and above can create event types, availability and links.
2. Links are reusable. First use case is sending one link to many interview
   candidates.
3. Confirmation emails go out through the existing Resend setup.
4. In-person only. An address must be chosen from a drop-down, and Lead+ can
   add addresses to it.

My choices, change if wrong:

5. "Admin" means the Management role. Leads cannot see other people's
   bookings.
6. Other people's meetings show on the team calendar as "Booked" blocks, not
   hidden entirely. Dropping those rows for non-owners is a small change if you
   prefer.
7. The calendar covers bookings plus team events. Shifts stay in
   `schedule.html`.
8. No Google or Outlook sync, payments, group events or round-robin in v1.
9. Cloudflare Turnstile guards the public form. It is free and uses the same
   Cloudflare account as the site, so whoever owns the Pages project creates
   the key (Cloudflare dashboard, Turnstile, add widget for `shibamatlanta.com`)
   and we store the secret as a Pages variable. No separate vendor account.

## Remaining open questions

1. Confirm the sender address: the code uses `EMAIL_FROM` from the
   notifications worker, but I cannot see its value from here. Check that it
   is a monitored address, since invitees may reply to interview emails.
2. Retention: is 12 months acceptable, or does your hiring policy need a
   different period?
3. Should a candidate be allowed to book more than one interview slot with the
   same email, or one active booking per email per link?

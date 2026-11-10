# Portal calendar and booking links — implementation plan

Status: proposal, nothing built yet. Review the decisions and open questions
at the bottom before work starts.

## Goal

Add a Calendly-style calendar to the team portal:

1. A team member configures event types (a "30-minute tasting", "Catering
   consult") and their weekly availability.
2. They send a unique link to a client. The client picks a slot and books
   without logging in.
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

- `event_types`: `id, owner_id, name, slug, description, duration_minutes,
  buffer_before, buffer_after, location_type (in_person | phone | video |
  custom), location_detail, min_notice_minutes, max_days_ahead,
  slot_interval_minutes, questions_json, active, created_at, updated_at`.
  Unique on `(owner_id, slug)`.
- `booking_availability`: `id, owner_id, weekday, start_time, end_time` plus
  `booking_date_overrides` (`owner_id, date, start_time, end_time, is_blocked`)
  for one-off days off or extra hours. Times are wall-clock in the owner's
  timezone, stored on the owner row (`booking_timezone`, default
  `STORE_TIMEZONE`).
- `booking_links`: `id, event_type_id, token_hash, label, expires_at,
  max_uses, use_count, revoked_at, created_at`. One event type can have many
  links, so a link can be one-time (for a specific client) or reusable. Only a
  SHA-256 hash of the token is stored, the same approach as `calendar_tokens`.
  Tokens are 32 random bytes, base64url.
- `bookings`: `id, event_type_id, owner_id, link_id, start_utc, end_utc,
  status (confirmed | cancelled | rescheduled), client_name, client_email,
  client_phone, answers_json, manage_token_hash, created_at, cancelled_at,
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
| `listEventTypes`, `saveEventType`, `archiveEventType` | barista | Own event types only. Management can view all. |
| `getBookingAvailability`, `saveBookingAvailability`, `saveDateOverride` | barista | Own only. |
| `createBookingLink`, `listBookingLinks`, `revokeBookingLink` | barista | Own links only. Returns the full URL once, at creation. |
| `getMyBookings`, `getBooking` | barista | Owner or management, else `forbidden`. |
| `cancelBooking`, `rescheduleBooking` | barista | Owner or management. Emails the client. |
| `getAllBookings` | management | Admin view across owners. |

Public, no login (`functions/api/book/[token].js`, plus
`functions/api/book/[token]/slots.js`, `book.js`, `manage.js`):

- `GET  /api/book/:token`: event type name, duration, owner first name,
  questions. 404 for unknown, revoked, expired or exhausted tokens. The
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

- Client: confirmation email with an `.ics` attachment and a private manage
  link. Reminder 24 hours before (queue with delay, or a scheduled worker
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
- Client email and phone are personal data: add a retention rule (for example
  anonymise bookings 18 months after the meeting) and mention it in
  `privacy-policy.html`.

## Front end

- `team/calendar.html`: month, week and agenda views of team events and
  bookings. Own bookings are fully detailed; others show as "Booked". Filters:
  mine, everyone, team events only. Add the page to the dashboard tiles and
  the README table.
- `team/event-types.html`: create and edit event types, set weekly hours and
  date overrides, generate, copy and revoke links.
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

## Decisions I made (change if wrong)

1. **"Admin" = Management role.** Leads do not get access to others' bookings.
2. **Team calendar shows other people's client meetings as "Booked" blocks**,
   not hidden entirely, so the team can see who is busy. If you want them
   fully invisible instead, drop those rows from `getCalendar` for non-owners.
3. **Calendar scope is bookings plus team events**, not a replacement for the
   shift schedule. Shifts stay in `schedule.html`.
4. **No Google or Outlook two-way sync in v1.** It adds OAuth, token storage
   and conflict handling. The `.ics` attachment covers clients, and the existing
   per-user calendar feed can be extended to include bookings in a later phase.
5. **No payments, no group events, no round-robin** in v1.

## Open questions

1. Who can create event types: all employees, or Lead and above?
2. Should booking links be one-per-client (single use) by default, or
   reusable with an optional limit?
3. Do clients get an email address to reply to? Needs a sending identity on the
   Resend domain.
4. Is a phone or video meeting link needed (Zoom, Meet), or is in-person and
   phone enough for v1?
5. Retention period for client data, and whether the privacy policy needs
   review by someone before launch.
6. Which Turnstile account should own the keys?

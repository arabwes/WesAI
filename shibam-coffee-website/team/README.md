# Shibam Coffee team portal

The internal employee portal lives at `https://shibamatlanta.com/team/`.
It ships with the marketing website but remains unlisted, excluded from the
sitemap, and marked `noindex, nofollow`.

The portal now uses Cloudflare Pages Functions and D1. See
[`../CLOUDFLARE_SETUP.md`](../CLOUDFLARE_SETUP.md) before running or deploying it.

## Pages

| Page | Access | Purpose |
|---|---|---|
| `index.html` | Everyone | Login |
| `dashboard.html` | Barista+ | Portal landing page |
| `schedule.html` | Barista+ | Published schedule, confirmations, availability, time off, open shifts |
| `manage-schedule.html` | Lead+ | Weekly schedule builder and request review |
| `profile.html` | Barista+ | Profile, password, phone verification, notifications, push devices, calendar links |
| `accept-invitation.html` | Invited employees | One-time account activation |
| `inventory.html` | Barista+ | Weekly kitchen and storage count |
| `dessert-inventory.html` | Barista+ | Daily dessert count and vendor order |
| `local-order.html` | Barista+ | Consolidated local market request |
| `admin.html` | Management | Submission history, catalog, and users |

## Roles

| Role | Capabilities |
|---|---|
| Barista | View and confirm published shifts, manage availability, request time off/open shifts, submit portal forms |
| Lead | Barista capabilities plus create and edit draft schedules and catalog items |
| Management | Publish or change published schedules, override conflicts, approve requests, manage users/catalog/history |

Every privileged action is checked by the Cloudflare API. Hiding a control in
the browser is only a convenience and is never the security boundary.

## Scheduling behavior

### Draft and publish

- Each location has one schedule per Monday–Sunday week.
- New weeks begin as drafts and are not visible to Baristas.
- Leads can build drafts; only Management can publish.
- Changes to a published schedule create employee notifications.
- Shifts are cancelled rather than deleted, preserving the audit trail.

### Scheduling concerns

The API checks overlapping shifts, approved time off, unavailable periods,
position qualifications, and maximum weekly hours. Leads cannot override a
concern. Management can save after recording an override reason.

### Open shifts

An unassigned published shift is an open shift. Qualified employees can request
it, but Management must approve. Assignment uses a conditional database write,
so the same shift cannot be awarded twice.

### Trades and drops

Employees can offer an assigned shift to qualified coworkers, request a direct
swap, or ask Management to drop it. Direct swaps require the invited employee's
acceptance and every exchange requires Management approval. The server rechecks
overlaps, availability, time off, qualifications, and weekly-hour limits before
changing assignments.

### Templates, rotations, coverage, and history

Leads can save a week as a reusable template and create multi-week rotations.
The manager view includes a coverage heatmap based on availability and assigned
shifts. Published schedules have immutable version snapshots; Management can
inspect and restore an earlier version without deleting later audit history.

### Availability and time off

Employees can enter recurring preferred or unavailable periods. Time-off
requests remain pending until Management approves or declines them. Approving
time off does not silently remove a scheduled shift; the manager must resolve
the conflict explicitly.

Employees can maintain date-bounded availability sets, add weekly repeating
exceptions, cancel pending time-off or open-shift requests, and distinguish
preferred time from unavailable time.

### Notifications and calendars

In-portal, email, Web Push, and SMS deliveries share per-user preferences and
idempotent delivery records. A Cloudflare Queue handles provider calls and
retries. Calendar subscription tokens are stored only as hashes and expose a
private read-only iCalendar feed with stable event IDs and cancellation updates.
The portal is installable as a basic PWA and its service worker displays push
messages without caching authenticated application data.

## Existing operational forms

- Every quantity remains required. `0` is valid; blank is not.
- Submission identity comes from the authenticated server session.
- The local order submit button remains gated by the full-list review checkbox.
- Catalog items are archived with `discontinued` status rather than deleted.
- The dessert vendor standing order remains in `js/data.js` because its Mon/Fri
  shape does not fit the shared catalog.

## Authentication

The API sets a random session token in an `HttpOnly`, `Secure`, `SameSite=Strict`
cookie. Browser JavaScript stores only a display profile for fast navigation.
Sessions expire after 12 hours by default and can be revoked immediately.

New passwords use PBKDF2-SHA-256 with a random salt. Passwords imported from the
legacy Apps Script portal are upgraded after their first successful login.
Turnstile and login throttling protect the login endpoint when configured.

There is no hard-coded production password. The one-time bootstrap endpoint only
works while the user table is empty and requires a Cloudflare secret.

## D1 data model

| Table | Purpose |
|---|---|
| `users`, `sessions` | Identity, roles, weekly-hour limits, authenticated sessions |
| `positions`, `employee_positions` | Shift qualifications |
| `schedules`, `shifts` | Draft/published weekly schedules and assignments |
| `availability_rule_sets`, `availability_rules`, `availability_exceptions`, `availability_exception_series` | Date-bounded and repeating employee scheduling preferences |
| `time_off_requests`, `shift_requests`, `shift_exchange_requests`, `shift_exchange_candidates` | Time-off, open-shift, drop, trade, and swap workflows |
| `shift_confirmations` | Employee acknowledgement |
| `schedule_templates`, `template_shifts`, `schedule_rotations`, `schedule_rotation_weeks` | Reusable weeks and rotations |
| `schedule_versions` | Immutable published schedule snapshots and restoration history |
| `notifications`, `notification_deliveries`, `user_notification_preferences` | Multi-channel notification outbox and preferences |
| `push_subscriptions`, `phone_verifications`, `sms_opt_outs` | Push and verified SMS delivery state |
| `calendar_tokens` | Hashed private iCalendar subscription credentials |
| `user_invitations` | Hashed, expiring employee invitations |
| `audit_events` | Immutable action history |
| `catalog`, `form_entries` | Existing operational forms and admin history |
| `portal_documents` | Management-controlled handbook and reference links |
| `app_settings` | Scheduling policy configuration |

All relationships use stable IDs. User, shift, and catalog history remains
available after an account or item becomes inactive.

## Code map

```text
team/
  schedule.html / js/schedule.js             employee experience
  manage-schedule.html / js/manage-schedule.js  manager experience
  js/workforce.js                            exchanges, templates, coverage, history
  profile.html / js/profile.js               account, notifications, calendar
  accept-invitation.html                     invitation activation
  sw.js / app.webmanifest                    push display and install metadata
  js/auth.js                                 cookie-session client and role UI
functions/
  api/team/index.js                          API router
  api/team/calendar/[token].js               private iCalendar feed
  api/team/sms.js                            verified Twilio STOP/START webhook
  _lib/auth.js                               login, sessions, roles, audit
  _lib/legacy.js                             catalog/forms/admin compatibility
  _lib/scheduling.js                         scheduling domain and workflows
  _lib/scheduling-extended.js                expanded scheduling and account workflows
  _lib/schedule-snapshots.js                 immutable schedule versions
migrations/                                  versioned D1 schema
workers/notifications/                       Queue email consumer and cleanup job
scripts/build-legacy-import.mjs              CSV-to-D1 migration helper
```

## Local development

The Cloudflare runtime is required:

```bash
npm install
npm run db:migrate:local
npm run dev
```

Open `http://127.0.0.1:8788/team/`. See `CLOUDFLARE_SETUP.md` for initial
Management bootstrap, preview/production databases, queues, secrets, and legacy
data import. Its final blocker table lists the provider accounts and API keys
that can be added after the application code is deployed.

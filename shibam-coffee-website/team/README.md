# Shibam Coffee team portal

The internal employee portal lives at `https://www.shibamatlanta.com/team/`.
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

### Availability and time off

Employees can enter recurring preferred or unavailable periods. Time-off
requests remain pending until Management approves or declines them. Approving
time off does not silently remove a scheduled shift; the manager must resolve
the conflict explicitly.

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
| `availability_rules`, `availability_exceptions` | Employee scheduling preferences |
| `time_off_requests`, `shift_requests` | Approval workflows |
| `shift_confirmations` | Employee acknowledgement |
| `notifications` | In-app updates and email delivery outbox |
| `audit_events` | Immutable action history |
| `catalog`, `form_entries` | Existing operational forms and admin history |
| `app_settings` | Scheduling policy configuration |

All relationships use stable IDs. User, shift, and catalog history remains
available after an account or item becomes inactive.

## Code map

```text
team/
  schedule.html / js/schedule.js             employee experience
  manage-schedule.html / js/manage-schedule.js  manager experience
  js/auth.js                                 cookie-session client and role UI
functions/
  api/team/index.js                          API router
  _lib/auth.js                               login, sessions, roles, audit
  _lib/legacy.js                             catalog/forms/admin compatibility
  _lib/scheduling.js                         scheduling domain and workflows
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
data import.

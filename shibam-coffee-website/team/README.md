# Team Portal — Shibam Coffee Atlanta

Internal forms and admin tools for inventory counts, local order requests,
and team account management. Lives at `https://www.shibamatlanta.com/team/`
and ships with the main site — same Cloudflare Pages deployment, no separate
project.

## What's here

| Page | Who | Purpose |
|---|---|---|
| `index.html` | Everyone | Login. The portal's root — this is what `/team/` shows. |
| `dashboard.html` | Everyone (logged in) | Landing page — links to the three forms, plus an Admin card for Management. |
| `inventory.html` | Barista+ | Weekly kitchen + storage count — desserts aren't on this list, see below. |
| `dessert-inventory.html` | Barista+ | Daily dessert count/delivery log, plus a vendor-order tab. |
| `local-order.html` | Barista+ | Consolidated local market order request. |
| `documents.html` | Barista+ | Employee handbook and other guidelines, embedded live from Google Drive. |
| `admin.html` | Management only | Submissions, Catalog (search/sort/multiselect/edit), Users, Changelog. |

Weekly Inventory intentionally does **not** include desserts (Honeycomb,
Dubai Chocolate, the milk cakes/cheesecakes, etc.) — those are tracked once,
daily, on the Dessert Inventory form. Counting them on both forms was
redundant, so they were removed from Weekly Inventory's catalog list; see
"Backend setup" below if you're bringing up a **new** deployment (they're
excluded from the seed data automatically) versus cleaning up an **existing**
one that already seeded them before this change (a one-time manual step).

## Roles

| Role | Can do |
|---|---|
| **Barista** | Log in, submit the three forms. |
| **Lead** | + flag a catalog item for discontinuation, add new items to any of the three lists. |
| **Management** | + discontinue (archive) or restore items outright (individually or in bulk), edit an existing item's name/unit/group, view and edit any past submission, add/remove user accounts, reset a user's password, read the Changelog. |

Usernames are matched case-insensitively everywhere (login, adding a user,
removing a user) — `Admin`, `admin`, and `ADMIN` are the same account.
Whatever case was typed when the account was created is what's stored and
shown; only the *comparison* ignores case.

Enforcement happens **on the backend**, not just in the page — the Apps
Script checks the caller's role on every privileged action, so hiding a
button in the UI is a convenience, not the actual security boundary.

## Filling out a form — sorting and autosave

Every count table (Weekly Inventory, Dessert Inventory's daily count and
vendor order, Local Order List) has a clickable Item column — click to sort
alphabetically, click again to reverse. Sorting reorders the rows in place
without touching whatever you've already typed into other rows, so it's
safe to use mid-count.

**In-progress entries save themselves.** Anything typed into a form is
autosaved to that browser roughly half a second after you stop typing —
if you get pulled away mid-count, coming back to the same form on the same
device restores it, with a small banner confirming what was restored and a
"Discard draft" option if you'd rather start over. A draft is submitted
away automatically the moment the form is actually submitted, and it's
scoped to your own login — if a shop tablet is shared between people,
nobody sees anyone else's in-progress draft. Drafts live only in that
browser (`localStorage`), so they don't survive switching devices.

## Admin dashboard features

- **Search + sort** on Submissions, Catalog, Users, and Changelog — click a
  column header to sort by it (click again to reverse), or type in the
  search box to filter. Both run against the already-fetched rows, so
  they're instant and don't hit the backend again.
- **Multiselect on the Catalog tab** — check a row's box (or the header
  checkbox to select every currently-visible row), then use the bulk
  Discontinue/Restore buttons that appear. One backend call handles the
  whole batch.
- **Edit an item's name/unit/group** — "Edit" on a Catalog row unlocks those
  three fields, "Save" commits. Renaming into a name that already exists in
  that list (case-insensitive) is rejected rather than silently creating a
  duplicate.
- **Changelog tab** (Management only) — every add/edit/discontinue/restore
  and every user-management action, newest first, with who did it and when.
  Logins aren't included — this tracks data changes, not activity.
- **Submissions tab shows readable details, and groups multi-row
  submissions.** The Details column renders labelled text (e.g. "Unit: lb
  · Order below: 5 · Have: 2 · Order? Yes") instead of raw JSON — "Edit"
  still switches it to the real JSON to actually change it. A single form
  submit can produce more than one row (Local Order List's free-text
  "unlisted item" rows are separate from its catalog-item rows) — a
  `#N` badge in the Submission column ties rows from the same submit
  together no matter how the table is currently sorted or searched. Rows
  written before this feature shipped fall back to grouping by matching
  timestamp/employee/date instead of the badge. A never-edited entry now
  reads "Not edited yet" instead of a bare dash, and Last Edited shows a
  display name (matching the Employee column's format) rather than a login
  handle.
- **Reset password** — on the Users tab, next to Remove, for any active
  account. Prompts for a new temporary password and applies it immediately;
  share it with that person directly, there's no email/notification step.
- **Export CSV** — on Submissions, Catalog, and Changelog, exports whatever
  rows are currently visible (i.e. respects your search filter).
- Destructive actions (bulk discontinue/restore, remove user) confirm
  through an in-page dialog rather than the browser's native `confirm()`
  popup.

## Bootstrap login

**Username:** `Admin`
**Password:** `Shibam313!`

This account is seeded automatically the first time the backend's `setup`
function runs (see below). **Change this password immediately after first
login** — it's written in plaintext in this file, in `apps-script/Code.gs`,
and in chat history. Log in as `Admin`, go to Admin → Users, add your real
Management account, then either change the `Admin` password by re-running
`setup` with a different value or just remove the `Admin` account once you
have another active Management user (the backend refuses to remove the
*last* active Management account, so you always keep at least one).

## If the portal freezes or won't load

Two recovery paths, in order of what to try first.

**1. Add `?reset` to the URL:** `https://www.shibamatlanta.com/team/?reset`
This clears the saved login on that device and stops without redirecting
anywhere, so it works even when a bad session would otherwise bounce the
page. Then log in again normally.

**2. Clear the site's data from browser settings.** Needed if the page is
already looping so fast you can't type a URL into that tab, or if the
browser cached a broken copy of the portal's JavaScript. Do this from
browser settings, **not** from the frozen tab:

- **Chrome / Edge:** Settings → Privacy and security → Third-party cookies
  → See all site data and permissions → search `shibamatlanta.com` → Delete
- **Firefox:** Settings → Privacy & Security → Cookies and Site Data →
  Manage Data → search `shibamatlanta.com` → Remove Selected
- **Safari:** Settings → Privacy → Manage Website Data → search
  `shibamatlanta` → Remove

This removes both the saved session and any cached scripts, so the next
load starts completely fresh.

## How Cloudflare Pages serves this (matters more than it sounds)

Two Pages behaviors have already caused real outages here. Both are
invisible to a plain local static server, which is why `dev-server.js`
exists — see "Local development" below.

**`.html` is stripped with a 308 redirect.** `/team/dashboard.html`
permanently redirects to `/team/dashboard`. Always link to the
extensionless form. Linking to `.html` costs an extra redirect on every
navigation, and — because `window.location.pathname` then never equals the
`.html` string the code redirected to — it can defeat loop-detection logic
that compares the two.

**Portal JS and CSS are versioned in the URL — bump `?v=N` whenever you
change them.** Every reference looks like
`<script src="/team/js/auth.js?v=2">`. When you edit any file under
`team/js/` or `team/css/`, increment that number in **all** of the team
HTML files (they must agree) in the same commit.

This is not optional housekeeping — it is the only thing that actually
gets people onto new portal code:

- The repo-root `_headers` file sets `no-cache, must-revalidate` for
  `/team/*`. That **works for the HTML pages** — browsers always re-check
  them, so a deploy is picked up on the next load.
- It does **not** work for `.js` / `.css`. Pages overrides `Cache-Control`
  on static assets with its own `max-age=14400` (4 hours) no matter what
  `_headers` says. Verified against the live site.

So the HTML is always fresh, and a changed `?v=` makes it point at a URL
the browser has never cached, which forces a real fetch. Without that,
a broken script can stay stuck in people's browsers for hours after the
fix ships — which is exactly what happened here once already, and left
users unable to load the portal at all.

## Why it's structured this way

- **No blank counts.** Every quantity is required — 0 is a valid answer,
  blank isn't, because blank can't be told apart from "nobody checked this
  shelf."
- **Identity comes from login, not a text field.** Every submission's
  `employeeName` is filled in server-side from the session, not typed —
  nobody can submit under a coworker's name.
- **The local order form gates its own submit button** behind an "I went
  through every item" checkbox. That form's whole point is consolidating
  into one market run, which only works if someone actually reads the full
  list — so it's never filtered down, and threshold highlighting is a
  scanning aid on top of it, not a shortcut.
- **Discontinuing an item archives it, it doesn't delete it.** A Catalog row
  set to `discontinued` disappears from the active forms but stays in the
  sheet, so historical submissions that reference it by name are never
  orphaned.

## Access

Still unlisted (no nav link, no `sitemap.xml` entry, `noindex, nofollow` on
every page, no `robots.txt` mention). Now there's a real login on top of
that obscurity — a visitor who finds the URL still can't do anything without
a valid account.

## Editing the item lists

Three of the four lists (Inventory, Dessert daily count, Local Order List)
are no longer static files — they live in the `Catalog` tab of the tracking
spreadsheet and are fetched live. Add/remove/discontinue through the portal
itself (Lead can add, Management can discontinue/restore), not by editing a
file in this repo.

The one exception is the **dessert vendor order** (Tab B of Dessert
Inventory) — its Mon/Fri standing-quantity shape doesn't fit the shared
Catalog schema, so it's still a static list in `js/data.js`
(`DESSERT_VENDOR_ORDERS`). Edit that file directly if the standing order
changes.

## Documents portal setup (one-time per document)

`documents.html` lists company documents (currently an Employee Handbook
and an "Other Guidelines" category) and embeds each one live from Google
Drive — there's no copy or sync, the page always shows the current file.

**1. In Google Drive, set each document's sharing to "Anyone with the link
can view."** The embed can't render a file it doesn't have access to, and
this page has no login of its own beyond the portal's — it relies on the
Drive link itself being viewable.

**2. Get that file's ID** from its share link
(`https://drive.google.com/file/d/`**`THIS_PART`**`/view`).

**3. Add it to `js/documents.js`** — each document is one entry in the
`DOCUMENTS` array at the top of the file:
```js
{ title: 'Employee Handbook', description: '…', category: 'Handbook', driveFileId: 'THIS_PART' }
```
Leaving `driveFileId` empty shows a "Link coming soon" placeholder instead
of a broken embed — that's what ships until real IDs are added. `category`
groups related documents on the page; adding a new category (e.g. a future
"Recipe Book") is the same one-line addition, no other code changes.

## Backend setup (one-time)

Until this is done, forms are fully functional but nothing is saved and
login always fails.

**1. Create the tracking spreadsheet.** A new Google Sheet in the shop's
Drive. The script creates its own tabs, so it can start empty.

**2. Open Extensions → Apps Script** and replace the contents with the full
contents of [`apps-script/Code.gs`](./apps-script/Code.gs) in this
directory — copy the whole file, paste it in, overwriting the default
`myFunction() {}` stub.

**3. Run the one-time setup.** In the function dropdown next to the Debug
button (▶), select **`setup`**, then click **Run**. The first run will ask
you to authorize the script (it needs to read/write the spreadsheet) — click
through Google's "unverified app" warning (Advanced → Go to \[project
name\] (unsafe)) since this is your own script, not a third party's. This
seeds the `Admin` bootstrap account and all ~190 catalog items in one shot.
Safe to run again later — it no-ops if either already has data.

**4. Deploy → New deployment → Web app.** Execute as **Me**, access
**Anyone**. Copy the `/exec` URL it gives you.

Access must be "Anyone" because the browser posts directly to it without a
Google login of its own — the portal's *own* login (Users tab, this file's
bootstrap credentials) is the real gate. Treat the URL as semi-public: it's
unguessable, but anyone who has it can attempt a login against it.

**5. Paste that URL into `js/config.js`** as `CONFIG.API_URL`. Every action —
login, form submissions, catalog changes, admin actions — goes through this
one endpoint, routed internally by an `action` field in each request.

**When you change the backend code later:** paste the updated file into the
same Apps Script project, then **Deploy → Manage deployments → click the
pencil (Edit) on the existing deployment → Deploy**. This keeps the same
`/exec` URL — you will *not* need to update `config.js` again unless you
create a brand new deployment instead of editing the existing one.

**If your Catalog sheet was already seeded before the dessert-item cleanup
above:** the seed data only affects a fresh, empty sheet — `setup()` no-ops
if `Catalog` already has rows, so removing those items from the seed array
doesn't touch data that's already there. Clean it up once, manually: log in
as Management, open Catalog → Weekly Inventory Count, search "Kitchen —
Pastries" to find them, select them all with the header checkbox, and bulk
Discontinue. That's it — a fresh `setup()` run was never needed for this.

### Why POST-only, `text/plain`, and a token-in-body instead of a header

Apps Script Web Apps don't implement the CORS preflight (`OPTIONS`) request
that a custom `Authorization` header or `Content-Type: application/json`
would trigger from a browser — the preflight would just fail. Posting as
`Content-Type: text/plain` sidesteps the preflight entirely (it's a
"simple request" per the CORS spec), and the body is still valid JSON that
`JSON.parse` on the Apps Script side handles fine. For the same reason, the
session token rides inside the JSON body (`token`) rather than an
`Authorization` header.

## Data model (the tracking spreadsheet's tabs)

The script creates all of these automatically — nothing to set up by hand
beyond running `setup` once.

| Tab | Columns | Notes |
|---|---|---|
| `Users` | username, name, role, passwordHash, passwordSalt, active, createdAt | `role` is `barista`/`lead`/`management`. Removing a user sets `active=false` (soft-delete — preserves their submission history). |
| `Sessions` | token, username, role, name, createdAt, expiresAt | One row per active login, 12-hour expiry. |
| `Catalog` | catalogId, formType, group, name, unit, threshold, location, target, status, addedBy, addedAt | `formType` is `inventory` / `dessert` / `local-order`. `status` is `active` / `flagged` / `discontinued`. |
| `Inventory Log`, `Dessert Daily Log`, `Dessert Order Log`, `Local Order Log` | submittedAt, employeeName, date, product, details, entryId, lastEditedBy, lastEditedAt, submissionId | One row per line item per submission. `details` is that item's full JSON. `entryId` is what Management's edit action targets. `submissionId` is shared by every row from the same submit (distinct from each row's own `entryId`) — added automatically to existing sheets the next time the backend redeploys, via `getSheet()`'s header auto-migration; rows written before that carry a blank `submissionId`. |
| `Changelog` | timestamp, username, role, action, target, details | One row per mutating admin action (add/edit/discontinue/restore an item, edit an entry, add/remove a user, reset a password). Logins/logouts aren't included — `Sessions` already covers those, and they aren't data changes. Read-only from the portal (Changelog tab, Management only). |

## Password & session security — read this before trusting it with more

`Utilities.computeDigest(SHA_256, password + salt)` with a random per-user
salt — this is **adequate for gating an internal ops tool**, not bcrypt/
scrypt-grade (no adjustable work factor, no rate-limiting on login
attempts). Tell staff plainly: don't reuse these passwords anywhere else.
Session tokens are random UUIDs with a 12-hour expiry, checked against the
`Sessions` sheet on every privileged request — there's no server-side
revocation beyond that expiry window (logging out deletes the row, but a
stolen token is valid until it naturally expires).

If this ever needs to be stronger, layering Cloudflare Access (free tier,
email-based login) in front of `/team/*` adds a second, better-audited gate
with zero code changes here.

## Local development

No build step. Serve the site root (not this directory — the pages use
absolute `/team/...` paths):

```bash
cd shibam-coffee-website
node dev-server.js          # defaults to port 8000
```

Then open `http://localhost:8000/team/`.

**Use `dev-server.js`, not `python3 -m http.server`.** A plain static
server doesn't strip `.html` and doesn't apply `_headers`, so it serves a
meaningfully different site than production does. That gap is not
hypothetical: a redirect loop that froze real browsers passed every local
test precisely because the local server resolved `/team/dashboard.html`
directly while Cloudflare 308-redirects it. `dev-server.js` reproduces both
behaviors so this class of bug fails locally instead of in production.

## Mobile layout

Every `.count-table` collapses into stacked, labeled rows below ~640px
instead of relying on horizontal scroll — the CSS is in `css/styles.css`
under "Mobile card-collapse". Each table cell needs a `data-label`
attribute matching its column header for this to work; every row-building
function in `js/admin.js` and `js/forms.js` sets these automatically by
zipping the row's cells against that table's `headers` array, so a new
column added to either file gets mobile support for free as long as it's
added to both the `headRow` loop and the row-building loop in the same
function.

A Playwright suite checks this holds — `npm install && npx playwright test`
from `shibam-coffee-website/`. It starts `dev-server.js` itself, mocks the
backend (no live Apps Script or Sheets access needed), loads every `/team/`
page at an iPhone-SE-width viewport, and fails if either the whole page or
any individual table needs horizontal scrolling.

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
| `inventory.html` | Barista+ | Weekly kitchen + storage count. |
| `dessert-inventory.html` | Barista+ | Daily dessert count/delivery log, plus a vendor-order tab. |
| `local-order.html` | Barista+ | Consolidated local market order request. |
| `admin.html` | Management only | View & edit past submissions, manage the item catalog, manage user accounts. |

## Roles

| Role | Can do |
|---|---|
| **Barista** | Log in, submit the three forms. |
| **Lead** | + flag a catalog item for discontinuation, add new items to any of the three lists. |
| **Management** | + discontinue (archive) or restore items outright, view and edit any past submission, add or remove user accounts. |

Enforcement happens **on the backend**, not just in the page — the Apps
Script checks the caller's role on every privileged action, so hiding a
button in the UI is a convenience, not the actual security boundary.

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
| `Inventory Log`, `Dessert Daily Log`, `Dessert Order Log`, `Local Order Log` | submittedAt, employeeName, date, product, details, entryId, lastEditedBy, lastEditedAt | One row per line item per submission. `details` is that item's full JSON. `entryId` is what Management's edit action targets. |

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

# Calendar and booking links: going live

This is the checklist to turn the feature on. It assumes the code is already on
the `main` branch. Commands are for PowerShell, run from the
`shibam-coffee-website` folder, the same as `CLOUDFLARE_SETUP.md`.

**Why the order matters.** Cloudflare Pages deploys your site from `main`
automatically. The new pages need four new database tables/columns (migrations
0012 to 0015) that do not exist in production until you apply them. Until you do,
the existing site and portal keep working, but Booking Links, Team Calendar and
`/book/...` will show errors. Do Step 1 first, right after the code is pushed.

## Step 1: Apply the database migrations (required)

1. Open PowerShell and go to the website folder:
   `cd path\to\WesAI\shibam-coffee-website`
2. Install dependencies: `npm install`
3. Make sure you are signed in to the right Cloudflare account:
   `npx wrangler whoami` (if not signed in: `npx wrangler login`).
4. Apply the migrations to production: `npm run db:migrate:production`
   Wrangler lists the pending migrations (`0012_calendar.sql` through
   `0015_booking_reminders.sql`). Answer `y` to apply them.
5. Check: `npx wrangler d1 migrations list shibam-team --remote` should say there
   are no migrations to apply.

These migrations only add things. They never change or delete existing data, so
they are safe to apply to the live database.

## Step 2: Redeploy the notification Worker (required)

The Worker sends the booking emails and reminders and runs the 12-month cleanup.
It must be redeployed to get the new code, and only after Step 1.

1. `npm run notifications:deploy`
2. Check the secrets: `npx wrangler secret list --config workers/notifications/wrangler.jsonc`
   The list must include `RESEND_API_KEY`. If it is missing, add it with
   `npm run notifications:set-secret` (paste the key that starts with `re_`).
3. The sender is `Shibam Coffee Team <schedule@shibamatlanta.com>`. Make sure
   `schedule@shibamatlanta.com` is an inbox someone reads: candidates may reply to
   it. (Replies to booking emails actually go to the person who owns the link;
   only emails that cannot be replied to elsewhere land in this inbox.)

## Step 3: Confirm the website deployed

1. Cloudflare dashboard, then **Workers & Pages**, then **yemenicoffeeco**,
   then **Deployments**.
2. The newest deployment (from `main`) should say **Success**.
3. If the build failed with a Node version message, open **Settings, then
   Variables and Secrets** for the project and add `NODE_VERSION` = `22`, then
   retry the deployment.

## Step 4: Check the booking link address works (required)

Booking links look like `https://shibamatlanta.com/book/<long random text>`. The
site serves them with a redirect rule that I could only test on a local copy, not
on Cloudflare, so check it once for real:

1. Sign in to the portal as a Lead or Management and open **Booking Links**.
2. Follow Step 5 below to make a link, copy it, and open it in a **private /
   incognito window**.
3. You should see the booking page (the meeting name, the address and a list of
   days). The address bar should still show `/book/...`.
4. If you see a "404 not found" page instead, stop and tell me. Do not send
   links to anyone yet.

## Step 5: Set up the first meeting (about 5 minutes)

Sign in as a Lead or Management and open **Booking Links** from the dashboard.

1. **Meeting addresses**: click **Add an address**, enter the shop address (name,
   street, city, state, ZIP, and a note such as which door to use). Save.
2. **My booking hours**: pick your time zone, click **Add hours** next to each
   day you are available, set the times, and click **Save hours**.
3. **Meeting types and links**: click **New meeting type**. Name it (for example
   "Barista interview"), pick the address, length, and add any questions (for
   example "Which position are you applying for?"). Save.
4. On the meeting card click **Create link**, add a label (for example "Spring
   hiring"), and click **Create link**. **Copy the link right away.** It is shown
   once. You can make another link at any time.
5. The same link can be sent to many candidates. Each person can hold only one
   upcoming booking at a time.

## Step 6: Try it as a candidate (required)

1. Open the link in a private window and book a time using **your own personal
   email address**.
2. Within a minute you should get a confirmation email with a calendar invite
   attached and a "Reschedule or cancel" link. Replying to it should go to the
   person who owns the link.
3. Click the link in the email and try **Reschedule**, then **Cancel booking**.
4. As the link owner, check the portal bell/notifications: you should see
   "New booking" messages. They intentionally do not contain the candidate's
   name.
5. Open **Team Calendar**. As the link owner and as Management you can see the
   candidate's name and details (click **Details**). Sign in as a regular
   barista or another lead: the same meeting shows only as **Booked**.

If no email arrives, see "If something does not work" below.

## Step 7: Optional but recommended: turn on the spam check (Turnstile)

Booking pages are public, so a spam check helps. The booking form already blocks
most automated spam with a hidden trap field and a limit on requests from one
visitor. Turnstile (Cloudflare's free check) adds a stronger layer.

1. Cloudflare dashboard, then **Turnstile**, then **Add widget**. Add
   `shibamatlanta.com` as the hostname. Copy the **Site key** and **Secret key**.
2. Put the **site key** (not the secret) in **both** files, between the quotes
   after `TURNSTILE_SITEKEY`:
   - `js/config.js` (the booking page)
   - `team/js/config.js` (the portal login)
3. Add the **secret key** to the Pages project:
   `npx wrangler pages secret put TURNSTILE_SECRET --project-name yemenicoffeeco`
4. Commit and push the two config files so they deploy, then repeat Step 6.

**Do not do step 3 unless step 2 is finished and deployed.** With the secret set
but no site key, every booking (and portal login) is rejected.

## Step 8: Before you tell people about it

1. **Privacy policy.** I added a "Booking a Meeting" section to
   `privacy-policy.html`. It describes what the booking form collects and says
   details are deleted 12 months after the meeting. I am not a lawyer: have
   someone you trust read it, especially because candidates' details are hiring
   information.
2. **Tell your Leads** how it works: they create links; only they and Management
   see who booked; Management can erase a person's details on request from the
   Team Calendar (**Erase personal data**).
3. **Reminder emails** go out automatically about 24 hours before a meeting
   (not for meetings booked less than a day ahead). After the first scheduled
   run you can confirm in the Worker logs (Cloudflare dashboard, **Workers &
   Pages**, **shibam-team-notifications**, **Logs**) by searching for
   `booking_reminders_complete`.

## If something does not work

| What you see | What to do |
|---|---|
| Booking Links or Team Calendar shows "Could not load" | Step 1 was skipped. Run `npm run db:migrate:production`. |
| Opening a link shows "404 not found" | Tell me (Step 4). Do not send links yet. |
| Opening a link shows "This booking link is not available" | The link was revoked, expired, hit its limit, or its meeting type or address was archived. Make a new link. |
| No confirmation email arrives | Check spam. Confirm `RESEND_API_KEY` is set on the Worker (Step 2) and the Worker was redeployed. The booking itself still works without email. |
| "Please complete the security check" on the booking form | You set `TURNSTILE_SECRET` without the site key in `js/config.js` (Step 7). Add the key and deploy, or remove the secret. |
| "Too many attempts" | A visitor made many requests quickly. Wait about an hour. |

## Undoing it

Hide the feature by removing the **Booking Links** and **Team Calendar** tiles
from `team/dashboard.html` and revoking links in the portal. The database changes
are additive and can safely stay. To disable public booking immediately,
revoke every link (Booking Links, then **Revoke**).

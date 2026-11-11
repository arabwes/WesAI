# Calendar and booking links: going live

This is the checklist to turn the feature on. It assumes the code is already on
the `main` branch. Commands are for PowerShell, run from the
`shibam-coffee-website` folder, the same as `CLOUDFLARE_SETUP.md`.

**Why the order matters.** Cloudflare Pages deploys your site from `main`
automatically. The new pages need four new database tables/columns (migrations
0012 to 0015) that do not exist in production until you apply them. Until you do,
the existing site and portal keep working, but Booking Links, Team Calendar and
`/book/...` will show errors. Do Step 1 first, right after the code is pushed.

## Fastest route: run Steps 1 to 3 from the GitHub website (no terminal)

The repository has a workflow, **Deploy to Cloudflare**, that does Steps 1, 2 and
part of 3 for you and then tests the live site. If you use it, skip the
command-line Steps 1 to 3 below and carry on from Step 4. You set it up once (A to
C), then click Run (D and E). After that it also runs by itself (see "After the
one-time setup" below).

### A. Create a Cloudflare API token (about 3 minutes)

1. Sign in at dash.cloudflare.com.
2. Click your profile icon (top right), then **My Profile**, then **API Tokens**.
3. Click **Create Token**, then next to **Create Custom Token** click **Get started**.
4. Name it `GitHub deploy`.
5. Under **Permissions** add these four rows (use the three dropdowns on each row).
   Use a single policy with **Effect: Allow**, and leave **Client IP Address
   Filtering** blank:
   - **Account** / **D1** / **Edit**
   - **Account** / **Workers Scripts** / **Edit**
   - **Account** / **Queues** / **Edit**
   - **Account** / **Account Settings** / **Read**
6. Under **Account Resources** choose **Include**, then your Shibam account.
7. Click **Continue to summary**, then **Create Token**.
8. **Copy the token now.** Cloudflare shows it only once. Keep the tab open.

### B. Copy your Cloudflare Account ID

1. In the Cloudflare dashboard click **Workers & Pages**.
2. On the right-hand side find **Account ID** and click to copy it.

### C. Save both in GitHub (once)

1. Go to github.com/arabwes/WesAI, then **Settings**, then **Secrets and
   variables**, then **Actions**.
2. Click **New repository secret**. Name: `CLOUDFLARE_API_TOKEN`. Secret: paste
   the token from A. Click **Add secret**.
3. Click **New repository secret** again. Name: `CLOUDFLARE_ACCOUNT_ID`. Secret:
   paste the ID from B. Click **Add secret**.

Type the two names exactly as shown, in capitals. GitHub never shows the values
again, and the workflow only uses them to talk to Cloudflare.

### D. Do a safe look first (changes nothing)

1. In the repository click the **Actions** tab.
2. In the left list click **Deploy to Cloudflare**.
3. Click **Run workflow** (right side), leave **Branch: main** and **mode:
   check**, and click the green **Run workflow** button.
4. After a few seconds a new run appears. Click it, then click the job inside it.
5. It should finish with a green tick in about a minute. Open these steps to
   read them:
   - **Show which account the token belongs to** shows your Cloudflare account. This step is informational and may print a permissions note; that is fine.
   - **Show pending database migrations** lists `0012` to `0015` as waiting.
   - **Show the notification Worker's secret names** should include
     `RESEND_API_KEY`. A yellow warning here means the email key is missing: add
     it in Cloudflare under **Workers & Pages**, **shibam-team-notifications**,
     **Settings**, **Variables and Secrets**.

### E. Do the real deploy

1. Back on **Actions**, **Deploy to Cloudflare**, click **Run workflow** again.
2. This time set **mode** to **deploy** and click **Run workflow**.
3. Open the run. It runs the tests, applies the four database changes, deploys
   the email Worker, and then checks that the live booking page and API work. It
   can wait up to about 5 minutes for your website's own deployment to finish.
4. **A green tick means Steps 1 to 3 are done and Step 4's rewrite check has
   passed.** The last step prints `OK: the booking page and API are live`.

If a step goes red, open it and read the message, then see "If the workflow
fails" at the end of this file.

You can leave the token in place to use for future deploys, or delete it in
Cloudflare (**My Profile**, **API Tokens**) and create a new one next time.

---

## After the one-time setup: deploys happen automatically

Once the two GitHub secrets from part C are in place, you never need to click Run
workflow again for normal changes.

**When it runs by itself.** Whenever a change that touches the database
(`migrations/`) or the email Worker (`workers/notifications/`) is pushed to
`main`. Changes that only affect website pages do not start it, because
Cloudflare publishes the website from `main` on its own.

**What happens, in order:**
1. The tests run. If any fail, nothing on Cloudflare is touched.
2. A **30 second countdown**. To stop the deploy, open the run on the **Actions**
   tab and click **Cancel workflow** before it ends. Nothing has changed yet.
3. A database restore point is saved (Cloudflare keeps 30 days of history).
4. Pending database changes are applied.
5. The email Worker is deployed.
6. The live booking page and API are checked.

A green tick means it all worked. If a run fails, GitHub emails you, and the run's
summary page says which step failed and, if the database was involved, the one
command that restores it to how it was just before.

**To undo a deploy's database changes**, open the run, scroll to the **Summary**
at the top, and run the `npx wrangler d1 time-travel restore ...` command shown
there (in the `shibam-coffee-website` folder, signed in with `npx wrangler login`).

**Clicking Run workflow still works.** `check` only looks and changes nothing.
`deploy` does the same steps as an automatic run, without the countdown.

**One habit that avoids brief errors.** The website and the database are updated
by two separate Cloudflare systems that start at the same moment, so for a minute
or two one can be ahead of the other. If a change adds a database column *and*
the code that uses it in the same commit, a new feature can show an error
until the database catches up. Existing pages are not affected. For a change
that needs a new column, push the database change first and the code that uses
it in a later commit.

---

## Command-line route (alternative to the GitHub button)

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
   "Barista interview"), pick the address and length, choose how far ahead people
   can book (**1 to 30 days**), and add any questions (for example "Which position
   are you applying for?"). Save.
4. On the meeting card click **Create link**, add a label (for example "Spring
   hiring"), and click **Create link**. The card's link list opens and shows the
   new link with a **Copy link** button.
5. To see your links again later, click **View links** on the meeting card. Each
   link shows its address, how many people booked, and its status, with **Copy
   link** and **Revoke** buttons. Only you and Management can see these
   addresses. Links created before this update
   can't be shown again: they still work, but make a new link if you need one to
   copy.
6. The same link can be sent to many candidates. Each person can hold only one
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

## If the workflow fails

| What the red step says | What it means and what to do |
|---|---|
| "The GitHub secret CLOUDFLARE_API_TOKEN is not set" | Redo part C. The secret names must match exactly. |
| `wrangler whoami` or any step says "Authentication error" or "Invalid API token" | The token is wrong or missing a permission. Create a new one following part A exactly, then update the GitHub secret. |
| "Could not route to /accounts/..." or "account not found" | The Account ID in part C is wrong. Re-copy it from Workers & Pages. |
| A migration step fails with "table ... already exists" or "duplicate column" | Someone applied part of it by hand earlier. Stop and send me the message. Do not run it again. |
| "Tests" step fails | Nothing was changed on Cloudflare. Send me the message. |
| "Check the live booking page and API" fails with `HTTP 308` or `HTTP 404` on the page | The `/book/...` address is not being served as the booking page. A `308` means the site is redirecting and dropping the private token (this happened once and is fixed in `_redirects`). Make sure the latest `main` commit shows **Success** under Cloudflare **Deployments**, then run the workflow again. If it still fails, send me the lines that start with `page check`. |
| The same step fails with `HTTP 500 server_error` on the API | The database changes did not apply. Look at the "Apply database migrations" step above it. |

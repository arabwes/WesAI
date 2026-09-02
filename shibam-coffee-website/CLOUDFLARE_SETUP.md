# Cloudflare team portal setup

This guide deploys the employee portal and scheduling application to Cloudflare.
The existing public website is the Cloudflare Pages project named
`yemenicoffeeco`; its custom domain is `shibamatlanta.com`.

The application uses four Cloudflare pieces:

- **Pages** serves the existing website and the employee portal.
- **Pages Functions** runs the same-origin `/api/team` API.
- **D1** stores users, sessions, form entries, schedules, availability, and requests.
- **Queues + a separate Worker** deliver optional notification email through Resend.

The notification Worker is a different Cloudflare resource from the Pages project.
This distinction matters when configuring secrets:

| Secret | Cloudflare resource | Purpose |
| --- | --- | --- |
| `BOOTSTRAP_SECRET` | Pages project `yemenicoffeeco` | Creates the first management account |
| `TURNSTILE_SECRET` | Pages project `yemenicoffeeco` | Optional login bot protection |
| `RESEND_API_KEY` | Worker `shibam-team-notifications` | Sends schedule notification email |
| `VAPID_PRIVATE_JWK` | Worker `shibam-team-notifications` | Signs browser Web Push messages |
| `TWILIO_ACCOUNT_SID` | Notification Worker | Twilio account identifier used by the SMS sender |
| `TWILIO_AUTH_TOKEN` | Notification Worker **and** Pages | Sends SMS and validates Twilio STOP/START webhooks |
| `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER` | Notification Worker | Selects the Twilio sender |

### Fast path: set only the notification Worker secret

If the databases and queues already exist, use this checklist:

1. Run `node --version` and confirm v22 or newer.
2. Run `npx wrangler whoami` and confirm the correct Cloudflare account.
3. Put the production `shibam-team` database ID in
   `workers/notifications/wrangler.jsonc`.
4. Verify that the same file still says `"name": "shibam-team-notifications"`
   and `"binding": "TEAM_DB"`.
5. Run `npm run notifications:deploy` once to create/update the Worker.
6. Run `npm run notifications:set-secret`, paste the Resend `re_...` key at
   the hidden prompt, and press Enter.
7. Run
   `npx wrangler secret list --config workers/notifications/wrangler.jsonc`.
8. Confirm the list contains `RESEND_API_KEY` with type `secret_text`.

If the CLI remains troublesome, use the dashboard walkthrough in
[Step 3C](#3c-notification-worker-resend-secret).

Nothing in this setup changes the public marketing pages.

## Before you start

### Work from the correct folder

Open PowerShell in the folder containing this file and `package.json`. For the
merged `main` checkout, the exact command is:

~~~powershell
Set-Location 'C:\Users\arabw\Documents\claude\Projects\WesAI\shibam-coffee-website'
Get-Location
~~~

The reported path should end in `shibam-coffee-website`. Run all commands in this
guide from that folder unless a step explicitly says otherwise. Do not change into
`workers/notifications` when using the provided npm scripts.

### Check Node.js before running Wrangler

This project requires Node.js 22 or newer:

~~~powershell
node --version
npm --version
where.exe node
~~~

The first command must report `v22` or newer. On this machine, the system `npx`
was found using Node `v20.18.0`, which causes Wrangler to stop with:

~~~text
Wrangler requires at least Node.js v22.0.0.
~~~

If that happens:

1. Install a current Node.js LTS release from https://nodejs.org/.
2. Close every PowerShell window.
3. Open a new PowerShell window.
4. Run `node --version` again and confirm it is at least v22.
5. Use `where.exe node` if the old version still appears first in `PATH`.

Install the project-local Wrangler version:

~~~powershell
npm install
npx wrangler --version
~~~

Using the local version keeps commands consistent with `package-lock.json`.

### Authenticate Wrangler

Check which Cloudflare account Wrangler is using:

~~~powershell
npx wrangler whoami
~~~

Confirm that the output includes the account that owns the
`yemenicoffeeco` Pages project. If you are not signed in:

~~~powershell
npx wrangler login
npx wrangler whoami
~~~

If the browser login hangs or cannot return to localhost, use the device flow:

~~~powershell
npx wrangler login --device
~~~

Do not continue until `whoami` shows the correct Cloudflare account.

## 1. Create or locate the Cloudflare resources

Only create resources that do not already exist:

~~~powershell
npx wrangler d1 create shibam-team
npx wrangler d1 create shibam-team-preview
npx wrangler queues create shibam-team-notifications
npx wrangler queues create shibam-team-notifications-dead-letter
~~~

When D1 creates a database, Wrangler prints a UUID named `database_id`. Save both
IDs:

- `shibam-team` ID: production database
- `shibam-team-preview` ID: preview database

You can also find them in Cloudflare Dashboard → Storage & Databases → D1.

If a create command says the resource already exists, do not make a differently
named duplicate. Find the existing resource in the dashboard or list it:

~~~powershell
npx wrangler d1 list
npx wrangler queues list
~~~

### Configure the Pages project bindings

Open `wrangler.jsonc` and replace only the placeholder database IDs. The binding
names are part of the application contract and must remain exactly:

- Production and preview D1 binding: `TEAM_DB`
- Queue producer binding: `NOTIFICATIONS`

The relevant production shape is:

~~~jsonc
{
  "d1_databases": [
    {
      "binding": "TEAM_DB",
      "database_name": "shibam-team",
      "database_id": "<PRODUCTION_D1_ID>",
      "migrations_dir": "migrations"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "NOTIFICATIONS",
        "queue": "shibam-team-notifications"
      }
    ]
  }
}
~~~

The preview database belongs under `env.preview.d1_databases` and still uses the
binding name `TEAM_DB`. Do not add the preview database as a second top-level
binding.

The Pages project is a Queue **producer only**. Do not add `queues.consumers` to
the Pages `wrangler.jsonc`. The separate notification Worker is the only consumer
of `shibam-team-notifications`. Cloudflare permits only one active consumer for a
queue.

### Configure the notification Worker bindings

Open `workers/notifications/wrangler.jsonc` and make these changes:

1. Replace `REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` with the production
   `shibam-team` UUID.
2. Keep the D1 binding name exactly `TEAM_DB`.
3. Keep the Worker name exactly `shibam-team-notifications`.
4. Keep `shibam-team-notifications` as its Queue consumer.
5. Set `EMAIL_FROM` to an address on a domain verified in Resend.
6. Confirm `PORTAL_ORIGIN` is the public website origin, without a trailing path.

The D1 ID in this Worker file must be the production ID, not the preview ID.

Check that no placeholders remain:

~~~powershell
Select-String -Path 'wrangler.jsonc','workers/notifications/wrangler.jsonc' -Pattern 'REPLACE_WITH_'
~~~

No output means all placeholders were replaced.

Validate the Worker configuration without deploying:

~~~powershell
npx wrangler deploy --dry-run --config workers/notifications/wrangler.jsonc
~~~

The output should identify:

- Worker: `shibam-team-notifications`
- D1 binding: `env.TEAM_DB (shibam-team)`
- Queue consumer: `shibam-team-notifications`

## 2. Apply and verify the D1 schema

Local development:

~~~powershell
npm run db:migrate:local
~~~

Preview:

~~~powershell
npm run db:migrate:preview
~~~

Production:

~~~powershell
npm run db:migrate:production
~~~

Wrangler shows the migrations it plans to apply and asks for confirmation for a
remote database. Read the database name before answering yes. Production must say
`shibam-team`; preview must say `shibam-team-preview`.

Verify key production tables:

~~~powershell
npx wrangler d1 execute shibam-team --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','schedules','shifts','notifications','schedule_templates','portal_documents','employee_write_ups') ORDER BY name;"
~~~

The result should contain all seven table names. `employee_write_ups` is required
before the Lead and Management write-up page can save or display records.

Migrations are deliberately separate from Pages deployment. Apply a migration
before deploying application code that requires it.

## 3. Configure secrets

Never put a real secret in `wrangler.jsonc`, source code, a Git commit, a chat
message, or a screenshot. Wrangler prompts for secret values so they do not need
to appear in the command or shell history.

### 3A. Pages bootstrap secret

Generate a strong random value:

~~~powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
~~~

Copy the output into a password manager. Then run:

~~~powershell
npx wrangler pages secret put BOOTSTRAP_SECRET --project-name yemenicoffeeco
~~~

At the `Enter a secret value` prompt, paste the generated value and press Enter.
The terminal may not display characters while you paste; that is expected.

Verify the secret name exists:

~~~powershell
npx wrangler pages secret list --project-name yemenicoffeeco
~~~

Cloudflare lists the name but never displays the stored value.

For local development, copy `.dev.vars.example` to `.dev.vars` and put a
different local-only value there:

~~~dotenv
APP_ENV=development
BOOTSTRAP_SECRET=replace-with-a-long-random-local-value
~~~

`.dev.vars` is ignored by Git. Do not reuse the production bootstrap secret
locally.

### 3B. Optional Turnstile secret

Create a Turnstile widget restricted to the production hostname:

1. Put the widget's public sitekey in `team/js/config.js`.
2. Add the private key to the Pages project:

~~~powershell
npx wrangler pages secret put TURNSTILE_SECRET --project-name yemenicoffeeco
~~~

3. Verify both Pages secret names:

~~~powershell
npx wrangler pages secret list --project-name yemenicoffeeco
~~~

Turnstile remains optional until both the public sitekey and private secret are
configured. Never put the private Turnstile secret in browser JavaScript.

### 3C. Notification Worker Resend secret

This is the most important distinction in the setup:

> `RESEND_API_KEY` belongs to the Worker named
> `shibam-team-notifications`. It does not belong to the Pages project.

#### Create the Resend key

In Resend:

1. Add and verify the sending domain.
2. Open API Keys and select **Create API Key**.
3. Name it something recognizable, such as `Shibam schedule production`.
4. Choose **Sending access**, not Full access.
5. Restrict it to the verified sending domain when that option is available.
6. Copy the `re_...` value immediately. Resend only shows the value once.

Make sure `EMAIL_FROM` in `workers/notifications/wrangler.jsonc` uses that
verified domain.

#### Recommended first-time CLI sequence

Complete the Node, authentication, database-ID, sender-domain, and dry-run checks
above first. Then deploy the Worker itself:

~~~powershell
npm run notifications:deploy
~~~

This creates or updates the Cloudflare Worker named
`shibam-team-notifications` and connects it as the Queue consumer. Do this before
the Pages producer is live so no production messages arrive while the email
secret is missing.

Now store the Resend API key:

~~~powershell
npm run notifications:set-secret
~~~

The npm script expands to:

~~~powershell
npx wrangler secret put RESEND_API_KEY --config workers/notifications/wrangler.jsonc
~~~

Expected interaction:

~~~text
Enter a secret value: [paste the Resend re_... key here]
Creating the secret for the Worker "shibam-team-notifications"
~~~

Paste the key only at the hidden prompt and press Enter. Do not add quotes. Do
not type the key directly after the command. Cloudflare's `secret put` command
creates a new Worker version and deploys it immediately, so a second deploy is
not required just to activate the secret.

Verify that Cloudflare has the secret:

~~~powershell
npx wrangler secret list --config workers/notifications/wrangler.jsonc
~~~

Expected result:

~~~json
[
  {
    "name": "RESEND_API_KEY",
    "type": "secret_text"
  }
]
~~~

Cloudflare intentionally will not show the value again. Seeing the name and
`secret_text` type is the successful verification.

#### Dashboard method if the CLI is troublesome

You can set the exact same Worker secret without Wrangler:

1. Sign in to the Cloudflare dashboard.
2. Open **Workers & Pages**.
3. Select the Worker named **shibam-team-notifications**. Do not select the
   `yemenicoffeeco` Pages project.
4. Open **Settings**.
5. Under **Variables and Secrets**, select **Add**.
6. Choose type **Secret**.
7. Variable name: `RESEND_API_KEY`.
8. Value: paste the Resend `re_...` key.
9. Select **Deploy**.

Afterward, the dashboard shows the name but masks the value. That is expected.

#### Rotate or remove the Worker secret

To rotate the key, create a new sending-only Resend key and run
`npm run notifications:set-secret` again. Test the new key before deleting the
old key in Resend.

To remove the Cloudflare Worker secret:

~~~powershell
npx wrangler secret delete RESEND_API_KEY --config workers/notifications/wrangler.jsonc
~~~

Removing it disables email delivery and causes queued email attempts to retry.
In-app notifications continue to be stored in D1.

### 3D. Browser Web Push keys

Web Push does not require a paid messaging vendor, but it does require one VAPID
key pair. The public key is safe to expose to browsers. The private JWK must only
exist as a notification Worker secret.

Generate the pair from the project folder:

```powershell
npx @pushforge/builder vapid
```

The command prints a public key and a private JWK. Complete all of these steps:

1. Copy the public key into `VAPID_PUBLIC_KEY` in both locations:
   - the root `wrangler.jsonc` production and preview `vars` blocks;
   - `workers/notifications/wrangler.jsonc` under `vars`.
2. Store the complete private JWK JSON interactively:

```powershell
npx wrangler secret put VAPID_PRIVATE_JWK --config workers/notifications/wrangler.jsonc
```

3. Paste the private JSON at the prompt. Do not add quotation marks around the
   entire value beyond the JSON's own quotation marks.
4. Verify only the secret name, never its value:

```powershell
npx wrangler secret list --config workers/notifications/wrangler.jsonc
```

5. Redeploy the notification Worker and the Pages preview.
6. Open **Profile & Notifications**, choose **Enable push on this device**, and
   allow browser notifications.

If `VAPID_PUBLIC_KEY` remains blank, the button explains that push setup is still
pending. Email and in-app notifications continue to work.

### 3E. Twilio SMS and phone verification

SMS is optional. The checked-in application keeps `SMS_ENABLED` set to `false`
until these steps are complete, so employees cannot accidentally queue messages
that have nowhere to go.

In Twilio, obtain:

- Account SID;
- Auth Token;
- either a Messaging Service SID (recommended) or an SMS-capable Twilio number.

Store the Worker values interactively. Run each command separately and paste
only when Wrangler prompts:

```powershell
npx wrangler secret put TWILIO_ACCOUNT_SID --config workers/notifications/wrangler.jsonc
npx wrangler secret put TWILIO_AUTH_TOKEN --config workers/notifications/wrangler.jsonc
npx wrangler secret put TWILIO_MESSAGING_SERVICE_SID --config workers/notifications/wrangler.jsonc
```

If you use a direct Twilio number instead of a Messaging Service, skip the last
command and run:

```powershell
npx wrangler secret put TWILIO_FROM_NUMBER --config workers/notifications/wrangler.jsonc
```

The Pages Function that processes STOP and START must validate Twilio's request,
so add the same Auth Token to Pages:

```powershell
npx wrangler pages secret put TWILIO_AUTH_TOKEN --project-name yemenicoffeeco
```

Repeat that Pages command for the preview environment if SMS will be tested on a
preview deployment. Then configure the Twilio Messaging Service's incoming
message webhook as an HTTP POST to:

```text
https://shibamatlanta.com/api/team/sms
```

Finally:

1. Change `SMS_ENABLED` from `"false"` to `"true"` in the appropriate
   `wrangler.jsonc` environment.
2. Deploy the notification Worker and Pages environment.
3. Add a mobile number in **Profile & Notifications** using E.164 format, such
   as `+14045550123`.
4. Verify the six-digit code.
5. Enable one SMS notification category and trigger a test schedule change.
6. Reply `STOP`, confirm the portal stops creating SMS deliveries, then reply
   `START` and explicitly re-enable the desired SMS categories in the portal.

Twilio credentials are not checked into the repository. Carrier registration,
sender approval, costs, and geographic restrictions remain external Twilio
account tasks.

### 3F. Enable invitation email after Resend works

Employee invitations use the same `RESEND_API_KEY` and notification Worker as
schedule email. After the Resend sender test succeeds, change
`INVITATION_EMAIL_ENABLED` to `"true"` in the appropriate root
`wrangler.jsonc` environment and deploy Pages.

Invitations created while `INVITATION_EMAIL_ENABLED` is `false` are stored but
are not queued for delivery. Revoke those pending invitations and create fresh
ones after email is active; only token hashes are stored, so an old raw
invitation link cannot be reconstructed.

### 3G. Current credential-dependent blockers

The code and database flows are complete, but these external actions cannot be
completed without account credentials:

| Capability | Blocker | Portal behavior before resolution |
|---|---|---|
| Email and invitations | Verified Resend domain and `RESEND_API_KEY` | In-app notifications work; ordinary email deliveries retry, while invitation email stays explicitly disabled |
| Browser push | Generated VAPID pair and Worker secret | Push enable button remains unavailable |
| SMS verification/alerts | Twilio account, sender, keys, webhook, and any required carrier registration | SMS setup stays disabled; no SMS is queued |
| Login bot protection | Turnstile sitekey and secret | Login throttling remains active; Turnstile widget stays hidden |

These are configuration blockers only. Schedule building, exchanges, templates,
rotations, availability periods, coverage, history, profiles, calendar feeds,
in-app notifications, and request approvals do not depend on them.

## 4. Create or import the first management account

### Fresh portal

Deploy the Pages application and apply the production migration first. The
bootstrap request succeeds only while the `users` table is empty.

From PowerShell:

~~~powershell
$portalUrl = 'https://shibamatlanta.com'
$bootstrapSecret = Read-Host 'Paste BOOTSTRAP_SECRET'
$body = @{
  action = 'bootstrap'
  bootstrapSecret = $bootstrapSecret
  username = 'manager'
  name = 'Manager Name'
  email = 'manager@example.com'
  password = Read-Host 'Choose a unique password of at least 10 characters'
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "$portalUrl/api/team" -ContentType 'application/json' -Body $body
~~~

Replace the example username, name, and email before running it. A successful
response contains `"ok": true`.

After the first management account exists, remove the production bootstrap
secret:

~~~powershell
npx wrangler pages secret delete BOOTSTRAP_SECRET --project-name yemenicoffeeco
~~~

Further employees are added in Team Portal → Admin → Users.

### Existing Apps Script portal

Export these spreadsheet tabs as CSV files into `legacy-export/`:

- `Users.csv`
- `Catalog.csv`
- `Inventory Log.csv`
- `Dessert Daily Log.csv`
- `Dessert Order Log.csv`
- `Local Order Log.csv`

Generate an import file:

~~~powershell
npm run legacy:build-import -- legacy-export legacy-import.sql
~~~

Open and inspect `legacy-import.sql` before applying it. Both
`legacy-export/` and `legacy-import.sql` are ignored by Git because they may
contain employee information.

Apply it to production:

~~~powershell
npx wrangler d1 execute shibam-team --remote --file legacy-import.sql
~~~

Imported password hashes are marked `legacy-sha256`. A successful login verifies
the old hash once and upgrades it to PBKDF2. Sessions are intentionally not
imported.

Keep the original spreadsheet and Apps Script deployment available and
read-only until D1 row counts and sample records have been checked.

## 5. Local development

Copy `.dev.vars.example` to `.dev.vars`:

~~~powershell
Copy-Item '.dev.vars.example' '.dev.vars'
notepad '.dev.vars'
~~~

Choose a local bootstrap value, then:

~~~powershell
npm run db:migrate:local
npm run dev
~~~

Open http://127.0.0.1:8788/team/. A plain static file server cannot run the
Pages Function or D1 backend.

Local D1 data lives under `.wrangler/` and is ignored by Git.

If you run the notification Worker locally as a separate Worker, put its local
Resend key in `workers/notifications/.dev.vars`:

~~~dotenv
RESEND_API_KEY=re_your_local_or_test_key
~~~

That file is also ignored by Git. Do not put the key in the Worker `vars` block.

## 6. Deploy the notification Worker and Pages preview

### Notification Worker

The Worker deploy is independent from the Pages deployment:

~~~powershell
npm run notifications:deploy
npx wrangler secret list --config workers/notifications/wrangler.jsonc
~~~

The secret list must include `RESEND_API_KEY` before notification email is
enabled for production users.

### Pages Git integration

For the existing Cloudflare Pages project:

- Repository root: the existing WesAI repository
- Pages root directory: `shibam-coffee-website`
- Build command: `npm run build`
- Build output directory: `dist`
- Production branch: keep the existing production branch

Pages discovers `functions/` automatically. Push this feature branch to create a
preview deployment, but do not merge it into the production branch until the
preview is approved.

For a manual preview deploy instead of Git integration:

~~~powershell
npm run build
npx wrangler pages deploy dist --project-name yemenicoffeeco --branch feature/scheduling-high-medium
~~~

Before a production deployment:

1. `node --version` is v22 or newer.
2. `npx wrangler whoami` shows the correct account.
3. No `REPLACE_WITH_` placeholders remain.
4. Binding names remain `TEAM_DB` and `NOTIFICATIONS`.
5. The production D1 migration has completed.
6. The notification Worker is deployed.
7. `RESEND_API_KEY` appears in the notification Worker's secret list.
8. Required Pages secrets appear in the Pages secret list.
9. The Pages preview passes the scheduling section of `TEST_PLAN.md`.
10. The existing Apps Script deployment remains available during the pilot.

### Production launch sequence

Run this sequence from the merged `main` checkout. It intentionally backs up
D1 and deploys the notification consumer before deploying the Pages producer.

1. Confirm the checkout and run the release checks:

~~~powershell
Set-Location 'C:\Users\arabw\Documents\claude\Projects\WesAI\shibam-coffee-website'
git status --short --branch
npm ci
npm test
npm run test:mobile
npm run build
npx wrangler deploy --dry-run --config workers/notifications/wrangler.jsonc
~~~

`git status` must show `main` with no uncommitted files. Every test and build
command must exit successfully.

2. Confirm the Cloudflare account and existing resource names:

~~~powershell
npx wrangler whoami
npx wrangler d1 list
npx wrangler queues list
~~~

The account must own `yemenicoffeeco`, `shibam-team`,
`shibam-team-notifications`, and
`shibam-team-notifications-dead-letter`. Do not create duplicates if they are
already listed.

3. Export a pre-migration database backup outside the repository:

~~~powershell
$backupDir = Join-Path $env:USERPROFILE 'Documents\shibam-production-backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$backupFile = Join-Path $backupDir ("shibam-team-{0}.sql" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
npx wrangler d1 export shibam-team --remote --output $backupFile
Get-Item -LiteralPath $backupFile
~~~

Keep the printed backup path. Do not commit the export because it may contain
employee information.

4. List and apply only the pending production migrations:

~~~powershell
npx wrangler d1 migrations list shibam-team --remote
npm run db:migrate:production
npx wrangler d1 migrations list shibam-team --remote
~~~

Before confirming, verify that Wrangler names the remote database
`shibam-team`. The final list must report that there are no migrations to
apply. Existing installations should apply every migration listed as pending.
The current sequence ends with `0006_employee_write_ups.sql`; it adds the
confidential corrective-action records used by `/team/write-up`.

5. Configure credential-dependent services before enabling their flags:

- For production email, verify the Resend sender domain, set `EMAIL_FROM`,
  deploy the Worker, and run `npm run notifications:set-secret`.
- For Web Push, complete Step 3D and set both the public and private VAPID
  values.
- For SMS, complete Step 3E before changing `SMS_ENABLED` to `"true"`.
- For invitation email, complete the Resend setup before changing
  `INVITATION_EMAIL_ENABLED` to `"true"`.
- Turnstile remains optional; complete Step 3B if it is wanted at launch.

After setting Worker secrets, verify only their names:

~~~powershell
npx wrangler secret list --config workers/notifications/wrangler.jsonc
npx wrangler pages secret list --project-name yemenicoffeeco
~~~

6. Deploy the notification Worker:

~~~powershell
npm run notifications:deploy
~~~

If email, Web Push, and SMS are still disabled, the Worker can still be
deployed safely; in-app notifications and the hourly maintenance task remain
available.

7. Publish `main` and deploy Pages. With the existing Git-integrated Pages
project, push the merge commit:

~~~powershell
Set-Location 'C:\Users\arabw\Documents\claude\Projects\WesAI'
git push origin main
~~~

If automatic production deployments are disabled in Cloudflare, deploy the
already-built output manually from the website folder:

~~~powershell
Set-Location 'C:\Users\arabw\Documents\claude\Projects\WesAI\shibam-coffee-website'
npm run build
npx wrangler pages deploy dist --project-name yemenicoffeeco --branch main
~~~

Use one Pages deployment path, not both. In Cloudflare Dashboard → Workers &
Pages → `yemenicoffeeco` → Deployments, wait for the production deployment to
show **Success**.

8. Verify the live API and database:

~~~powershell
Invoke-RestMethod 'https://shibamatlanta.com/api/team?health=1'
npx wrangler d1 execute shibam-team --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','schedules','shifts','notifications','schedule_templates','portal_documents') ORDER BY name;"
~~~

The health response must contain `ok: true`, and the database query must return
all six tables.

9. Sign in at `https://shibamatlanta.com/team/` using the existing
management account. Use the bootstrap procedure in Step 4 only if the `users`
table is empty. Then smoke-test these flows in order:

   - open Admin and confirm Users, Invitations, Changelog, and Documents load;
   - open Schedule Management, create a draft week, add a shift, and publish;
   - sign in as an employee, submit availability and a time-off request;
   - confirm the employee can view and acknowledge the published shift;
   - submit and recall/edit one same-day inventory entry;
   - if email is enabled, send one invitation and inspect Worker and Resend logs;
   - if push or SMS is enabled, test one opted-in device or verified phone.

10. Keep the D1 backup and the previous successful Pages deployment through the
pilot. If a release problem appears, roll Pages back in the dashboard and use
the D1 Time Travel or export restore procedure only when database restoration
is actually required.

## 7. Verify email delivery

After publishing a schedule or creating an eligible open shift:

1. Confirm the employee has an email address in the portal.
2. Open Cloudflare Dashboard → Workers & Pages →
   `shibam-team-notifications` → Logs.
3. Open Resend → Logs and confirm the request used the expected API key and
   sender domain.
4. Inspect recent D1 notification status:

~~~powershell
npx wrangler d1 execute shibam-team --remote --command "SELECT created_at, title, email_status, email_attempts, email_last_error FROM notifications ORDER BY created_at DESC LIMIT 10;"
~~~

Useful statuses:

- `pending`: created but not yet processed
- `sent`: Resend accepted the email
- `skipped`: employee has no email address
- `failed`: delivery attempt failed; inspect `email_last_error`

Tail the Worker from PowerShell while producing a test notification:

~~~powershell
npx wrangler tail --config workers/notifications/wrangler.jsonc
~~~

## Troubleshooting

### “Wrangler requires at least Node.js v22”

Your terminal is using an old Node installation. Run:

~~~powershell
node --version
where.exe node
~~~

Install Node 22 or newer, close PowerShell, and retry in a new window.

### Authentication or permissions error

Run `npx wrangler whoami`. Confirm the account owns the Pages project, D1
database, Queue, and Worker. Reauthenticate with `npx wrangler login --device`
if necessary.

### Secret was added to the wrong resource

Compare both lists:

~~~powershell
npx wrangler pages secret list --project-name yemenicoffeeco
npx wrangler secret list --config workers/notifications/wrangler.jsonc
~~~

`RESEND_API_KEY` must appear only in the second list. `BOOTSTRAP_SECRET` and
`TURNSTILE_SECRET` belong in the first list.

### Worker secret command references the wrong Worker

The command must include:

~~~text
--config workers/notifications/wrangler.jsonc
~~~

That config contains `"name": "shibam-team-notifications"`. Running
`wrangler secret put` without the config can target the wrong Worker.

### Worker does not exist

Create it from the checked-in configuration, then add the secret:

~~~powershell
npm run notifications:deploy
npm run notifications:set-secret
~~~

### Invalid D1 database ID or a `REPLACE_WITH_...` error

Copy the production `shibam-team` UUID into both:

- the production D1 entry in `wrangler.jsonc`
- the D1 entry in `workers/notifications/wrangler.jsonc`

Do not use the preview UUID in the notification Worker.

### `TEAM_DB` or `NOTIFICATIONS` is undefined

The JavaScript code reads `env.TEAM_DB` and `env.NOTIFICATIONS`. Restore those
exact uppercase binding names. The database and queue resource names may contain
hyphens; the JavaScript binding names may not be renamed.

### Queue already has a consumer

Only `workers/notifications/wrangler.jsonc` should contain
`queues.consumers`. Remove consumer declarations from the Pages
`wrangler.jsonc`. The Pages project should contain only the
`NOTIFICATIONS` producer.

### Resend returns 401

The key is invalid, incomplete, revoked, or was pasted with extra characters.
Create a new sending-only key, rotate the Worker secret, and retry.

### Resend rejects the sender

Confirm the Resend domain is fully verified and `EMAIL_FROM` uses that exact
domain. The display name is optional, but the address must be on the verified
domain.

### No email and no Worker invocation

Check that:

- The Pages binding is named `NOTIFICATIONS`.
- The primary queue name is `shibam-team-notifications`.
- The separate Worker is registered as that queue's only consumer.
- The Pages deployment contains the scheduling Functions.

### Local development works but production fails

Local `.dev.vars` and local D1 state do not deploy to Cloudflare. Verify remote
secrets with the two secret-list commands and verify the production migration
with the D1 query in Step 2.

## Rollback

Do not delete the Apps Script deployment or spreadsheet during the pilot. If a
production issue appears, roll the Pages project back to its previous successful
deployment. That deployment still contains the Apps Script API URL.

The notification Worker can be disabled independently by removing the Pages
`NOTIFICATIONS` producer binding or pausing/removing its Queue consumer. Do not
delete D1 to disable email.

D1 records can be restored with Time Travel. Take a manual export before a large
data import or destructive migration.

## Official references

- Cloudflare Wrangler installation:
  https://developers.cloudflare.com/workers/wrangler/install-and-update/
- Cloudflare Wrangler authentication:
  https://developers.cloudflare.com/workers/wrangler/commands/general/
- Cloudflare Worker secrets:
  https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare Pages secrets and commands:
  https://developers.cloudflare.com/workers/wrangler/commands/pages/
- Cloudflare Pages bindings:
  https://developers.cloudflare.com/pages/functions/bindings/
- Cloudflare Queue configuration:
  https://developers.cloudflare.com/queues/configuration/configure-queues/
- Resend API keys:
  https://resend.com/docs/dashboard/api-keys/introduction

# Cloudflare team portal setup

The employee portal is a full-stack Cloudflare Pages application:

- Static HTML, CSS, and JavaScript remain on Pages.
- `/api/team` is a Pages Function.
- `TEAM_DB` is a D1 database.
- `NOTIFICATIONS` is a Queue producer.
- A separate Queue consumer sends optional email through Resend.

Nothing in this setup changes the public marketing pages.

## Prerequisites

- Node.js 22 or newer.
- A Cloudflare account with the existing Pages project.
- Wrangler authenticated to the Cloudflare account.
- Optional: a verified Resend sending domain for email notifications.

Install the local tooling:

```bash
npm install
```

## 1. Create databases and queues

```bash
npx wrangler d1 create shibam-team
npx wrangler d1 create shibam-team-preview
npx wrangler queues create shibam-team-notifications
npx wrangler queues create shibam-team-notifications-dead-letter
```

Copy the two D1 IDs into `wrangler.jsonc`. Put the production ID into the
top-level binding and the preview ID into `env.preview`. Put the production ID
in `workers/notifications/wrangler.jsonc` too.

Do not deploy while any `REPLACE_WITH_...` values remain.

## 2. Apply the schema

Local development:

```bash
npm run db:migrate:local
```

Preview and production:

```bash
npm run db:migrate:preview
npm run db:migrate:production
```

Database migrations are deliberately separate from the Pages deployment.
Apply a migration before deploying code that requires it.

## 3. Configure secrets

Generate a long random bootstrap secret and store it in both the Pages project
and the local `.dev.vars` file. Never commit `.dev.vars`.

```bash
npx wrangler pages secret put BOOTSTRAP_SECRET --project-name shibam-coffee-website
```

For Turnstile, create a widget restricted to the production hostname, then:

1. Put the public sitekey in `team/js/config.js`.
2. Add the secret to Pages as `TURNSTILE_SECRET`.
3. Use Cloudflare's documented test keys in local automated tests.

Turnstile is optional until both values are configured. The API only requires a
token when `TURNSTILE_SECRET` is present.

For notification email, deploy the worker secret:

```bash
npm run notifications:set-secret
npm run notifications:deploy
```

Use a Resend API key restricted to sending email. Verify the sender domain and
update `EMAIL_FROM` in the notification worker configuration before enabling the
Queue binding in production.

## 4. Create or import Management

### Fresh portal

After the production migration, make one bootstrap request. It only succeeds
while the `users` table is empty.

```json
POST /api/team
{
  "action": "bootstrap",
  "bootstrapSecret": "your-secret",
  "username": "your-manager-login",
  "name": "Manager name",
  "email": "manager@example.com",
  "password": "a-unique-password-of-at-least-10-characters"
}
```

Delete the `BOOTSTRAP_SECRET` from the Pages project after the first account is
created. Further employees are added in Team Portal → Admin → Users.

### Existing Apps Script portal

Export the following spreadsheet tabs as CSV into `legacy-export/`:

- `Users.csv`
- `Catalog.csv`
- `Inventory Log.csv`
- `Dessert Daily Log.csv`
- `Dessert Order Log.csv`
- `Local Order Log.csv`

Generate an import file and inspect it before applying it:

```bash
npm run legacy:build-import -- legacy-export legacy-import.sql
npx wrangler d1 execute shibam-team --remote --file legacy-import.sql
```

Imported password hashes are marked `legacy-sha256`. A successful login verifies
the old hash once and transparently upgrades it to PBKDF2. The script intentionally
does not import sessions.

Keep the original spreadsheet read-only until the D1 row counts and sample
records have been checked.

## 5. Local development

Copy `.dev.vars.example` to `.dev.vars`, choose a local bootstrap secret, then:

```bash
npm run db:migrate:local
npm run dev
```

Open `http://127.0.0.1:8788/team/`. A plain static file server cannot run the
Pages Function or D1 backend.

Local D1 data lives under `.wrangler/` and is ignored by Git.

## 6. Deploy

The existing Cloudflare Pages Git integration can continue deploying this
directory. Pages discovers the `/functions` directory automatically. Keep the
build command empty and the output directory set to the website directory/root,
as before.

Before merging or deploying:

1. Apply the production migration.
2. Confirm all database IDs and bindings.
3. Deploy the notification worker.
4. Verify secrets in the production Pages environment.
5. Deploy this branch to a Pages preview first.
6. Run the scheduling section of `TEST_PLAN.md`.

## Rollback

Do not delete the Apps Script deployment or spreadsheet during the pilot. If a
production issue appears, roll the Pages project back to its previous successful
deployment. That deployment still contains the Apps Script API URL.

D1 records can also be restored with Time Travel. Take a manual export before a
large data import or destructive migration.

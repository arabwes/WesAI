# Portal MCP: connect an AI app to the team portal

A read-only [MCP](https://modelcontextprotocol.io) connector that lets an AI app such as Claude
read the Shibam Coffee team portal as a signed-in Lead or Manager.

- **Connector URL:** `https://shibamatlanta.com/portal-mcp/mcp`
- **Connected apps:** `https://shibamatlanta.com/portal-mcp/connections` (or Profile, then "AI connections", in the portal)

## What an AI app can do

| Tool | What it returns |
|---|---|
| `portal_whoami` | The account it is connected as, and what it can and cannot see |
| `inventory_latest_count` | The latest submitted inventory count: kitchen, storage and total per item, and whether each is below its "order below" level. Filters: only items below their level, or one section. Also whether a new count is in progress. |
| `schedule_week` | One week's shifts, open shifts, published or draft, and who is off (never why) |
| `team_calendar` | Team events and booked meetings between two dates. Other people's meetings show only as "Booked". |
| `catering_requests` | Catering requests with event details, status, message counts and unread replies |
| `catering_conversation` | The messages for one request, including internal notes. Reading here does **not** mark replies read in the portal. |
| `meeting_types` | Your meeting types and booking links' status and booking counts (Management sees everyone's) |

**Never shared, for any role:** customer or candidate names, emails and phone numbers; booking
answers; private booking, reschedule and conversation links; staff emails; time-off reasons;
anything about passwords or sessions. Each tool returns only the fields named in
`src/tools.js`, so a field added to the portal later is not exposed until someone adds it there.

**Read-only.** Nothing can be changed through the connector.

## How access works

1. The AI app sends you to the portal's sign-in page for the connector.
2. You sign in with your **portal username and password**. They are checked by the portal's own
   code with the same attempt limit (10 tries per 15 minutes). No portal session is created.
3. You see exactly what the app will be able to read, and click **Allow**.
4. The app gets a token for your account. Every call reloads your account: if you are deactivated
   or your role drops below Lead, the app stops working at once.

- Only **Leads and Management** can connect. Baristas are refused.
- The app sees what *you* can see in the portal, minus the private fields above. The privacy
  rules are the portal's own code, not a copy.
- Every call is recorded in the portal's audit log (`mcp.<tool>`, with the app's name).
- Each person is limited to 120 calls a minute.
- Access tokens last 1 hour and renew for up to 30 days of use. Disconnecting stops access immediately.
- Anything an app reads is sent to the company that runs it (for Claude, Anthropic).

## One-time setup (owner)

The connector is deployed by the **Deploy to Cloudflare** GitHub workflow. Its on/off switch is
`PORTAL_MCP_ENABLED` near the top of `.github/workflows/deploy-cloudflare.yml` (now `"true"`).
It needs two more Cloudflare permissions than the rest of the site, on the `GitHub deploy` token
(dash.cloudflare.com, then your profile icon, **My Profile**, **API Tokens**, **Edit**):

- **Account** / **Workers KV Storage** / **Edit** (its sign-in records live in KV, which is created
  automatically on the first deploy)
- **Zone** / **Workers Routes** / **Edit**, with **Zone Resources** set to **Include** / **Specific
  zone** / `shibamatlanta.com` (so it can serve `/portal-mcp`)

Any change to the connector, or to the portal code it uses, redeploys it automatically. To switch
it off, set the switch to `"false"` and remove its routes in Cloudflare (Workers & Pages,
`shibam-portal-mcp`), or delete that Worker.

## Connect Claude

1. In Claude, open **Settings**, then **Connectors**, then **Add custom connector**. (On Team and
   Enterprise plans an organization Owner adds it under the admin settings first.)
2. Name: `Shibam Coffee Portal`. URL: `https://shibamatlanta.com/portal-mcp/mcp`. Add it.
3. Click **Connect**. Sign in with your portal username and password, check the list, and click **Allow**.
4. Try: *"What's below its order-below level in the latest inventory count?"* or
   *"Who's working this Saturday, and are there open shifts?"*

To disconnect: in the portal, **Profile**, then **AI connections**, then **Disconnect**. Removing the
connector in Claude also stops it using your account.

## Developing and testing

- Tool rules: `tests/portal-mcp.test.js` in the website folder (runs with `npm test` and in CI).
- Full sign-in and MCP check against a running copy, acting exactly like an AI app:

  ```sh
  npm ci
  npx wrangler d1 migrations apply shibam-team --local
  # add a Lead (and optionally a Barista) to the local database, then:
  npx wrangler dev --local --port 8790 --local-protocol https --local-upstream localhost:8790 --var PUBLIC_ORIGIN:https://localhost:8790
  NODE_TLS_REJECT_UNAUTHORIZED=0 BASE=https://localhost:8790 LEAD_USER=... LEAD_PASS=... node scripts/e2e.mjs
  ```

  The OAuth library requires HTTPS, hence the local certificate. Against the live site:
  `BASE=https://shibamatlanta.com LEAD_USER=... LEAD_PASS=... node scripts/e2e.mjs` (it registers a
  test app named "E2E Test App"; disconnect it afterwards from AI connections).

# Team Forms — Shibam Coffee Atlanta

Internal forms for inventory counts and local order requests, replacing the
Google Sheets the team was filling out by hand. Lives at
`https://www.shibamatlanta.com/team/` and ships with the main site — same
Cloudflare Pages deployment, no separate project.

## The three forms

| Page | Used | Replaces |
|---|---|---|
| `inventory.html` | Weekly | "Shibam Coffee Atlanta" inventory sheet |
| `dessert-inventory.html` | Daily (+ vendor order tab) | "Dessert inventory" sheet |
| `local-order.html` | As needed | "Local order list" sheet |

## Why it's structured this way

The sheets they replace had no way to enforce a complete entry. These forms do:

- **No blank counts.** Every quantity is required — 0 is a valid answer, blank
  isn't, because blank can't be told apart from "nobody checked this shelf."
- **Name and timestamp on every submission.** The payload always carries
  `employeeName` and an ISO `submittedAt`, so each entry is attributable.
- **The local order form gates its own submit button.** It stays disabled until
  the "I went through every item" checkbox is ticked. The whole point of that
  form is consolidating into one market run, which only works if someone
  actually reads the full list — so the full list is never filtered down, and
  the threshold highlighting is a scanning aid on top of it, not a shortcut.

## Access

The portal isn't linked from anywhere on the public site, isn't in
`sitemap.xml`, and every page carries `noindex, nofollow`. It is deliberately
**not** listed in `robots.txt` — a `Disallow: /team/` line would publish the
path to anyone who reads that file.

**This is obscurity, not access control.** Anyone with the URL can submit a
form; there's no login. If that becomes a problem, Cloudflare Access (free
tier) can gate `/team/*` behind an email login with no code changes here.

## Editing the item lists

All three item lists live in `js/data.js` — `INVENTORY_ITEMS`,
`DESSERT_ITEMS`, `DESSERT_VENDOR_ORDERS`, and `LOCAL_ORDER_SECTIONS`. Add,
remove, or reorder entries there and the forms pick it up on the next page
load. Nothing else needs to change.

For the local order list, each item's `threshold` is the number it must drop
below before the row highlights, and `unit` is what shows in the Unit column.

## Connecting submissions (one-time setup)

Until this is done, the forms work but submitting shows "This form isn't
connected yet" instead of failing silently.

**1. Create the tracking spreadsheet.** A new Google Sheet in the shop's
Drive. The script creates its own tabs, so it can start empty.

**2. Open Extensions → Apps Script** and replace the contents with:

```js
function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var tabs = {
    'inventory': 'Inventory Log',
    'dessert-daily': 'Dessert Daily Log',
    'dessert-order': 'Dessert Order Log',
    'local-order': 'Local Order Log'
  };

  var sheet = getSheet(ss, tabs[payload.formType] || 'Other');
  var rows = flatten(payload);
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// One row per line item, with who/when repeated on each so the log can be
// filtered or pivoted without needing to look up a parent record.
function flatten(payload) {
  var when = payload.submittedAt;
  var who = payload.employeeName;
  var date = payload.weekOf || payload.date || payload.orderDate || '';
  var rows = [];

  (payload.items || []).forEach(function (item) {
    rows.push([when, who, date, item.product, JSON.stringify(item)]);
  });

  (payload.unlistedItems || []).forEach(function (item) {
    rows.push([when, who, date, item.name + ' (not on list)', JSON.stringify(item)]);
  });

  return rows;
}
```

**3. Deploy → New deployment → Web app.** Execute as **Me**, access
**Anyone**. Copy the `/exec` URL it gives you.

Access must be "Anyone" because the browser posts directly to it without a
Google login. The URL is unguessable, but treat it as semi-public: it accepts
writes from anyone who has it. It only ever appends rows.

**4. Paste that URL into `js/config.js`** — all four endpoint values get the
same URL. The script routes each submission to the right tab using the
`formType` field in the payload.

The forms post as `Content-Type: text/plain` on purpose. Apps Script rejects
the CORS preflight that `application/json` triggers; the body is still JSON
and `JSON.parse` handles it fine.

## Local development

No build step. Serve the site root (not this directory — the pages use
absolute `/team/...` paths):

```bash
cd shibam-coffee-website
python3 -m http.server 8000
```

Then open `http://localhost:8000/team/`.

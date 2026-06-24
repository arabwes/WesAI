# Shibam Coffee Atlanta — Website

A static marketing site for Shibam Coffee Atlanta (4000 North Point Pkwy
Suite #900, Alpharetta, GA 30022). Plain HTML/CSS/JS — no framework, no
npm, no build step.

```
shibam-coffee-website/
├── index.html              Home
├── menu.html                Menu
├── catering-events.html     Catering & Events
├── about.html                About
├── location.html             Location
├── contact.html               Contact
├── privacy-policy.html / terms.html
├── css/styles.css            Design system + all component styles
├── js/config.js              All environment-specific URLs & IDs
├── js/script.js               Nav toggle, CTA tracking, form handling
├── images/                    Photo placeholders (see images/README.md)
├── robots.txt / sitemap.xml / _redirects
└── tracking-notes.md / seo-notes.md
```

## 1. Local development

No build step, no server required. Just open `index.html` in a browser —
all CSS and JS load via relative/root-absolute paths.

If you'd rather use a local server (recommended only because `fetch()` in
some browsers behaves oddly on `file://`), any static server works:

```bash
npx serve .
# or
python3 -m http.server 8080
```

## 2. Deploy to Cloudflare Pages

This site lives in the `shibam-coffee-website/` directory of the
`arabwes/wesai` repo (alongside the `shibam-financial-mcp` and
`shibam-marketing-mcp` services, which are unrelated Python projects).

1. In Cloudflare dashboard → **Workers & Pages** → **Create application** →
   **Pages** → **Connect to Git** → select this repository.
2. Build settings:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Build output directory:** `shibam-coffee-website` *(set this to the
     subdirectory, since the repo root also contains the MCP server
     folders)*
   - **Root directory (advanced):** if Cloudflare Pages asks for a root
     directory instead of an output directory, set it to
     `shibam-coffee-website` and leave the output directory as `/`.
3. Deploy. No environment variables are required — every runtime value
   lives in `js/config.js` (see below).

## 3. Custom domain setup

1. In the Pages project → **Custom domains** → **Set up a custom domain**.
2. Enter your domain (e.g. `shibamatlanta.com` or a subdomain). If the
   domain's DNS is already on Cloudflare, the CNAME is added automatically;
   otherwise follow the CNAME instructions shown.
3. The live URL is `https://www.shibamatlanta.com` — every canonical tag,
   Open Graph/Twitter `url`/`image` value, JSON-LD `url`/`image`/`hasMap`,
   `robots.txt`'s `Sitemap:` line, and `sitemap.xml` `<loc>` already
   points at it. If the domain ever changes, repoint everything in one
   pass:

   ```bash
   grep -rl 'https://www.shibamatlanta.com' . | xargs sed -i 's|https://www.shibamatlanta.com|https://new-domain.com|g'
   ```

## 4. How to update the GTM ID

Edit `js/config.js`:

```js
GTM_ID: "GTM-XXXXXXX",
```

This value drives the GTM container loaded in every page's `<head>`. You
also need to manually update the **noscript fallback** GTM ID, since it
sits inside a `<noscript>` tag and can't read from `config.js` (JS is
disabled by definition when that fallback renders). Update the literal
`GTM-XXXXXXX` immediately after `<body>` in every HTML file to match.

## 5. How to update business hours

Hours appear in five places per page (NAP text, footer, and JSON-LD) across
six pages. To update them everywhere at once, search for the current
opening/closing times:

```bash
grep -rn "8:00 AM" .          # human-readable hours in visible HTML
grep -rn '"opens": "08:00"' . # JSON-LD opening hours
grep -rn '"closes":' .        # JSON-LD closing hours
```

Update each match consistently — NAP data must stay identical across every
page and inside the structured data for Google Business Profile matching
to stay accurate.

## 6. How to add photos

See `images/README.md` for the full list of expected filenames and
suggested shots/sizes. In short: drop a file into `/images/` with the
exact name an `<img src>` already references (e.g. `hero-storefront.jpg`)
and it appears automatically — no HTML changes needed. Until then, every
placeholder image fails gracefully (it removes itself via `onerror`,
leaving the warm gradient background visible).

## 7. How to update the sitemap after URL changes

`sitemap.xml` lists all six primary pages with `<loc>`, `<lastmod>`,
`<changefreq>`, and `<priority>`. If you add, remove, or rename a page:

1. Add/update the corresponding `<url>` block in `sitemap.xml`.
2. Update `<lastmod>` to the date of the change (`YYYY-MM-DD`).
3. Keep `robots.txt`'s `Sitemap:` line pointing at `https://www.shibamatlanta.com/sitemap.xml`.
4. Resubmit the sitemap in Google Search Console after deploying.

## 8. UTM examples for all marketing channels

Use these as a starting point — see `tracking-notes.md` for the full UTM
guide and the dataLayer events each CTA fires.

| Channel | Example URL |
|---|---|
| Google Business Profile | `https://www.shibamatlanta.com/?utm_source=google&utm_medium=organic&utm_campaign=gbp` |
| Instagram bio | `https://www.shibamatlanta.com/?utm_source=instagram&utm_medium=social&utm_campaign=bio` |
| TikTok bio | `https://www.shibamatlanta.com/?utm_source=tiktok&utm_medium=social&utm_campaign=bio` |
| In-store QR (table sign) | `https://www.shibamatlanta.com/?utm_source=store&utm_medium=qr&utm_campaign=table_sign` |
| Catering flyer QR | `https://www.shibamatlanta.com/catering-events.html?utm_source=flyer&utm_medium=qr&utm_campaign=catering` |

## Before you go live

- [x] Site URL set to `https://www.shibamatlanta.com` everywhere.
- [ ] Set `GTM_ID` in `js/config.js` and the noscript fallback in every HTML file.
- [ ] Set `GOOGLE_MAPS_EMBED_SRC` in `js/config.js` (Google Maps → Share → Embed a map).
- [ ] Set `CATERING_FORM_ENDPOINT` and `CONTACT_FORM_ENDPOINT` (e.g. Formspree).
- [ ] Verify `GEO_LAT` / `GEO_LNG` against the exact Google Business Profile coordinates.
- [ ] Double-check business hours against the live Google Business Profile listing.
- [ ] Add real photos (see `images/README.md`).

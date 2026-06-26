# Test Plan — run after every push to `main`

Run this against the **live production URL**
(`https://www.shibamatlanta.com`), not a local server. Several of these
checks (especially §1, redirects) depend on Cloudflare Pages' own
platform behavior and cannot be reproduced by `python3 -m http.server`
or any other local static server — a clean local test does not mean the
deployed site is clean.

Replace `https://www.shibamatlanta.com` below if the domain changes.

## 1. Redirect integrity

This is the bug class that caused the `ERR_TOO_MANY_REDIRECTS` menu
outage (a custom `_redirects` rule fighting Cloudflare Pages' automatic
`.html`-stripping behavior). Run first, after every deploy — it takes
seconds and would have caught that regression immediately.

```bash
for path in / menu.html catering-events.html about.html location.html contact.html \
            menu catering events about location contact; do
  echo "=== /$path ==="
  curl -sIL "https://www.shibamatlanta.com/$path" | grep -E '^HTTP|^location' -i
done
```

- [ ] Every URL resolves in **2 hops or fewer**.
- [ ] Every chain ends in `HTTP/2 200`.
- [ ] No URL in any chain repeats (that's a loop in progress, even if it
      hasn't yet errored out).

## 2. Primary navigation

- [ ] Desktop: every header link (Home, Menu, Catering & Events, About,
      Location, Contact) on every page loads the correct page.
- [ ] Desktop: every footer link (same six pages, plus Privacy Policy,
      Terms) loads correctly.
- [ ] Mobile (viewport ≤768px): tapping the hamburger opens the nav,
      `aria-expanded` flips to `true`; tapping a link closes it and
      navigates; tapping the hamburger again closes it without
      navigating.

## 3. Config-driven CTAs

(`js/config.js` values, applied at runtime by `applyConfigLinks()` in
`js/script.js`)

- [ ] "Order Online" / "Order Now" buttons open `CONFIG.ONLINE_ORDER_URL`
      (currently `https://shibamcoffee.appfront.app/`) — not `#`.
- [ ] "Get Directions" opens `CONFIG.GOOGLE_MAPS_URL`.
- [ ] App Store badge opens `CONFIG.APP_STORE_URL`.
- [ ] Google Play badge opens `CONFIG.GOOGLE_PLAY_URL`.
- [ ] Instagram / TikTok / Facebook footer icons open their configured
      URLs.
- [ ] None of the above resolve to `href="#"` — that means
      `isConfigured()` is rejecting a value that should have been valid
      (check for a typo or missing `https://` in `config.js`).

## 4. Location page

- [ ] The map `<iframe>` (`data-config-src="GOOGLE_MAPS_EMBED_SRC"`)
      renders an actual interactive map — not blank, not a broken-embed
      error page.
- [ ] Inspect the iframe's resolved `src` attribute in devtools: it must
      be a real `https://` URL, never the literal string
      `REPLACE_WITH_EMBED_URL`.

## 5. Menu page

- [ ] Each of the 8 category tabs (Traditional Yemeni, Specialty Lattes,
      Iced Coffee, Iced Matcha, Iced Refreshers, Classic Espresso,
      Non-Caffeinated, Desserts & Pastries) scrolls to a section that
      lands fully below both the sticky header and the sticky tab bar —
      not partially hidden behind either.
- [ ] Mobile hamburger menu opens/closes correctly on this page too.

## 6. Forms (Catering inquiry, Contact)

- [ ] If `CATERING_FORM_ENDPOINT` / `CONTACT_FORM_ENDPOINT` in
      `js/config.js` are still `"YOUR_FORM_ENDPOINT"`: submitting shows
      "This form isn't connected yet — please call us at
      (470) 359-6586 instead." and does **not** attempt a network
      request.
- [ ] Once a real endpoint is configured: submitting shows "Sending…",
      then either the success message + form reset, or the error
      message + phone number — never a silent failure or stuck "Sending…"
      state.

## 7. Images

- [ ] Any `<img>` whose file is missing from `/images/` self-removes
      (via `onerror`) leaving the warm gradient background — no
      broken-image icon anywhere on the site.
- [ ] Once real photos are added: spot-check at least the home hero,
      one menu item card, and one about-page gallery photo render at
      the correct aspect ratio with no layout shift/overflow.

## 8. Tracking

- [ ] Open devtools console, run `window.dataLayer`, click a CTA with a
      `data-cta` attribute (e.g. an "Order Online" button), confirm a
      new entry appears with the right `event`, `cta_id`, and `cta_text`.

## 9. SEO basics

- [ ] Each page has a unique `<title>` and `<meta name="description">`.
- [ ] Each page's `<script type="application/ld+json">` parses as valid
      JSON (paste into devtools: `JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)`).
- [ ] Every `<loc>` in `sitemap.xml` resolves to `200` (covered by §1).

## 10. Console hygiene

- [ ] Load every page with devtools open; zero JS errors in the
      console on initial load, after opening/closing the mobile nav, and
      after submitting a form.

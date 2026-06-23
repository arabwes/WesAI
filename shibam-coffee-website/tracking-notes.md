# Tracking Notes — Shibam Coffee Atlanta

How analytics and advertising tracking is wired up across this site, and
how to extend it. Everything funnels through one Google Tag Manager (GTM)
container — no analytics or pixel code is hardcoded into the HTML.

## 1. Where the GTM ID lives and how to update it

The GTM container ID is a single value: `CONFIG.GTM_ID` in `js/config.js`.

```js
GTM_ID: "GTM-XXXXXXX",
```

Every page loads `js/config.js` synchronously in `<head>`, immediately
before the GTM bootstrap snippet, so the snippet can read `CONFIG.GTM_ID`
as a real variable when it fires:

```html
<script src="/js/config.js"></script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer',CONFIG.GTM_ID);</script>
```

There's also a `<noscript>` fallback immediately after `<body>` on every
page, for visitors with JavaScript disabled:

```html
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-XXXXXXX"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
```

**Important:** the noscript fallback cannot read `config.js` (JS is off by
definition when it renders), so its `id=GTM-XXXXXXX` is a literal string.
Whenever you change `CONFIG.GTM_ID`, you must also find-and-replace the
literal `GTM-XXXXXXX` in this noscript tag across all 8 HTML files:

```bash
grep -rl 'GTM-XXXXXXX' . | xargs sed -i 's/GTM-XXXXXXX/GTM-YOUR-REAL-ID/g'
```

## 2. How to publish a GA4 tag via GTM

1. In GTM, go to **Variables** → add a new **Constant** variable (e.g.
   `GA4 Measurement ID`) with your `G-XXXXXXXXXX` value, or paste it
   directly into the tag below.
2. **Tags** → **New** → **Google Analytics: GA4 Configuration**.
   - Measurement ID: your `G-XXXXXXXXXX`.
   - Trigger: **All Pages** (Initialization or Page View).
3. Publish the container. No site code changes are required — GA4 starts
   tracking pageviews immediately once the container with this tag is live.
4. For CTA clicks (Order Online, directions, calls, etc.), add a **GA4
   Event** tag per dataLayer event in section 6 below, triggered on a
   **Custom Event** trigger matching the specific `data-cta` value you
   want to track (e.g. `order_online_click`) — see section 6 for the
   full list of event names pushed to `dataLayer`.

## 3. How to add Meta Pixel via GTM

1. **Tags** → **New** → **Custom HTML**, paste Meta's base pixel code
   (PageView), or use the **Facebook Pixel** template from the GTM
   Community Template Gallery.
2. Trigger: **All Pages**.
3. For custom events (e.g. `Lead` on form submission), add a second
   Custom HTML tag firing `fbq('track', 'Lead')`, triggered on the
   **Custom Event** trigger for `contact_form_submit` or
   `catering_form_submit` (these fire when the form's submit button is
   clicked — see section 6).
4. Publish. Verify with the Meta Pixel Helper browser extension.

## 4. How to add TikTok Pixel via GTM

1. **Tags** → **New** → **Custom HTML**, paste the TikTok base pixel code,
   or use the **TikTok Pixel** template from the GTM Community Template
   Gallery if available in your account.
2. Trigger: **All Pages**.
3. For custom events (e.g. `SubmitForm`), add a Custom HTML tag calling
   `ttq.track('SubmitForm')`, triggered on the same `contact_form_submit`
   / `catering_form_submit` custom events used for Meta above.
4. Publish. Verify with TikTok's Pixel Helper extension.

## 5. How to add Microsoft Clarity via GTM

1. **Tags** → **New** → **Custom HTML**, paste your Clarity project's
   tracking snippet (from clarity.microsoft.com → Settings → Setup →
   Install tracking code).
2. Trigger: **All Pages**.
3. Publish. Session recordings and heatmaps appear in the Clarity
   dashboard within a few minutes — no further site changes needed.

## 6. dataLayer event reference

Every element with a `data-cta` attribute is wired to a single global
click listener in `js/script.js` (`initCtaTracking()`). On click, it
pushes the element's own `data-cta` value as the dataLayer **event
name** — so each row below is both the attribute value *and* the GTM
trigger's Custom Event name:

```js
window.dataLayer.push({
  event: cta.dataset.cta,   // e.g. 'order_online_click'
  cta_id: cta.id,
  cta_text: cta.innerText || cta.getAttribute('aria-label')
});
```

`catering_form_submit` / `contact_form_submit` live on the form's submit
**button**, so they fire on click the same way every other CTA does —
they signal that a visitor attempted a submission, not that the
fetch() to the form endpoint necessarily succeeded.

All `data-cta` values currently in use, and where they fire:

| `data-cta` value | Fires on | Pages |
|---|---|---|
| `order_online_click` | Nav "Order Online", footer link, page CTAs | All pages |
| `directions_click` | "Get Directions" buttons | index, location, about |
| `phone_click` | "Call Us" / tel: links | index, location, contact, catering-events |
| `menu_view_click` | "View Menu" buttons | index, location, about |
| `catering_inquiry_click` | "Catering & Events" / "Request a Quote" buttons | index, location, contact, catering-events |
| `contact_click` | "Contact Us" buttons | location |
| `social_instagram_click` | Instagram icon links | All pages |
| `social_tiktok_click` | TikTok icon links | All pages |
| `social_facebook_click` | Facebook icon links | All pages |
| `app_download_ios` | App Store badge links | All pages |
| `app_download_android` | Google Play badge links | All pages |
| `catering_form_submit` | Catering form submit button clicked | catering-events |
| `contact_form_submit` | Contact form submit button clicked | contact |

To track a new CTA: add `id="cta-..."` and `data-cta="..."` to the
element in HTML — no JS changes needed, the global listener picks it up
automatically.

## 7. UTM parameter guide

Use UTM-tagged links on every external channel so traffic sources show up
distinctly in GA4. Replace `[SITE_URL]` with the live domain.

| Channel | Example URL |
|---|---|
| Google Business Profile | `[SITE_URL]/?utm_source=google&utm_medium=organic&utm_campaign=gbp` |
| Instagram bio | `[SITE_URL]/?utm_source=instagram&utm_medium=social&utm_campaign=bio` |
| TikTok bio | `[SITE_URL]/?utm_source=tiktok&utm_medium=social&utm_campaign=bio` |
| In-store QR (table sign) | `[SITE_URL]/?utm_source=store&utm_medium=qr&utm_campaign=table_sign` |
| Catering flyer QR | `[SITE_URL]/catering-events.html?utm_source=flyer&utm_medium=qr&utm_campaign=catering` |

Conventions:
- `utm_source`: where the link is posted (google, instagram, tiktok, store, flyer).
- `utm_medium`: the channel type (organic, social, qr, email, paid).
- `utm_campaign`: the specific initiative (gbp, bio, table_sign, catering).
- Keep campaign names lowercase with underscores for consistency in GA4 reports.
- Internal CTA links on the site itself (nav, footer, in-page buttons) do
  **not** need UTM params — those are first-party navigation, not
  inbound-traffic attribution. UTMs are only for links posted on
  *external* channels pointing back to this site.

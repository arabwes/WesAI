// /js/config.js
// Shibam Coffee Atlanta — environment configuration
// -----------------------------------------------------------------------------
// Every URL, ID, and endpoint the site needs lives here. No HTML or JS file
// should ever hardcode a third-party URL or tracking ID — they all read from
// window.CONFIG at runtime. Update the values below before deploying, then
// see /README.md and /tracking-notes.md for what each one controls.
// -----------------------------------------------------------------------------

const CONFIG = {
  // Google Tag Manager container ID. Drives GA4, Meta Pixel, and TikTok
  // Pixel — see /tracking-notes.md. Also update the <noscript> fallback
  // GTM ID in each HTML file's <body> to match this value.
  GTM_ID: "GTM-XXXXXXX",

  // Where "Order Online" CTAs send customers.
  ONLINE_ORDER_URL: "https://shibamcoffee.appfront.app/",

  // "Get Directions" CTA destination.
  GOOGLE_MAPS_URL: "https://maps.google.com/?q=4000+North+Point+Pkwy+Suite+900+Alpharetta+GA+30022",

  // Embeddable Google Maps iframe src (key-less embed built from the
  // address above). Generate via Google Maps → Share → Embed a map →
  // copy the src URL from the <iframe> snippet if you want the
  // official API-keyed embed instead.
  GOOGLE_MAPS_EMBED_SRC: "https://www.google.com/maps?q=4000+North+Point+Pkwy+Suite+900+Alpharetta+GA+30022&output=embed",

  // Social profiles.
  INSTAGRAM_URL: "https://www.instagram.com/shibamatlanta/",
  TIKTOK_URL: "https://www.tiktok.com/@shibamatlanta",
  FACEBOOK_URL: "https://www.facebook.com/ShibamCoffee",

  // Order-ahead / rewards app (Appfront).
  APP_STORE_URL: "https://apps.apple.com/us/app/shibam-coffee-co/id6739554858",
  GOOGLE_PLAY_URL: "https://play.google.com/store/apps/details?id=ai.appfront.shibamcoffee",

  // Form submission endpoints (Formspree, Netlify Forms, or any service
  // that accepts a POST with FormData and an Accept: application/json
  // header). Replace before launch — forms will not deliver mail until
  // these are set.
  CATERING_FORM_ENDPOINT: "YOUR_FORM_ENDPOINT",
  CONTACT_FORM_ENDPOINT: "YOUR_FORM_ENDPOINT",

  // Geo coordinates for GBP matching, kept here as the source of truth.
  // The CafeOrCoffeeShop JSON-LD on every page is static HTML (so
  // crawlers see it without running JS) and hardcodes these same
  // values directly — if you update GEO_LAT/GEO_LNG here, also update
  // the "geo" block in every HTML file's JSON-LD to match. Pull exact
  // values from the Google Business Profile listing, not an approximation.
  GEO_LAT: "34.0432",
  GEO_LNG: "-84.2778",

  // Reference value for CafeOrCoffeeShop structured data. Like GEO_LAT/
  // GEO_LNG above, the JSON-LD "priceRange" is static per page — update
  // both here and in every HTML file's JSON-LD if pricing tier changes.
  PRICE_RANGE: "$$"
};

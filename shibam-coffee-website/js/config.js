// /js/config.js
// Shibam Coffee Atlanta — environment configuration
// -----------------------------------------------------------------------------
// Every URL, ID, and endpoint the site needs lives here. No HTML or JS file
// should ever hardcode a third-party URL or tracking ID — they all read from
// window.CONFIG at runtime. Update the values below before deploying, then
// see /README.md and /tracking-notes.md for what each one controls.
// -----------------------------------------------------------------------------

const CONFIG = {
  // Set to a real Google Tag Manager container ID to enable tracking.
  GTM_ID: "",

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

  // Contact messages are stored in D1 and visible to leads in the team portal.
  CONTACT_FORM_ENDPOINT: "/api/contact-request",

  // Catering quote requests post to the site's own Pages Function, which
  // stores them in the shibam-team D1 database for the team portal to
  // read — no third-party form service involved.
  CATERING_FORM_ENDPOINT: "/api/catering-request",

  // Google Form for job applications. NOTE: this form's sharing setting
  // must be "Anyone with the link" / sign-in not required, or applicants
  // get bounced to a Google account login instead of the application.
  JOIN_TEAM_FORM_URL: "https://forms.gle/ppJVGfhi41yvguzK7"
};

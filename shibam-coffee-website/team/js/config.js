// /team/js/config.js
// Shibam Coffee Atlanta — employee portal configuration
// -----------------------------------------------------------------------------
// All four endpoints point at the same Google Apps Script Web App URL; the
// script routes each submission to the right sheet tab using the formType
// field in the payload. See /team/README.md for the deployment steps.
// -----------------------------------------------------------------------------

const CONFIG = {
  INVENTORY_FORM_ENDPOINT: "YOUR_FORM_ENDPOINT",
  DESSERT_DAILY_ENDPOINT: "YOUR_FORM_ENDPOINT",
  DESSERT_ORDER_ENDPOINT: "YOUR_FORM_ENDPOINT",
  LOCAL_ORDER_ENDPOINT: "YOUR_FORM_ENDPOINT",

  STORE_NAME: "Shibam Coffee Atlanta"
};

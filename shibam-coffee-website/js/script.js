// /js/script.js
// Shibam Coffee Atlanta — shared site behavior.
// Loaded on every page after /js/config.js. No dependencies, no build step.

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    applyConfigLinks();
    initNavToggle();
    initStickyHeaderShadow();
    initCtaTracking();
    initForms();
  });

  // ---------------------------------------------------------------------
  // Config-driven links — every CTA that points at an environment-specific
  // URL (ordering platform, maps, socials, app stores) declares
  // data-config-href="SOME_CONFIG_KEY" instead of a hardcoded href, so
  // updating /js/config.js is the only place a URL ever needs to change.
  // Optional data-utm="utm_source=x&utm_medium=y" appends tracking params.
  // ---------------------------------------------------------------------
  function isConfigured(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
  }

  function applyConfigLinks() {
    if (typeof CONFIG === 'undefined') return;

    document.querySelectorAll('[data-config-href]').forEach(function (el) {
      var key = el.getAttribute('data-config-href');
      var base = CONFIG[key];
      if (!isConfigured(base)) return;

      var utm = el.getAttribute('data-utm');
      if (utm) {
        var joiner = base.indexOf('?') === -1 ? '?' : '&';
        base = base + joiner + utm;
      }
      el.setAttribute('href', base);
    });

    document.querySelectorAll('[data-config-src]').forEach(function (el) {
      var key = el.getAttribute('data-config-src');
      var value = CONFIG[key];
      if (isConfigured(value)) el.setAttribute('src', value);
    });
  }

  // ---------------------------------------------------------------------
  // Mobile nav toggle. CSS handles the checkbox-driven open/close state;
  // this only keeps aria-expanded in sync and closes the menu after a
  // link is tapped, for browsers/assistive tech relying on JS state.
  // ---------------------------------------------------------------------
  function initNavToggle() {
    var checkbox = document.getElementById('nav-toggle-checkbox');
    var toggle = document.getElementById('nav-toggle');
    var links = document.querySelector('.nav-links');
    if (!checkbox || !toggle || !links) return;

    checkbox.addEventListener('change', function () {
      toggle.setAttribute('aria-expanded', checkbox.checked ? 'true' : 'false');
    });

    links.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        checkbox.checked = false;
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ---------------------------------------------------------------------
  // Adds a subtle shadow to the sticky header once the page has scrolled.
  // ---------------------------------------------------------------------
  function initStickyHeaderShadow() {
    var header = document.getElementById('site-header');
    if (!header) return;

    function onScroll() {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    }

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------------------------------------------------------------------
  // Global CTA → dataLayer bridge. Every tracked element carries a
  // data-cta value (see README + tracking-notes.md for the full table);
  // GTM triggers fire off these dataLayer events.
  // ---------------------------------------------------------------------
  function initCtaTracking() {
    document.addEventListener('click', function (e) {
      var cta = e.target.closest('[data-cta]');
      if (cta && window.dataLayer) {
        window.dataLayer.push({
          event: cta.dataset.cta,
          cta_id: cta.id,
          cta_text: cta.innerText || cta.getAttribute('aria-label')
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Form submission — posts as FormData to the endpoint configured in
  // CONFIG (Formspree / Netlify Forms compatible) and shows an inline
  // status message instead of navigating away.
  // ---------------------------------------------------------------------
  function initForms() {
    bindForm('catering-inquiry-form', 'CATERING_FORM_ENDPOINT');
    bindForm('contact-inquiry-form', 'CONTACT_FORM_ENDPOINT');
  }

  function bindForm(formId, configKey) {
    var form = document.getElementById(formId);
    if (!form || typeof CONFIG === 'undefined') return;

    var status = form.querySelector('[data-form-status]');
    var endpoint = CONFIG[configKey];

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      if (!endpoint || endpoint === 'YOUR_FORM_ENDPOINT') {
        setStatus(status, 'error', 'This form isn’t connected yet — please call us at (470) 359-6586 instead.');
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      setStatus(status, null, 'Sending…');

      fetch(endpoint, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: new FormData(form)
      })
        .then(function (response) {
          if (response.ok) {
            setStatus(status, 'success', 'Thanks — we’ve received your message and will be in touch shortly.');
            form.reset();
          } else {
            setStatus(status, 'error', 'Something went wrong sending that. Please call us at (470) 359-6586.');
          }
        })
        .catch(function () {
          setStatus(status, 'error', 'Something went wrong sending that. Please call us at (470) 359-6586.');
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  }

  function setStatus(el, state, message) {
    if (!el) return;
    el.textContent = message;
    if (state) {
      el.setAttribute('data-state', state);
    } else {
      el.removeAttribute('data-state');
    }
  }
})();

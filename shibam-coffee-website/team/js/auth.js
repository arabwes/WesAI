// /team/js/auth.js
// Shibam Coffee Atlanta — employee portal session & role handling.
// Loaded on every /team/ page. Runs its redirect check immediately (not on
// DOMContentLoaded) so a logged-out visitor never sees protected content
// flash before being sent to the login page.

(function () {
  'use strict';

  var STORAGE_KEY = 'shibam_team_session';
  var ROLE_RANK = { barista: 1, lead: 2, management: 3 };
  var SESSION_HOURS = 12;

  function getSession() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      var session = JSON.parse(raw);
      if (!session.expiresAt || new Date(session.expiresAt).getTime() < Date.now()) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return session;
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
  }

  function hasRole(session, minRole) {
    return !!session && ROLE_RANK[session.role] >= ROLE_RANK[minRole];
  }

  // ---------------------------------------------------------------------
  // Page guard — reads <body data-page> / data-require-role> and redirects
  // before first paint finishes. data-page="login" bounces an already-
  // logged-in visitor straight to the dashboard instead of showing the form.
  // ---------------------------------------------------------------------
  var page = document.body.getAttribute('data-page');
  var requiredRole = document.body.getAttribute('data-require-role');
  var currentSession = getSession();

  if (page === 'login') {
    if (currentSession) window.location.replace('/team/dashboard.html');
  } else if (requiredRole) {
    if (!currentSession) {
      window.location.replace('/team/');
    } else if (!hasRole(currentSession, requiredRole)) {
      window.location.replace('/team/dashboard.html');
    }
  }

  // ---------------------------------------------------------------------
  // Backend calls — every action goes through the same Apps Script POST
  // endpoint; the session token rides in the JSON body (not a header,
  // to avoid triggering a CORS preflight Apps Script can't answer).
  // ---------------------------------------------------------------------
  function apiCall(action, body) {
    var session = getSession();
    var payload = Object.assign({ action: action }, body || {});
    if (session) payload.token = session.token;

    return fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        if (result && result.ok === false && result.error === 'session_expired') {
          localStorage.removeItem(STORAGE_KEY);
          window.location.replace('/team/');
        }
        return result;
      });
  }

  function logout() {
    var session = getSession();
    localStorage.removeItem(STORAGE_KEY);
    if (session) apiCall('logout', { token: session.token }).catch(function () {});
    window.location.href = '/team/';
  }

  // ---------------------------------------------------------------------
  // Shows/hides any [data-role="lead"] / [data-role="management"] element
  // based on the current session — additive, so a "lead" element also
  // shows for management. Fills [data-session-name] / [data-session-role].
  // ---------------------------------------------------------------------
  function applyRoleVisibility() {
    var session = getSession();
    document.querySelectorAll('[data-role]').forEach(function (el) {
      el.hidden = !hasRole(session, el.getAttribute('data-role'));
    });
    document.querySelectorAll('[data-session-name]').forEach(function (el) {
      el.textContent = session ? session.name : '';
    });
    document.querySelectorAll('[data-session-role]').forEach(function (el) {
      el.textContent = session ? session.role : '';
    });
  }

  // ---------------------------------------------------------------------
  // Login form — only present on index.html, but auth.js is loaded there
  // too, so it's handled here rather than a separate file.
  // ---------------------------------------------------------------------
  function bindLoginForm(form) {
    var status = form.querySelector('[data-form-status]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var username = form.username.value.trim();
      var password = form.password.value;

      if (!username || !password) {
        setStatus(status, 'error', 'Enter your username and password.');
        return;
      }

      var submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      setStatus(status, null, 'Logging in…');

      fetch(CONFIG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'login', username: username, password: password })
      })
        .then(function (res) { return res.json(); })
        .then(function (result) {
          if (result.ok) {
            var expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
              token: result.token,
              role: result.role,
              name: result.name,
              username: result.username,
              expiresAt: expiresAt
            }));
            window.location.href = '/team/dashboard.html';
          } else {
            setStatus(status, 'error', 'Incorrect username or password.');
            submitBtn.disabled = false;
          }
        })
        .catch(function () {
          setStatus(status, 'error', 'Could not reach the server — check your connection and try again.');
          submitBtn.disabled = false;
        });
    });
  }

  function setStatus(el, state, message) {
    if (!el) return;
    el.textContent = message;
    if (state) el.setAttribute('data-state', state); else el.removeAttribute('data-state');
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyRoleVisibility();

    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    var loginForm = document.getElementById('login-form');
    if (loginForm) bindLoginForm(loginForm);
  });

  window.Auth = {
    getSession: getSession,
    hasRole: hasRole,
    apiCall: apiCall,
    logout: logout,
    applyRoleVisibility: applyRoleVisibility
  };
})();

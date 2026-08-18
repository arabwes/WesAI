// /team/js/auth.js
// Shibam Coffee Atlanta — employee portal session & role handling.
// Loaded on every /team/ page. Runs its redirect check immediately (not on
// DOMContentLoaded) so a logged-out visitor never sees protected content
// flash before being sent to the login page.

(function () {
  'use strict';

  var STORAGE_KEY = 'shibam_team_session';
  var REDIRECT_GUARD_KEY = 'shibam_team_redirect_guard';
  var REDIRECT_LIMIT = 4;
  var REDIRECT_WINDOW_MS = 5000;
  var ROLE_RANK = { barista: 1, lead: 2, management: 3 };
  var SESSION_HOURS = 12;

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function getSession() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      var session = JSON.parse(raw);
      // A session missing its token/role isn't just expired, it's
      // malformed — treat it as logged-out rather than trusting a
      // partial object. This is what let a misbehaving backend response
      // (ok:true with no role) create a session that looked logged-in
      // but could never pass a role check — see guardedRedirect below.
      if (!session.token || !ROLE_RANK[session.role]) {
        clearSession();
        return null;
      }
      if (!session.expiresAt || new Date(session.expiresAt).getTime() < Date.now()) {
        clearSession();
        return null;
      }
      return session;
    } catch (e) {
      clearSession();
      return null;
    }
  }

  function hasRole(session, minRole) {
    return !!session && ROLE_RANK[session.role] >= ROLE_RANK[minRole];
  }

  // Every guard redirect goes through here — two independent safety nets:
  //  1. Never navigate to the page we're already on. A same-page redirect
  //     reloads, re-runs this exact guard against the same state, and
  //     redirects again — forever. (This is exactly what froze the page:
  //     a malformed session made dashboard.html's role check fail, and
  //     its fallback target was dashboard.html itself.)
  //  2. A short-lived attempt counter that trips if redirects happen too
  //     fast for any other reason, so a different future bug can't
  //     reproduce the same kind of loop.
  function guardedRedirect(url) {
    var targetPath = url.split('?')[0].split('#')[0];
    if (targetPath === window.location.pathname) {
      url = '/team/';
      clearSession();
    }

    var now = Date.now();
    var raw = sessionStorage.getItem(REDIRECT_GUARD_KEY);
    var state = null;
    try { state = raw ? JSON.parse(raw) : null; } catch (e) { state = null; }
    if (!state || now - state.firstAt > REDIRECT_WINDOW_MS) {
      state = { count: 0, firstAt: now };
    }
    state.count += 1;
    sessionStorage.setItem(REDIRECT_GUARD_KEY, JSON.stringify(state));

    if (state.count > REDIRECT_LIMIT) {
      sessionStorage.removeItem(REDIRECT_GUARD_KEY);
      clearSession();
      showRedirectLoopError();
      return;
    }

    window.location.replace(url);
  }

  function clearRedirectGuard() {
    sessionStorage.removeItem(REDIRECT_GUARD_KEY);
  }

  function showRedirectLoopError() {
    document.title = 'Login problem — Shibam Coffee Atlanta';
    document.body.innerHTML =
      '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;line-height:1.6;color:#1A0F00;">' +
      '<h1 style="font-size:1.4rem;">Something went wrong</h1>' +
      '<p>The team portal hit a login problem and stopped itself instead of reloading forever. You have been logged out.</p>' +
      '<p><a href="/team/">Try logging in again</a>. If this keeps happening, tell a manager the backend may need to be redeployed.</p>' +
      '</div>';
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
    if (currentSession) {
      guardedRedirect('/team/dashboard.html');
    } else {
      clearRedirectGuard();
    }
  } else if (requiredRole) {
    if (!currentSession) {
      guardedRedirect('/team/');
    } else if (!hasRole(currentSession, requiredRole)) {
      guardedRedirect('/team/dashboard.html');
    } else {
      clearRedirectGuard();
    }
  } else {
    clearRedirectGuard();
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
          clearSession();
          guardedRedirect('/team/');
        }
        return result;
      });
  }

  function logout() {
    var session = getSession();
    clearSession();
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
          // A real login response always has a token and a recognized
          // role. `ok:true` alone isn't enough to trust — a stale or
          // misconfigured backend deployment can return `{ok:true}` with
          // neither, which used to store a broken "logged in" session
          // that could never pass a role check anywhere in the portal.
          if (result.ok && result.token && ROLE_RANK[result.role]) {
            var expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
              token: result.token,
              role: result.role,
              name: result.name,
              username: result.username,
              expiresAt: expiresAt
            }));
            window.location.href = '/team/dashboard.html';
          } else if (result.ok) {
            setStatus(status, 'error', 'Login isn’t responding correctly — tell a manager the backend may need to be redeployed.');
            submitBtn.disabled = false;
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

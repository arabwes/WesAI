// /team/js/auth.js
// Shared session, role, API, and login behavior for the employee portal.
// Authentication is enforced by the Cloudflare API's HttpOnly session cookie;
// localStorage holds display-only profile data for fast page guards.

(function () {
  'use strict';

  var STORAGE_KEY = 'shibam_team_profile';
  var LEGACY_STORAGE_KEY = 'shibam_team_session';
  var REDIRECT_GUARD_KEY = 'shibam_team_redirect_guard';
  var REDIRECT_LIMIT = 4;
  var REDIRECT_WINDOW_MS = 5000;
  var ROLE_RANK = { barista: 1, lead: 2, management: 3 };
  var turnstileWidgetId = null;

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }

  function storeSession(result) {
    var session = {
      id: result.id,
      username: result.username,
      name: result.name,
      email: result.email || '',
      role: result.role,
      expiresAt: result.expiresAt
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  function getSession() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      var session = JSON.parse(raw);
      if (!session.id || !session.name || !ROLE_RANK[session.role] ||
          !session.expiresAt || new Date(session.expiresAt).getTime() < Date.now()) {
        clearSession();
        return null;
      }
      return session;
    } catch (error) {
      clearSession();
      return null;
    }
  }

  function hasRole(session, minimumRole) {
    return !!session && ROLE_RANK[session.role] >= ROLE_RANK[minimumRole];
  }

  function guardedRedirect(url) {
    var targetPath = url.split('?')[0].split('#')[0];
    if (targetPath === window.location.pathname) {
      url = '/team/';
      clearSession();
    }
    var now = Date.now();
    var state = null;
    try { state = JSON.parse(sessionStorage.getItem(REDIRECT_GUARD_KEY)); } catch (error) { state = null; }
    if (!state || now - state.firstAt > REDIRECT_WINDOW_MS) state = { count: 0, firstAt: now };
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

  function showRedirectLoopError() {
    document.title = 'Login problem — Shibam Coffee Atlanta';
    document.body.innerHTML =
      '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;line-height:1.6;color:#1A0F00;">' +
      '<h1 style="font-size:1.4rem;">Something went wrong</h1>' +
      '<p>The team portal stopped a login redirect loop and signed you out.</p>' +
      '<p><a href="/team/">Try logging in again</a>.</p></div>';
  }

  var page = document.body.getAttribute('data-page');
  var requiredRole = document.body.getAttribute('data-require-role');
  var currentSession = getSession();
  if (page === 'login') {
    if (currentSession) guardedRedirect('/team/dashboard.html');
    else sessionStorage.removeItem(REDIRECT_GUARD_KEY);
  } else if (requiredRole) {
    if (!currentSession) guardedRedirect('/team/');
    else if (!hasRole(currentSession, requiredRole)) guardedRedirect('/team/dashboard.html');
    else sessionStorage.removeItem(REDIRECT_GUARD_KEY);
  }

  function apiCall(action, body) {
    return fetch(CONFIG.API_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'invalid_server_response' }; });
    }).then(function (result) {
      if (result && result.ok === false && result.error === 'session_expired') {
        clearSession();
        guardedRedirect('/team/');
      }
      return result;
    });
  }

  function logout() {
    fetch(CONFIG.API_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logout' })
    }).catch(function () {}).finally(function () {
      clearSession();
      window.location.href = '/team/';
    });
  }

  function applyRoleVisibility() {
    var session = getSession();
    document.querySelectorAll('[data-role]').forEach(function (element) {
      element.hidden = !hasRole(session, element.getAttribute('data-role'));
    });
    document.querySelectorAll('[data-session-name]').forEach(function (element) {
      element.textContent = session ? session.name : '';
    });
    document.querySelectorAll('[data-session-role]').forEach(function (element) {
      element.textContent = session ? session.role : '';
    });
  }

  function getTurnstileToken() {
    var field = document.querySelector('[name="cf-turnstile-response"]');
    return field ? field.value : '';
  }

  function resetTurnstile() {
    if (window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  }

  function initTurnstile() {
    var mount = document.getElementById('turnstile-widget');
    if (!mount || !CONFIG.TURNSTILE_SITEKEY) return;
    mount.hidden = false;
    var render = function () {
      if (window.turnstile) {
        turnstileWidgetId = window.turnstile.render(mount, {
          sitekey: CONFIG.TURNSTILE_SITEKEY,
          theme: 'light'
        });
      }
    };
    if (window.turnstile) render();
    else window.addEventListener('load', render, { once: true });
  }

  function bindLoginForm(form) {
    var status = form.querySelector('[data-form-status]');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var username = form.username.value.trim();
      var password = form.password.value;
      if (!username || !password) {
        setStatus(status, 'error', 'Enter your username and password.');
        return;
      }
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      setStatus(status, null, 'Logging in…');
      fetch(CONFIG.API_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'login',
          username: username,
          password: password,
          turnstileToken: getTurnstileToken()
        })
      }).then(function (response) {
        return response.json();
      }).then(function (result) {
        if (result.ok && result.id && ROLE_RANK[result.role]) {
          storeSession(result);
          window.location.href = '/team/dashboard.html';
          return;
        }
        var messages = {
          too_many_attempts: 'Too many login attempts. Wait 15 minutes and try again.',
          turnstile_required: 'Complete the security check and try again.',
          turnstile_failed: 'The security check expired. Try again.'
        };
        setStatus(status, 'error', messages[result.error] || 'Incorrect username or password.');
        button.disabled = false;
        resetTurnstile();
      }).catch(function () {
        setStatus(status, 'error', 'Could not reach the server — check your connection and try again.');
        button.disabled = false;
        resetTurnstile();
      });
    });
  }

  function setStatus(element, state, message) {
    if (!element) return;
    element.textContent = message;
    if (state) element.setAttribute('data-state', state);
    else element.removeAttribute('data-state');
  }

  function errorMessage(result, fallback) {
    var messages = {
      forbidden: 'You do not have permission to do that.',
      version_conflict: 'Someone else changed this item. Refresh and try again.',
      database_unavailable: 'The team database is temporarily unavailable.',
      server_error: 'The server hit an unexpected problem.'
    };
    return messages[result && result.error] || fallback || 'Something went wrong.';
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyRoleVisibility();
    initTurnstile();
    var logoutButton = document.getElementById('logout-btn');
    if (logoutButton) logoutButton.addEventListener('click', logout);
    var loginForm = document.getElementById('login-form');
    if (loginForm) bindLoginForm(loginForm);
  });

  window.Auth = {
    getSession: getSession,
    hasRole: hasRole,
    apiCall: apiCall,
    logout: logout,
    applyRoleVisibility: applyRoleVisibility,
    errorMessage: errorMessage
  };
})();

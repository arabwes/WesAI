(function () {
  'use strict';
  var state = { settings: null };
  var categories = [['schedule', 'Schedule published or changed'], ['requests', 'Requests and approvals'], ['open_shifts', 'Open shifts'], ['account', 'Account and security']];
  var channels = [['in_app', 'In portal'], ['email', 'Email'], ['push', 'Push'], ['sms', 'SMS']];

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    bindForms();
    loadSettings();
  });

  function loadSettings() {
    Auth.apiCall('getMySettings', {}).then(function (result) {
      if (!result.ok) { status('error', Auth.errorMessage(result, 'Could not load settings.')); return; }
      state.settings = result;
      var form = document.getElementById('profile-form');
      form.name.value = result.user.name;
      form.preferredName.value = result.user.preferredName;
      form.email.value = result.user.email;
      document.getElementById('profile-role').textContent = result.user.role;
      document.getElementById('profile-positions').textContent = result.user.positions.length ? result.user.positions.map(function (position) { return position.name; }).join(', ') : 'None assigned';
      document.getElementById('profile-max-hours').textContent = (result.user.maxWeeklyMinutes / 60) + ' hours';
      document.getElementById('profile-phone').value = result.user.phone;
      document.getElementById('phone-verification-state').textContent = result.user.phoneVerified ? '✓ Verified' : result.user.phone ? 'Not verified' : '';
      renderPreferences(); renderDevices(); renderCalendars();
    });
  }

  function bindForms() {
    document.getElementById('profile-form').addEventListener('submit', function (event) {
      event.preventDefault(); var form = event.currentTarget; setForm(form, null, 'Saving…');
      Auth.apiCall('updateMyProfile', { name: form.name.value, preferredName: form.preferredName.value, email: form.email.value }).then(function (result) {
        if (result.ok) { setForm(form, 'success', 'Profile saved. Sign in again to refresh the header name.'); loadSettings(); }
        else setForm(form, 'error', Auth.errorMessage(result, 'Could not save profile.'));
      });
    });
    document.getElementById('password-form').addEventListener('submit', function (event) {
      event.preventDefault(); var form = event.currentTarget;
      if (form.password.value !== form.confirmPassword.value) { setForm(form, 'error', 'Passwords do not match.'); return; }
      Auth.apiCall('changeMyPassword', { password: form.password.value }).then(function (result) {
        if (result.ok) { window.alert('Password changed. Please sign in again.'); Auth.logout(); }
        else setForm(form, 'error', Auth.errorMessage(result, 'Could not change password.'));
      });
    });
    document.getElementById('phone-form').addEventListener('submit', function (event) {
      event.preventDefault(); var form = event.currentTarget;
      Auth.apiCall('requestPhoneVerification', { phone: form.phone.value }).then(function (result) {
        if (result.ok) { var code = document.getElementById('phone-code-form'); code.hidden = false; code.verificationId.value = result.verificationId; document.getElementById('phone-verification-state').textContent = result.smsConfigured ? 'Code sent' : 'Waiting for SMS setup'; }
        else status('error', Auth.errorMessage(result, 'Could not send a code.'));
      });
    });
    document.getElementById('phone-code-form').addEventListener('submit', function (event) {
      event.preventDefault(); var form = event.currentTarget;
      Auth.apiCall('verifyPhone', { verificationId: form.verificationId.value, code: form.code.value }).then(function (result) {
        if (result.ok) { form.hidden = true; loadSettings(); } else status('error', 'The code is incorrect or expired.');
      });
    });
    document.getElementById('notification-preferences-form').addEventListener('submit', savePreferences);
    document.getElementById('enable-push').addEventListener('click', enablePush);
    document.getElementById('create-calendar').addEventListener('click', createCalendar);
  }

  function renderPreferences() {
    var table = document.getElementById('notification-preferences-table');
    table.innerHTML = '<thead><tr><th>Notification</th>' + channels.map(function (channel) { return '<th>' + channel[1] + '</th>'; }).join('') + '</tr></thead>';
    var body = document.createElement('tbody');
    categories.forEach(function (category) {
      var row = document.createElement('tr'); row.innerHTML = '<th>' + category[1] + '</th>';
      channels.forEach(function (channel) {
        var cell = document.createElement('td'); var input = document.createElement('input'); input.type = 'checkbox'; input.dataset.channel = channel[0]; input.dataset.category = category[0];
        var saved = state.settings.preferences.find(function (item) { return item.channel === channel[0] && item.category === category[0]; });
        input.checked = saved ? saved.enabled : channel[0] === 'in_app' || channel[0] === 'email';
        if (category[0] === 'account' && channel[0] === 'in_app') { input.checked = true; input.disabled = true; }
        cell.appendChild(input); row.appendChild(cell);
      }); body.appendChild(row);
    }); table.appendChild(body);
    var quietPreference = state.settings.preferences.find(function (item) { return item.channel !== 'in_app' && item.quietStart && item.quietEnd; });
    var form = document.getElementById('notification-preferences-form');
    form.quietStart.value = quietPreference ? quietPreference.quietStart : '';
    form.quietEnd.value = quietPreference ? quietPreference.quietEnd : '';
  }

  function savePreferences(event) {
    event.preventDefault(); var form = event.currentTarget;
    if ((form.quietStart.value && !form.quietEnd.value) || (!form.quietStart.value && form.quietEnd.value)) { setForm(form, 'error', 'Enter both quiet-hour times or leave both blank.'); return; }
    var preferences = Array.from(form.querySelectorAll('input[type="checkbox"]')).map(function (input) { return { channel: input.dataset.channel, category: input.dataset.category, enabled: input.checked, quietStart: input.dataset.channel === 'in_app' ? '' : form.quietStart.value, quietEnd: input.dataset.channel === 'in_app' ? '' : form.quietEnd.value }; });
    Auth.apiCall('saveNotificationPreferences', { preferences: preferences }).then(function (result) { setForm(form, result.ok ? 'success' : 'error', result.ok ? 'Preferences saved.' : 'Could not save preferences.'); });
  }

  function enablePush() {
    if (!state.settings.vapidPublicKey) { document.getElementById('push-status').textContent = 'VAPID keys must be configured first.'; return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { document.getElementById('push-status').textContent = 'Push is not supported by this browser.'; return; }
    navigator.serviceWorker.register('/team/sw.js').then(function (registration) {
      return Notification.requestPermission().then(function (permission) {
        if (permission !== 'granted') throw new Error('Permission was not granted.');
        return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Key(state.settings.vapidPublicKey) });
      });
    }).then(function (subscription) {
      return Auth.apiCall('registerPushSubscription', { subscription: subscription.toJSON(), deviceLabel: navigator.userAgent.slice(0, 80) });
    }).then(function (result) { if (result.ok) { document.getElementById('push-status').textContent = '✓ Push enabled'; loadSettings(); } }).catch(function (error) { document.getElementById('push-status').textContent = error.message; });
  }

  function base64Key(value) { var padding = '='.repeat((4 - value.length % 4) % 4); var raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(Array.from(raw).map(function (char) { return char.charCodeAt(0); })); }

  function renderDevices() {
    var mount = document.getElementById('push-devices'); mount.innerHTML = '';
    state.settings.pushSubscriptions.forEach(function (device) { var row = item(device.label, 'Added ' + new Date(device.createdAt).toLocaleDateString()); var button = buttonFor('Remove', function () { return Auth.apiCall('removePushSubscription', { subscriptionId: device.id }).then(loadSettings); }); row.appendChild(button); mount.appendChild(row); });
  }

  function createCalendar() {
    Auth.apiCall('createCalendarToken', { label: 'My Shibam Coffee schedule' }).then(function (result) {
      if (!result.ok) return; var wrap = document.getElementById('calendar-new-link'); wrap.hidden = false; wrap.querySelector('input').value = result.url; wrap.querySelector('a').href = result.url;
      wrap.querySelector('button').onclick = function () { navigator.clipboard.writeText(result.url); wrap.querySelector('button').textContent = 'Copied'; }; loadSettings();
    });
  }

  function renderCalendars() {
    var mount = document.getElementById('calendar-list'); mount.innerHTML = '';
    if (!state.settings.calendarTokens.length) mount.appendChild(item('No calendar links', 'Create a private link when you are ready to subscribe.'));
    state.settings.calendarTokens.forEach(function (token) { var row = item(token.label, 'Created ' + new Date(token.createdAt).toLocaleDateString()); row.appendChild(buttonFor('Revoke', function () { return Auth.apiCall('revokeCalendarToken', { tokenId: token.id }).then(loadSettings); })); mount.appendChild(row); });
  }

  function item(title, subtitle) { var row = document.createElement('article'); row.className = 'request-card'; row.innerHTML = '<strong></strong><p></p>'; row.querySelector('strong').textContent = title; row.querySelector('p').textContent = subtitle; return row; }
  function buttonFor(label, handler) { var button = document.createElement('button'); button.type = 'button'; button.className = 'btn-remove-row'; button.textContent = label; button.onclick = function () { button.disabled = true; Promise.resolve(handler()).finally(function () { button.disabled = false; }); }; return button; }
  function setForm(form, kind, message) { var node = form.querySelector('[data-form-status]'); if (!node) return; node.textContent = message; if (kind) node.dataset.state = kind; else delete node.dataset.state; }
  function status(kind, message) { var node = document.getElementById('profile-page-status'); node.textContent = message; node.dataset.state = kind; }
})();

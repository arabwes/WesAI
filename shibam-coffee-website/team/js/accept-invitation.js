(function () {
  'use strict';
  var token = new URLSearchParams(window.location.search).get('token') || '';
  document.addEventListener('DOMContentLoaded', function () {
    var summary = document.getElementById('invitation-summary'); var form = document.getElementById('invitation-form');
    Auth.apiCall('inspectInvitation', { invitationToken: token }).then(function (result) {
      if (!result.ok) { summary.textContent = 'This invitation is invalid, expired, or was revoked. Ask Management for a new invitation.'; return; }
      summary.textContent = result.invitation.name + ', you were invited as ' + result.invitation.role + ' using ' + result.invitation.email + '.'; form.hidden = false;
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault(); var status = form.querySelector('[data-form-status]');
      if (form.password.value !== form.confirm.value) { status.textContent = 'Passwords do not match.'; status.dataset.state = 'error'; return; }
      Auth.apiCall('acceptInvitation', { invitationToken: token, username: form.username.value.trim(), password: form.password.value }).then(function (result) {
        if (result.ok) { form.innerHTML = '<p class="form-status" data-state="success">Account created. <a href="/team/">Sign in to continue.</a></p>'; }
        else { status.textContent = result.error === 'email_or_username_taken' ? 'That username is already in use.' : 'Could not create the account.'; status.dataset.state = 'error'; }
      });
    });
  });
})();


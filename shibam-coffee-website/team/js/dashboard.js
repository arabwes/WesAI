// /team/js/dashboard.js
// Shows a persistent, private reminder when an employee response is pending.

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var alert = document.getElementById('employee-message-alert');
    if (!alert) return;
    Auth.apiCall('getEmployeeMessageSummary', {}).then(function (result) {
      if (!result.ok || !Number(result.pendingCount)) return;
      var count = Number(result.pendingCount);
      document.getElementById('employee-message-alert-title').textContent = count === 1
        ? 'You have 1 employee message to review'
        : 'You have ' + count + ' employee messages to review';
      alert.hidden = false;
    }).catch(function () {
      // The dashboard remains usable if the reminder cannot be loaded.
    });
  });
})();

// /team/js/dashboard.js
// Shows a persistent, private reminder when an employee response is pending.

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var alert = document.getElementById('employee-message-alert');
    if (alert) {
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
    }

    var cateringAlert = document.getElementById('catering-request-alert');
    var session = window.Auth && Auth.getSession();
    if (cateringAlert && session && Auth.hasRole(session, 'lead')) {
      Auth.apiCall('getCateringRequests', { status: 'new' }).then(function (result) {
        if (!result.ok || !Array.isArray(result.requests)) return;
        var fresh = result.requests.length;
        var replies = Number(result.unreadReplies) || 0;
        if (!fresh && !replies) return;
        var parts = [];
        if (fresh) parts.push(fresh === 1 ? 'a new catering request' : fresh + ' new catering requests');
        if (replies) parts.push(replies === 1 ? '1 catering reply to read' : replies + ' catering replies to read');
        document.getElementById('catering-request-alert-title').textContent = 'You have ' + parts.join(' and ');
        cateringAlert.hidden = false;
      }).catch(function () {
        // The dashboard remains usable if the reminder cannot be loaded.
      });
    }

    var contactAlert = document.getElementById('contact-request-alert');
    if (contactAlert && session && Auth.hasRole(session, 'lead')) {
      Auth.apiCall('getContactRequests', { status: 'new' }).then(function (result) {
        if (!result.ok || !Array.isArray(result.requests) || !result.requests.length) return;
        var count = result.requests.length;
        document.getElementById('contact-request-alert-title').textContent = count === 1
          ? 'You have a new contact message'
          : 'You have ' + count + ' new contact messages';
        contactAlert.hidden = false;
      }).catch(function () {
        // The dashboard remains usable if the reminder cannot be loaded.
      });
    }
  });
})();

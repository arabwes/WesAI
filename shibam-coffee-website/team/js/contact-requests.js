(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    var session = Auth.getSession();
    if (session) document.getElementById('session-banner').textContent = 'Logged in as ' + session.name + ' (' + session.role + ')';
    loadRequests();
  });

  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function loadRequests() {
    var mount = document.getElementById('contact-requests-list');
    mount.textContent = 'Loading contact messages…';
    Auth.apiCall('getContactRequests', {}).then(function (result) {
      mount.replaceChildren();
      if (!result.ok || !Array.isArray(result.requests)) throw new Error('Invalid response');
      if (!result.requests.length) {
        mount.textContent = 'No contact messages yet.';
        return;
      }
      var grid = node('div', 'document-grid');
      result.requests.forEach(function (request) { grid.appendChild(requestCard(request)); });
      mount.appendChild(grid);
    }).catch(function () {
      mount.textContent = 'Could not load contact messages. Refresh to try again.';
    });
  }

  function requestCard(request) {
    var card = node('div', 'document-card');
    card.appendChild(node('h4', 'document-card__title', request.name));
    card.appendChild(node('span', 'badge', request.status));
    var contact = node('p', 'document-card__description');
    var email = node('a', null, request.email);
    email.href = 'mailto:' + request.email;
    contact.appendChild(email);
    if (request.phone) {
      contact.appendChild(document.createTextNode(' · '));
      var phone = node('a', null, request.phone);
      phone.href = 'tel:' + request.phone;
      contact.appendChild(phone);
    }
    card.appendChild(contact);
    card.appendChild(node('p', 'document-card__description', request.message));
    card.appendChild(node('p', 'document-card__description', 'Submitted ' + new Date(request.createdAt).toLocaleString()));
    var row = node('div', 'form-group');
    row.appendChild(node('label', null, 'Status'));
    var select = node('select');
    ['new', 'reviewed', 'closed'].forEach(function (status) {
      var option = node('option', null, status);
      option.value = status;
      option.selected = status === request.status;
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      var previous = request.status;
      select.disabled = true;
      Auth.apiCall('updateContactRequestStatus', { requestId: request.id, status: select.value }).then(function (result) {
        if (!result.ok) throw new Error('Update failed');
        request.status = select.value;
        card.querySelector('.badge').textContent = request.status;
      }).catch(function () {
        select.value = previous;
        window.alert('Could not update status. Try again.');
      }).finally(function () { select.disabled = false; });
    });
    row.appendChild(select);
    card.appendChild(row);
    return card;
  }
})();

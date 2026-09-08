// /team/js/catering-requests.js
// Lists catering/event quote requests submitted from the public
// catering-events.html form, with a status control (new/reviewed/closed).

(function () {
  'use strict';

  var STATUSES = ['new', 'reviewed', 'closed'];

  document.addEventListener('DOMContentLoaded', function () {
    setFooterYear();
    renderSessionBanner();
    renderRequests();
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setFooterYear() {
    document.querySelectorAll('#footer-year').forEach(function (n) {
      n.textContent = new Date().getFullYear();
    });
  }

  function renderSessionBanner() {
    var mount = document.getElementById('session-banner');
    if (!mount) return;
    var session = window.Auth && Auth.getSession();
    if (!session) return;
    mount.innerHTML = '';
    mount.appendChild(document.createTextNode('Logged in as '));
    mount.appendChild(el('strong', null, session.name));
    mount.appendChild(document.createTextNode(' '));
    mount.appendChild(el('span', 'badge', session.role));
  }

  function renderRequests() {
    var mount = document.getElementById('catering-requests-list');
    if (!mount) return;
    mount.textContent = 'Loading catering requests…';

    Auth.apiCall('getCateringRequests', {}).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok || !Array.isArray(result.requests)) {
        mount.textContent = 'Could not load catering requests. Refresh to try again.';
        return;
      }
      if (!result.requests.length) {
        mount.textContent = 'No catering requests yet.';
        return;
      }

      var grid = el('div', 'document-grid');
      result.requests.forEach(function (req) { grid.appendChild(buildRequestCard(req)); });
      mount.appendChild(grid);
    }).catch(function () {
      mount.textContent = 'Could not load catering requests. Check your connection and refresh to try again.';
    });
  }

  function buildRequestCard(req) {
    var card = el('div', 'document-card');

    var head = el('div');
    head.appendChild(el('h4', 'document-card__title', req.name));
    head.appendChild(el('span', 'badge', req.status));
    card.appendChild(head);

    var meta = el('p', 'document-card__description');
    var lines = [
      req.eventType,
      req.eventDate ? 'Date: ' + req.eventDate : '',
      req.guestCount ? 'Guests: ' + req.guestCount : ''
    ].filter(Boolean);
    meta.textContent = lines.join(' · ');
    card.appendChild(meta);

    var contact = el('p', 'document-card__description');
    contact.appendChild(el('a', null, req.email));
    contact.appendChild(document.createTextNode(' · '));
    contact.appendChild(el('a', null, req.phone));
    contact.children[0].href = 'mailto:' + req.email;
    contact.children[1].href = 'tel:' + req.phone;
    card.appendChild(contact);

    if (req.details) {
      card.appendChild(el('p', 'document-card__description', req.details));
    }

    card.appendChild(el('p', 'document-card__description', 'Submitted ' + new Date(req.createdAt).toLocaleString()));

    var statusRow = el('div', 'form-group');
    statusRow.appendChild(el('label', null, 'Status'));
    var select = document.createElement('select');
    STATUSES.forEach(function (status) {
      var option = el('option', null, status);
      option.value = status;
      if (status === req.status) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      var previous = req.status;
      select.disabled = true;
      Auth.apiCall('updateCateringRequestStatus', { requestId: req.id, status: select.value }).then(function (result) {
        if (!result.ok) {
          select.value = previous;
          window.alert(Auth.errorMessage ? Auth.errorMessage(result) : 'Could not update status.');
        } else {
          req.status = select.value;
        }
      }).catch(function () {
        select.value = previous;
        window.alert('Could not update status. Check your connection and try again.');
      }).finally(function () {
        select.disabled = false;
      });
    });
    statusRow.appendChild(select);
    card.appendChild(statusRow);

    return card;
  }
})();

// /team/js/catering-requests.js
// Lists catering/event quote requests submitted from the public catering-events.html form,
// with a status control (new/reviewed/closed) and a conversation panel on each request: staff
// reply here, and the customer reads and answers on a private page, so the whole exchange
// stays in the portal. All server text is written with textContent.

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

  function when(iso) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }

  function copyText(text, field, button) {
    field.select();
    var done = function () { button.textContent = 'Copied'; window.setTimeout(function () { button.textContent = 'Copy customer link'; }, 2500); };
    var fallback = function () { try { document.execCommand('copy'); done(); } catch (error) { button.textContent = 'Press Ctrl+C'; } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  // The conversation with this customer: open it, read it, reply, or leave an internal note.
  function buildConversation(req, hooks) {
    var wrap = el('div', 'conversation');
    var label = function () { return 'Conversation' + (req.messageCount ? ' (' + req.messageCount + ')' : ''); };
    var toggle = el('button', 'btn-inline-action', label());
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    var panel = el('div', 'conversation__panel');
    panel.hidden = true;
    var open = false;
    var thread = el('div', 'conversation__thread');
    var linkRow = el('div', 'conversation__link');
    var status = el('p', 'conversation__status');
    status.setAttribute('role', 'status');
    var form = el('form', 'conversation__form');
    var box = el('textarea');
    box.rows = 4;
    box.maxLength = 4000;
    box.required = true;
    box.setAttribute('aria-label', 'Message to ' + req.name);
    box.placeholder = 'Write your reply to ' + req.name + '…';
    var noteLabel = el('label', 'conversation__note-toggle');
    var note = document.createElement('input');
    note.type = 'checkbox';
    noteLabel.appendChild(note);
    noteLabel.appendChild(document.createTextNode(' Internal note (only the team sees this; nothing is sent)'));
    var send = el('button', 'btn btn-small', 'Send reply');
    send.type = 'submit';
    var refresh = el('button', 'btn-inline-action', 'Check for replies');
    refresh.type = 'button';
    var hint = el('p', 'conversation__hint', 'Replies go to ' + req.name + '\'s private page, and they get an email with a link to it. They answer on that page, so everything stays here.');
    form.appendChild(box);
    form.appendChild(noteLabel);
    var actions = el('div', 'conversation__actions');
    actions.appendChild(send);
    actions.appendChild(refresh);
    form.appendChild(actions);
    panel.appendChild(thread);
    panel.appendChild(status);
    panel.appendChild(form);
    panel.appendChild(hint);
    panel.appendChild(linkRow);
    wrap.appendChild(toggle);
    wrap.appendChild(panel);

    function say(text, isError) { status.textContent = text || ''; status.className = 'conversation__status' + (isError ? ' is-error' : ''); }

    function messageNode(message) {
      var item = el('div', 'conv-message conv-message--' + message.kind + (message.unread ? ' is-unread' : ''));
      var head = el('div', 'conv-message__head');
      var who = message.kind === 'note' ? message.authorName + ' (internal note)' : message.kind === 'customer' ? req.name : message.authorName;
      head.appendChild(el('strong', null, who));
      var meta = [when(message.createdAt)];
      if (message.kind === 'customer' && message.unread) meta.push('new');
      if (message.kind === 'staff') meta.push(message.emailed ? 'customer emailed' : 'email pending');
      head.appendChild(el('span', null, meta.join(' · ')));
      item.appendChild(head);
      item.appendChild(el('p', 'conv-message__body', message.body));
      return item;
    }

    function showLink(url) {
      linkRow.replaceChildren();
      if (!url) return;
      var field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.value = url;
      field.setAttribute('aria-label', 'Customer link');
      field.addEventListener('focus', function () { field.select(); });
      var copy = el('button', 'btn-inline-action', 'Copy customer link');
      copy.type = 'button';
      copy.addEventListener('click', function () { copyText(url, field, copy); });
      linkRow.appendChild(el('small', null, 'Private link for ' + req.name + ' (share by phone or text if an email does not arrive):'));
      linkRow.appendChild(field);
      linkRow.appendChild(copy);
    }

    function load() {
      thread.textContent = 'Loading…';
      return Auth.apiCall('getCateringThread', { requestId: req.id }).then(function (result) {
        if (!result.ok) throw new Error('load');
        thread.replaceChildren();
        if (!result.messages.length) thread.appendChild(el('p', 'conversation__empty', 'No messages yet. Your first reply will email ' + req.name + ' a link to this conversation.'));
        result.messages.forEach(function (message) { thread.appendChild(messageNode(message)); });
        showLink(result.customerLink);
        hooks.onRead();
      }).catch(function () { thread.textContent = 'Could not load the conversation. Try again.'; });
    }

    toggle.addEventListener('click', function () {
      open = !open;
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) load();
    });
    refresh.addEventListener('click', function () { say(''); load(); });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!box.value.trim()) { say('Write a message first.', true); return; }
      var internal = note.checked;
      send.disabled = true;
      say(internal ? 'Saving note…' : 'Sending…');
      Auth.apiCall('sendCateringMessage', { requestId: req.id, body: box.value, internal: internal }).then(function (result) {
        if (!result.ok) {
          say(result.error === 'message_too_long' ? 'That message is too long (4,000 characters at most).' : 'Could not send. Check your connection and try again.', true);
          return;
        }
        var empty = thread.querySelector('.conversation__empty');
        if (empty) empty.remove();
        thread.appendChild(messageNode(result.message));
        box.value = '';
        note.checked = false;
        if (!internal) {
          req.messageCount += 1;
          toggle.textContent = label();
          if (req.status === 'new' || req.status === 'closed') hooks.onStatus('reviewed');
          showLink(result.customerLink);
          say(result.emailQueued ? 'Sent. ' + req.name + ' has been emailed a link to read it.' : 'Saved, but the email could not be queued. Copy the customer link below and send it yourself.', !result.emailQueued);
        } else {
          say('Note saved. Only the team can see it.');
        }
      }).catch(function () { say('Could not send. Check your connection and try again.', true); })
        .finally(function () { send.disabled = false; });
    });

    return wrap;
  }

  function buildRequestCard(req) {
    var card = el('div', 'document-card');

    var head = el('div');
    head.appendChild(el('h4', 'document-card__title', req.name));
    var statusBadge = el('span', 'badge', req.status);
    head.appendChild(statusBadge);
    var unreadBadge = el('span', 'badge catering-unread', '');
    head.appendChild(unreadBadge);
    function showUnread() {
      unreadBadge.textContent = req.unreadCount ? req.unreadCount + ' new repl' + (req.unreadCount === 1 ? 'y' : 'ies') : '';
      unreadBadge.hidden = !req.unreadCount;
    }
    showUnread();
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

    card.appendChild(buildConversation(req, {
      onRead: function () { req.unreadCount = 0; showUnread(); },
      onStatus: function (status) { req.status = status; statusBadge.textContent = status; select.value = status; }
    }));

    return card;
  }
})();

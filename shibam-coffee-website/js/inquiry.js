// /js/inquiry.js
// A catering customer's private conversation page: /inquiry/<token>.
// Everything from the server is written with textContent; nothing is rendered as HTML.
(function () {
  'use strict';

  var app = document.getElementById('inquiry-app');
  var token = '';
  var turnstileToken = '';
  var turnstileWidget = null;

  document.addEventListener('DOMContentLoaded', function () {
    var year = document.getElementById('footer-year');
    if (year) year.textContent = new Date().getFullYear();
    var parts = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    token = parts[0] === 'inquiry' && parts[1] ? parts[1] : (new URLSearchParams(window.location.search).get('t') || '');
    if (!token) return notFound();
    load();
  });

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function api(action, body) {
    return fetch('/api/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action, token: token }, body || {}))
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'server_error' }; });
    }).catch(function () { return { ok: false, error: 'network_error' }; });
  }

  var MESSAGES = {
    message_required: 'Please write a message first.',
    message_too_long: 'That message is too long. Please keep it under 4,000 characters.',
    too_many_messages: 'You have sent a lot of messages today. Please wait a while, or call us at (470) 359-6586.',
    too_many_requests: 'Too many attempts. Please wait a little while and try again.',
    turnstile_required: 'Please complete the security check.',
    turnstile_failed: 'The security check failed. Please try again.',
    turnstile_unavailable: 'The security check is unavailable right now. Please try again shortly.',
    thread_not_found: 'This link is not available.',
    network_error: 'We could not reach the server. Check your connection and try again.'
  };
  function errorText(result) { return MESSAGES[result && result.error] || 'Something went wrong. Please try again.'; }

  function notFound() {
    app.replaceChildren();
    app.appendChild(node('h1', 'booking-title', 'This link is not available'));
    app.appendChild(node('p', 'booking-lead', 'Check that you copied the whole link from our email, or call us at (470) 359-6586.'));
  }

  function when(iso) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }

  function load() {
    return api('getThread').then(function (result) {
      if (!result.ok) return result.error === 'thread_not_found' ? notFound() : showError(result);
      render(result);
    });
  }

  function showError(result) {
    app.replaceChildren();
    app.appendChild(node('h1', 'booking-title', 'Something went wrong'));
    app.appendChild(node('p', 'booking-lead', errorText(result)));
  }

  function render(data) {
    app.replaceChildren();
    turnstileWidget = null;
    turnstileToken = '';
    var request = data.request;
    app.appendChild(node('h1', 'booking-title', 'Your catering request'));
    app.appendChild(node('p', 'booking-lead', 'Hi ' + (request.firstName || 'there') + '. Messages between you and our team stay on this page.'));

    var summary = node('div', 'thread-summary');
    var facts = [request.eventType, request.eventDate ? 'Date: ' + request.eventDate : '', request.guestCount ? 'Guests: ' + request.guestCount : ''].filter(Boolean);
    summary.appendChild(node('strong', null, facts.join(' · ')));
    if (request.details) summary.appendChild(node('p', null, request.details));
    app.appendChild(summary);

    var list = node('div', 'thread-list');
    list.id = 'thread-list';
    list.setAttribute('role', 'log');
    list.setAttribute('aria-label', 'Messages');
    if (!data.messages.length) list.appendChild(node('p', 'booking-lead', 'No messages yet. Our team will reply here.'));
    data.messages.forEach(function (message) { list.appendChild(messageNode(message)); });
    app.appendChild(list);

    var status = node('p', 'form-status');
    status.id = 'inquiry-status';
    status.setAttribute('role', 'status');
    app.appendChild(status);

    var form = node('form', 'booking-form');
    var group = node('div', 'form-group');
    var label = node('label', null, 'Your reply');
    var box = node('textarea');
    box.id = 'inquiry-reply';
    box.rows = 4;
    box.maxLength = 4000;
    box.required = true;
    label.htmlFor = box.id;
    group.appendChild(label);
    group.appendChild(box);
    form.appendChild(group);
    var trap = node('input', 'booking-trap');
    trap.type = 'text'; trap.name = 'website'; trap.tabIndex = -1; trap.autocomplete = 'off';
    trap.setAttribute('aria-hidden', 'true');
    form.appendChild(trap);
    addTurnstile(form);
    var send = node('button', 'btn btn-primary', 'Send reply');
    send.type = 'submit';
    form.appendChild(send);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!box.value.trim()) { setStatus('Please write a message first.', true); return; }
      send.disabled = true;
      setStatus('Sending…');
      api('reply', { body: box.value, website: trap.value, turnstileToken: turnstileToken }).then(function (result) {
        if (!result.ok) { setStatus(errorText(result), true); resetTurnstile(); return; }
        if (!result.message) { setStatus('Thank you.'); box.value = ''; return; } // honeypot answer
        var empty = list.querySelector('p');
        if (empty && !list.querySelector('.thread-message')) empty.remove();
        list.appendChild(messageNode(result.message));
        box.value = '';
        setStatus('Sent. Our team has been told.');
        resetTurnstile();
      }).finally(function () { send.disabled = false; });
    });
    app.appendChild(form);

    var refresh = node('button', 'btn-link', 'Check for new messages');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { load(); });
    app.appendChild(refresh);
  }

  function messageNode(message) {
    var item = node('div', 'thread-message thread-message--' + message.from);
    var head = node('div', 'thread-message__head');
    head.appendChild(node('strong', null, message.from === 'you' ? 'You' : message.authorName + ' (Shibam Coffee)'));
    head.appendChild(node('span', null, when(message.createdAt)));
    item.appendChild(head);
    item.appendChild(node('p', 'thread-message__body', message.body));
    return item;
  }

  function setStatus(text, isError) {
    var element = document.getElementById('inquiry-status');
    if (!element) return;
    element.textContent = text || '';
    element.setAttribute('data-state', isError ? 'error' : 'info');
  }

  function addTurnstile(container) {
    var sitekey = window.CONFIG && CONFIG.TURNSTILE_SITEKEY;
    if (!sitekey) return;
    var mount = node('div', 'booking-turnstile');
    container.appendChild(mount);
    function render() {
      if (!window.turnstile || !mount.isConnected) return;
      turnstileWidget = window.turnstile.render(mount, {
        sitekey: sitekey,
        callback: function (value) { turnstileToken = value; },
        'expired-callback': function () { turnstileToken = ''; }
      });
    }
    if (window.turnstile) { render(); return; }
    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = render;
    document.head.appendChild(script);
  }

  function resetTurnstile() {
    turnstileToken = '';
    if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
  }
})();

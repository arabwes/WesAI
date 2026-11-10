// /js/book.js
// Public booking page. Two modes, chosen by the address:
//   /book/<link token>            pick a time and book
//   /book/manage/<manage token>   view, reschedule or cancel an existing booking
// All server text is written with textContent; nothing is rendered as HTML.
(function () {
  'use strict';

  var app = document.getElementById('booking-app');
  var tz = guessTimezone();
  var turnstileToken = '';
  var turnstileWidget = null;

  document.addEventListener('DOMContentLoaded', function () {
    var year = document.getElementById('footer-year');
    if (year) year.textContent = new Date().getFullYear();
    var route = parseRoute();
    if (route.manageToken) startManage(route.manageToken);
    else if (route.token) startBooking(route.token);
    else showMessage('This booking link is not available', 'Check that you copied the whole link, or contact the person who sent it.');
  });

  // ---- routing and API ----

  function parseRoute() {
    var parts = window.location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    var query = new URLSearchParams(window.location.search);
    if (parts[0] === 'book' && parts[1] === 'manage' && parts[2]) return { manageToken: parts[2] };
    if (parts[0] === 'book' && parts[1] && parts[1] !== 'manage') return { token: parts[1] };
    if (query.get('m')) return { manageToken: query.get('m') };
    if (query.get('t')) return { token: query.get('t') };
    return {};
  }

  function api(action, body) {
    return fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'server_error' }; });
    }).catch(function () { return { ok: false, error: 'network_error' }; });
  }

  var MESSAGES = {
    slot_unavailable: 'That time was just taken. Please pick another.',
    already_booked: 'You already have an upcoming booking with this link. Use the link in your confirmation email to change or cancel it.',
    invalid_email: 'Please enter a valid email address.',
    name_required: 'Please enter your name.',
    answer_required: 'Please answer the required questions.',
    too_many_requests: 'Too many attempts. Please wait a little while and try again.',
    turnstile_required: 'Please complete the security check.',
    turnstile_failed: 'The security check failed. Please try again.',
    turnstile_unavailable: 'The security check is unavailable right now. Please try again shortly.',
    link_not_found: 'This booking link is no longer available.',
    booking_not_changeable: 'This booking can no longer be changed online.',
    reschedule_unavailable: 'This meeting can no longer be rescheduled online.',
    network_error: 'We could not reach the server. Check your connection and try again.'
  };
  function errorText(result) {
    return MESSAGES[result && result.error] || 'Something went wrong. Please try again.';
  }

  // ---- small DOM helpers ----

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  }

  function clear() { app.replaceChildren(); turnstileWidget = null; turnstileToken = ''; }

  function showMessage(title, body) {
    clear();
    app.appendChild(node('h1', 'booking-title', title));
    if (body) app.appendChild(node('p', 'booking-lead', body));
  }

  function status(text, isError) {
    var element = document.getElementById('booking-status');
    if (!element) return;
    element.textContent = text || '';
    element.setAttribute('data-state', isError ? 'error' : 'info');
  }

  function field(labelText, control, hint) {
    var group = node('div', 'form-group');
    var label = node('label', null, labelText);
    control.id = control.id || 'bk_' + Math.random().toString(36).slice(2, 9);
    label.htmlFor = control.id;
    group.appendChild(label);
    group.appendChild(control);
    if (hint) group.appendChild(node('small', 'booking-hint', hint));
    return group;
  }

  function input(type, name, attrs) {
    var element = node('input');
    element.type = type;
    element.name = name;
    Object.keys(attrs || {}).forEach(function (key) { element.setAttribute(key, attrs[key]); });
    return element;
  }

  // ---- time zones and formatting ----

  function guessTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch (error) { return 'America/New_York'; }
  }

  function zoneList() {
    var zones;
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (error) { zones = null; }
    if (!zones || !zones.length) zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'UTC'];
    if (zones.indexOf(tz) === -1) zones = [tz].concat(zones);
    return zones;
  }

  function dayKey(iso) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  }
  function dayLabel(iso) {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
  }
  function timeLabel(iso) {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  function fullWhen(iso) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }).format(new Date(iso));
  }

  function addressNode(location) {
    var wrap = node('p', 'booking-address');
    if (!location) return wrap;
    wrap.appendChild(node('strong', null, location.name));
    wrap.appendChild(document.createElement('br'));
    wrap.appendChild(document.createTextNode([location.addressLine1, location.addressLine2].filter(Boolean).join(', ')));
    wrap.appendChild(document.createElement('br'));
    wrap.appendChild(document.createTextNode(location.city + ', ' + location.state + ' ' + location.postalCode));
    if (location.notes) {
      wrap.appendChild(document.createElement('br'));
      wrap.appendChild(node('em', null, location.notes));
    }
    return wrap;
  }

  // ---- the shared "pick a time" widget ----
  // Calls onPick(isoStart) when a time is chosen. Re-renders when the zone changes.

  function timePicker(slots, onPick) {
    var wrap = node('div', 'booking-picker');
    var zone = node('select');
    zoneList().forEach(function (name) {
      var option = node('option', null, name.replace(/_/g, ' '));
      option.value = name;
      option.selected = name === tz;
      zone.appendChild(option);
    });
    wrap.appendChild(field('Times shown in', zone));
    var days = node('div', 'booking-days');
    days.setAttribute('role', 'group');
    days.setAttribute('aria-label', 'Choose a day');
    var times = node('div', 'booking-times');
    times.setAttribute('role', 'group');
    times.setAttribute('aria-label', 'Choose a time');
    wrap.appendChild(days);
    wrap.appendChild(times);

    function renderDays(selectedKey) {
      days.replaceChildren();
      times.replaceChildren();
      if (!slots.length) {
        days.appendChild(node('p', 'booking-lead', 'There are no open times right now. Please check back soon.'));
        return;
      }
      var byDay = {};
      var order = [];
      slots.forEach(function (iso) {
        var key = dayKey(iso);
        if (!byDay[key]) { byDay[key] = []; order.push(key); }
        byDay[key].push(iso);
      });
      order.forEach(function (key) {
        var chip = node('button', 'booking-chip', dayLabel(byDay[key][0]));
        chip.type = 'button';
        chip.setAttribute('aria-pressed', key === selectedKey ? 'true' : 'false');
        chip.addEventListener('click', function () { renderDays(key); });
        days.appendChild(chip);
      });
      if (selectedKey && byDay[selectedKey]) {
        byDay[selectedKey].forEach(function (iso) {
          var button = node('button', 'btn btn-outline booking-time', timeLabel(iso));
          button.type = 'button';
          button.addEventListener('click', function () { onPick(iso); });
          times.appendChild(button);
        });
      }
    }
    zone.addEventListener('change', function () { tz = zone.value; renderDays(null); });
    renderDays(null);
    return wrap;
  }

  // ---- Turnstile ----

  function addTurnstile(container) {
    var sitekey = window.CONFIG && CONFIG.TURNSTILE_SITEKEY;
    if (!sitekey) return;
    var mount = node('div', 'booking-turnstile');
    container.appendChild(mount);
    function render() {
      if (!window.turnstile || !mount.isConnected) return;
      turnstileWidget = window.turnstile.render(mount, {
        sitekey: sitekey,
        callback: function (token) { turnstileToken = token; },
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

  // ---- booking a new time ----

  function startBooking(token) {
    api('getLink', { token: token }).then(function (result) {
      if (!result.ok) return showMessage('This booking link is not available', errorText(result));
      var event = result.event;
      renderEventHeader(event);
      return api('getSlots', { token: token }).then(function (slotResult) {
        if (!slotResult.ok) return showMessage('Something went wrong', errorText(slotResult));
        showPicker(token, event, slotResult.slots);
      });
    });
  }

  function renderEventHeader(event) {
    clear();
    app.appendChild(node('h1', 'booking-title', event.name));
    app.appendChild(node('p', 'booking-lead', event.durationMinutes + ' minutes · in person · with ' + event.ownerFirstName));
    if (event.description) app.appendChild(node('p', null, event.description));
    app.appendChild(addressNode(event.location));
    var statusLine = node('p', 'form-status');
    statusLine.id = 'booking-status';
    statusLine.setAttribute('role', 'status');
    app.appendChild(statusLine);
  }

  function showPicker(token, event, slots) {
    var holder = node('div');
    holder.id = 'booking-step';
    holder.appendChild(node('h2', 'booking-step-title', 'Choose a time'));
    holder.appendChild(timePicker(slots, function (iso) { showForm(token, event, slots, iso); }));
    var old = document.getElementById('booking-step');
    if (old) old.replaceWith(holder); else app.appendChild(holder);
  }

  function showForm(token, event, slots, startIso) {
    var holder = node('div');
    holder.id = 'booking-step';
    holder.appendChild(node('h2', 'booking-step-title', 'Your details'));
    holder.appendChild(node('p', 'booking-chosen', fullWhen(startIso)));
    var change = node('button', 'btn-link', 'Choose a different time');
    change.type = 'button';
    change.addEventListener('click', function () { status(''); showPicker(token, event, slots); });
    holder.appendChild(change);

    var form = node('form', 'booking-form');
    var name = input('text', 'name', { required: 'required', maxlength: '120', autocomplete: 'name' });
    var email = input('email', 'email', { required: 'required', maxlength: '254', autocomplete: 'email' });
    var phone = input('tel', 'phone', { maxlength: '40', autocomplete: 'tel' });
    form.appendChild(field('Full name', name));
    form.appendChild(field('Email', email, 'We will send your confirmation here.'));
    form.appendChild(field('Phone (optional)', phone, 'Only used if we need to reach you about this meeting.'));
    var answers = [];
    (event.questions || []).forEach(function (question) {
      var control = input('text', 'q_' + question.id, { maxlength: '1000' });
      if (question.required) control.required = true;
      answers.push({ id: question.id, control: control });
      form.appendChild(field(question.label + (question.required ? '' : ' (optional)'), control));
    });
    var trap = input('text', 'website', { tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    trap.className = 'booking-trap';
    form.appendChild(trap);
    addTurnstile(form);
    var submit = node('button', 'btn btn-primary', 'Confirm booking');
    submit.type = 'submit';
    form.appendChild(submit);
    form.addEventListener('submit', function (submitEvent) {
      submitEvent.preventDefault();
      submit.disabled = true;
      status('Booking…');
      var body = { token: token, start: startIso, name: name.value, email: email.value, phone: phone.value, timezone: tz, website: trap.value, turnstileToken: turnstileToken, answers: {} };
      answers.forEach(function (answer) { body.answers[answer.id] = answer.control.value; });
      api('book', body).then(function (result) {
        if (!result.ok) {
          status(errorText(result), true);
          resetTurnstile();
          if (result.error === 'slot_unavailable') {
            api('getSlots', { token: token }).then(function (fresh) { if (fresh.ok) showPicker(token, event, fresh.slots); status(errorText(result), true); });
          }
          return;
        }
        if (!result.booking) { // honeypot response: show a neutral message
          return showMessage('Thank you', 'If your details were valid you will receive a confirmation email shortly.');
        }
        showConfirmation(result, email.value);
      }).finally(function () { submit.disabled = false; });
    });
    holder.appendChild(form);
    var old = document.getElementById('booking-step');
    old.replaceWith(holder);
    name.focus();
  }

  function showConfirmation(result, emailAddress) {
    clear();
    app.appendChild(node('h1', 'booking-title', 'You are booked'));
    app.appendChild(node('p', 'booking-chosen', result.booking.title + ' — ' + fullWhen(result.booking.startUtc)));
    app.appendChild(addressNode(result.booking.location));
    app.appendChild(node('p', 'booking-lead', result.emailQueued
      ? 'We sent a confirmation to ' + emailAddress + '. It includes a calendar invite and a link to change or cancel.'
      : 'Save the link below. It is the only way to change or cancel this booking.'));
    var link = '/book/manage/' + encodeURIComponent(result.manageToken);
    var manage = node('a', 'btn btn-outline', 'Change or cancel this booking');
    manage.href = link;
    app.appendChild(manage);
    try { window.history.replaceState(null, '', link); } catch (error) { /* ignore */ }
  }

  // ---- managing an existing booking ----

  function startManage(manageToken) {
    api('getBooking', { manageToken: manageToken }).then(function (result) {
      if (!result.ok) return showMessage('We could not find this booking', 'The link may be wrong or out of date.');
      renderManage(manageToken, result.booking);
    });
  }

  function renderManage(manageToken, booking) {
    clear();
    var cancelled = booking.status === 'cancelled';
    app.appendChild(node('h1', 'booking-title', cancelled ? 'This booking was cancelled' : booking.title));
    if (booking.clientName) app.appendChild(node('p', 'booking-lead', 'Hi ' + booking.clientName.split(' ')[0] + '.'));
    app.appendChild(node('p', 'booking-chosen', fullWhen(booking.startUtc)));
    app.appendChild(node('p', 'booking-lead', 'With ' + booking.ownerFirstName));
    app.appendChild(addressNode(booking.location));
    var statusLine = node('p', 'form-status');
    statusLine.id = 'booking-status';
    statusLine.setAttribute('role', 'status');
    app.appendChild(statusLine);
    if (cancelled) return;
    if (!booking.canChange) {
      app.appendChild(node('p', 'booking-lead', 'This meeting has already started or passed, so it can no longer be changed online.'));
      return;
    }
    var actions = node('div', 'booking-actions');
    var resched = node('button', 'btn btn-primary', 'Reschedule');
    resched.type = 'button';
    resched.addEventListener('click', function () { startReschedule(manageToken, booking); });
    var cancel = node('button', 'btn btn-outline', 'Cancel booking');
    cancel.type = 'button';
    cancel.addEventListener('click', function () {
      if (!window.confirm('Cancel this booking?')) return;
      cancel.disabled = true;
      api('cancelBooking', { manageToken: manageToken }).then(function (result) {
        if (!result.ok) { status(errorText(result), true); cancel.disabled = false; return; }
        startManage(manageToken);
      });
    });
    actions.appendChild(resched);
    actions.appendChild(cancel);
    app.appendChild(actions);
    var step = node('div');
    step.id = 'booking-step';
    app.appendChild(step);
  }

  function startReschedule(manageToken, booking) {
    status('Loading times…');
    api('getManageSlots', { manageToken: manageToken }).then(function (result) {
      if (!result.ok) { status(errorText(result), true); return; }
      status('');
      var holder = node('div');
      holder.id = 'booking-step';
      holder.appendChild(node('h2', 'booking-step-title', 'Choose a new time'));
      holder.appendChild(timePicker(result.slots, function (iso) { confirmReschedule(manageToken, booking, result.slots, iso); }));
      document.getElementById('booking-step').replaceWith(holder);
    });
  }

  function confirmReschedule(manageToken, booking, slots, iso) {
    var holder = node('div');
    holder.id = 'booking-step';
    holder.appendChild(node('h2', 'booking-step-title', 'Confirm the new time'));
    holder.appendChild(node('p', 'booking-chosen', fullWhen(iso)));
    var form = node('form', 'booking-form');
    addTurnstile(form);
    var submit = node('button', 'btn btn-primary', 'Confirm new time');
    submit.type = 'submit';
    form.appendChild(submit);
    var back = node('button', 'btn-link', 'Choose a different time');
    back.type = 'button';
    back.addEventListener('click', function () { startReschedule(manageToken, booking); });
    form.appendChild(back);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit.disabled = true;
      api('rescheduleBooking', { manageToken: manageToken, start: iso, turnstileToken: turnstileToken }).then(function (result) {
        if (!result.ok) {
          status(errorText(result), true);
          resetTurnstile();
          if (result.error === 'slot_unavailable') startReschedule(manageToken, booking);
          return;
        }
        showConfirmation(result, 'your email address');
      }).finally(function () { submit.disabled = false; });
    });
    holder.appendChild(form);
    document.getElementById('booking-step').replaceWith(holder);
  }
})();

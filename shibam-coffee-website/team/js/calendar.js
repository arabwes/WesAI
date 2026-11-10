// /team/js/calendar.js
// Team calendar: month grid + agenda. Booked meetings arrive from the server
// already redacted for anyone who is not the host or Management, so this page
// only displays what it is given. All text is written with textContent.
(function () {
  'use strict';

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var state = { month: null, tz: 'America/New_York', events: [], bookings: [], selectedDay: null, filter: 'all', session: null };

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    state.session = Auth.getSession();
    if (state.session) document.getElementById('session-banner').textContent = 'Logged in as ' + state.session.name + ' (' + state.session.role + ')';
    var canCreate = state.session && Auth.hasRole(state.session, 'lead');
    var newButton = document.getElementById('cal-new');
    newButton.hidden = !canCreate;
    newButton.addEventListener('click', function () { openEventForm(null); });
    document.getElementById('cal-prev').addEventListener('click', function () { shiftMonth(-1); });
    document.getElementById('cal-next').addEventListener('click', function () { shiftMonth(1); });
    document.getElementById('cal-today').addEventListener('click', function () { state.month = monthOf(todayKey()); state.selectedDay = null; load(); });
    document.getElementById('cal-filter').addEventListener('change', function (event) { state.filter = event.target.value; render(); });
    state.month = monthOf(todayKey());
    load();
  });

  // ---- dates (plain YYYY-MM-DD strings; the store timezone decides "today") ----

  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = value;
    return element;
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function monthOf(key) { return key.slice(0, 7); }
  function addDays(key, days) {
    var p = key.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
  }
  function weekday(key) { var p = key.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).getUTCDay(); }
  function todayKey() { return dayKey(new Date().toISOString()); }
  function dayKey(iso) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  }
  function gridRange() {
    var first = state.month + '-01';
    var start = addDays(first, -weekday(first));
    return { from: start, to: addDays(start, 41) };
  }
  function shiftMonth(delta) {
    var p = state.month.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 + delta, 1));
    state.month = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
    state.selectedDay = null;
    load();
  }
  function timeText(iso) {
    return new Intl.DateTimeFormat('en-US', { timeZone: state.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  }
  function dayText(key) {
    var p = key.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)));
  }
  function monthText() {
    var p = state.month.split('-').map(Number);
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(p[0], p[1] - 1, 1, 12)));
  }

  function say(message, isError) {
    var el = document.getElementById('cal-status');
    el.textContent = message || '';
    el.className = 'booking-status' + (isError ? ' is-error' : '');
  }

  // ---- loading ----

  function load() {
    var range = gridRange();
    document.getElementById('cal-month').textContent = monthText();
    return Auth.apiCall('getCalendar', { from: range.from, to: range.to }).then(function (result) {
      if (!result.ok) throw new Error('load');
      state.tz = result.timezone || state.tz;
      state.events = result.events;
      state.bookings = result.bookings;
      render();
    }).catch(function () {
      document.getElementById('cal-agenda').textContent = 'Could not load the calendar. Refresh to try again.';
    });
  }

  // Everything on the calendar as one list of items, each with the days it covers.
  function items() {
    var list = [];
    if (state.filter !== 'mine') {
      state.events.forEach(function (event) { list.push({ kind: 'event', data: event, startUtc: event.startUtc, endUtc: event.endUtc, allDay: event.allDay }); });
    }
    if (state.filter !== 'events') {
      state.bookings.forEach(function (booking) {
        if (state.filter === 'mine' && (booking.redacted || booking.ownerId !== (state.session && state.session.id))) return;
        list.push({ kind: 'booking', data: booking, startUtc: booking.startUtc, endUtc: booking.endUtc, allDay: false });
      });
    }
    list.forEach(function (item) {
      var first = dayKey(item.startUtc);
      var last = dayKey(new Date(Date.parse(item.endUtc) - 1).toISOString());
      item.days = [];
      for (var day = first, guard = 0; day <= last && guard < 40; day = addDays(day, 1), guard += 1) item.days.push(day);
    });
    list.sort(function (a, b) { return a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0; });
    return list;
  }

  // ---- rendering ----

  function render() {
    var list = items();
    renderGrid(list);
    renderAgenda(list);
  }

  function renderGrid(list) {
    var grid = document.getElementById('cal-grid');
    grid.replaceChildren();
    DOW.forEach(function (name) { var cell = node('div', 'cal-dow', name); cell.setAttribute('role', 'columnheader'); grid.appendChild(cell); });
    var range = gridRange();
    var today = todayKey();
    for (var day = range.from; day <= range.to; day = addDays(day, 1)) {
      (function (key) {
        var cell = node('button', 'cal-day');
        cell.type = 'button';
        cell.setAttribute('role', 'gridcell');
        if (monthOf(key) !== state.month) cell.classList.add('is-outside');
        if (key === today) cell.classList.add('is-today');
        if (key === state.selectedDay) cell.classList.add('is-selected');
        cell.appendChild(node('span', 'cal-day__num', String(Number(key.slice(8)))));
        var dayItems = list.filter(function (item) { return item.days.indexOf(key) !== -1; });
        cell.setAttribute('aria-label', dayText(key) + ', ' + dayItems.length + (dayItems.length === 1 ? ' item' : ' items'));
        var dots = node('div', 'cal-dots');
        dayItems.slice(0, 6).forEach(function (item) { dots.appendChild(node('span', 'cal-dot' + (item.kind === 'booking' ? ' cal-dot--booking' : ''))); });
        cell.appendChild(dots);
        dayItems.slice(0, 2).forEach(function (item) {
          cell.appendChild(node('span', 'cal-chip' + (item.kind === 'booking' ? ' cal-chip--booking' : ''), chipText(item)));
        });
        if (dayItems.length > 2) cell.appendChild(node('span', 'cal-chip', '+' + (dayItems.length - 2) + ' more'));
        cell.addEventListener('click', function () { state.selectedDay = state.selectedDay === key ? null : key; render(); });
        grid.appendChild(cell);
      })(day);
    }
  }

  function chipText(item) {
    var time = item.allDay ? '' : timeText(item.startUtc) + ' ';
    return time + (item.kind === 'booking' ? (item.data.redacted ? 'Booked' : item.data.title) : item.data.title);
  }

  function renderAgenda(list) {
    var mount = document.getElementById('cal-agenda');
    mount.replaceChildren();
    document.getElementById('agenda-heading').textContent = state.selectedDay ? dayText(state.selectedDay) : 'Agenda for ' + monthText();
    var shown = list.filter(function (item) {
      if (state.selectedDay) return item.days.indexOf(state.selectedDay) !== -1;
      return item.days.some(function (day) { return monthOf(day) === state.month; });
    });
    if (!shown.length) { mount.textContent = state.selectedDay ? 'Nothing scheduled this day.' : 'Nothing scheduled this month.'; return; }
    var lastDay = null;
    shown.forEach(function (item) {
      var day = state.selectedDay || item.days[0];
      if (day !== lastDay) { mount.appendChild(node('h3', 'cal-agenda-day', dayText(day))); lastDay = day; }
      mount.appendChild(item.kind === 'event' ? eventItem(item) : bookingItem(item));
    });
  }

  function whenText(item) {
    if (item.allDay) return 'All day';
    return timeText(item.startUtc) + ' – ' + timeText(item.endUtc);
  }

  function eventItem(item) {
    var event = item.data;
    var card = node('div', 'cal-item cal-item--event');
    card.appendChild(node('div', 'cal-item__time', whenText(item)));
    card.appendChild(node('div', 'cal-item__title', event.title));
    var meta = [event.location, 'Added by ' + event.creatorName].filter(Boolean).join(' · ');
    card.appendChild(node('p', 'cal-item__meta', meta));
    if (event.description) card.appendChild(node('p', 'cal-item__meta', event.description));
    if (event.canEdit) {
      var actions = node('div', 'booking-card-actions');
      var edit = node('button', 'btn-inline-action', 'Edit'); edit.type = 'button';
      edit.addEventListener('click', function () { openEventForm(event); });
      var del = node('button', 'btn-inline-action btn-inline-action--danger', 'Delete'); del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete "' + event.title + '"?')) return;
        Auth.apiCall('deleteTeamEvent', { id: event.id }).then(function (result) {
          if (!result.ok) return say('Could not delete the event.', true);
          say('Event deleted.');
          return load();
        });
      });
      actions.appendChild(edit); actions.appendChild(del);
      card.appendChild(actions);
    }
    return card;
  }

  function bookingItem(item) {
    var booking = item.data;
    var card = node('div', 'cal-item cal-item--booking');
    card.appendChild(node('div', 'cal-item__time', whenText(item)));
    if (booking.redacted) {
      card.appendChild(node('div', 'cal-item__title', 'Booked'));
      return card;
    }
    card.appendChild(node('div', 'cal-item__title', booking.title + (booking.clientName ? ' — ' + booking.clientName : booking.anonymized ? ' — details removed' : '')));
    card.appendChild(node('p', 'cal-item__meta', 'Only you and Management can see these details'));
    var details = node('div', 'cal-item__details');
    details.hidden = true;
    if (booking.clientEmail) {
      var p = node('p', null, 'Email: ');
      var mail = node('a', null, booking.clientEmail); mail.href = 'mailto:' + booking.clientEmail;
      p.appendChild(mail); details.appendChild(p);
    }
    if (booking.clientPhone) {
      var q = node('p', null, 'Phone: ');
      var tel = node('a', null, booking.clientPhone); tel.href = 'tel:' + booking.clientPhone;
      q.appendChild(tel); details.appendChild(q);
    }
    if (booking.location) {
      details.appendChild(node('p', null, 'Where: ' + [booking.location.name, booking.location.addressLine1, booking.location.city + ', ' + booking.location.state].filter(Boolean).join(', ')));
    }
    Object.keys(booking.answers || {}).forEach(function (key) { details.appendChild(node('p', null, booking.answers[key])); });
    var actions = node('div', 'booking-card-actions');
    var toggle = node('button', 'btn-inline-action', 'Details'); toggle.type = 'button';
    toggle.addEventListener('click', function () { details.hidden = !details.hidden; toggle.textContent = details.hidden ? 'Details' : 'Hide details'; });
    var cancel = node('button', 'btn-inline-action btn-inline-action--danger', 'Cancel meeting'); cancel.type = 'button';
    cancel.addEventListener('click', function () {
      if (!window.confirm('Cancel this meeting? ' + (booking.clientName || 'The invitee') + ' will be emailed.')) return;
      Auth.apiCall('cancelBooking', { bookingId: booking.id }).then(function (result) {
        if (!result.ok) return say('Could not cancel the meeting.', true);
        say('Meeting cancelled.');
        return load();
      });
    });
    actions.appendChild(toggle);
    actions.appendChild(cancel);
    if (state.session && Auth.hasRole(state.session, 'management') && booking.clientEmail) {
      var erase = node('button', 'btn-inline-action btn-inline-action--danger', 'Erase personal data'); erase.type = 'button';
      erase.addEventListener('click', function () {
        if (!window.confirm('Erase all details for ' + (booking.clientName || 'this person') + '? Any upcoming meeting is cancelled and this cannot be undone.')) return;
        Auth.apiCall('eraseBookingData', { bookingId: booking.id }).then(function (result) {
          if (!result.ok) return say('Could not erase the details.', true);
          say('Personal data erased.');
          return load();
        });
      });
      actions.appendChild(erase);
    }
    card.appendChild(actions);
    card.appendChild(details);
    return card;
  }

  // ---- add / edit a team event ----

  function localParts(iso) {
    return {
      date: dayKey(iso),
      time: new Intl.DateTimeFormat('en-GB', { timeZone: state.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))
    };
  }

  function row(labelText, control, wide) {
    var group = node('div', 'form-group' + (wide ? ' form-group--wide' : ''));
    var label = node('label', null, labelText);
    control.id = control.id || 'ev_' + Math.random().toString(36).slice(2, 9);
    label.htmlFor = control.id;
    group.appendChild(label); group.appendChild(control);
    return group;
  }
  function input(type, value, attrs) {
    var el = node('input'); el.type = type; el.value = value || '';
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function openEventForm(event) {
    var form = document.getElementById('event-form');
    form.replaceChildren();
    form.hidden = false;
    var start = event ? localParts(event.startUtc) : { date: state.selectedDay || todayKey(), time: '09:00' };
    var end = event ? localParts(event.endUtc) : { date: start.date, time: '10:00' };
    var endDateForAllDay = event && event.allDay ? dayKey(new Date(Date.parse(event.endUtc) - 1).toISOString()) : start.date;
    var title = input('text', event && event.title, { maxlength: 120, required: 'required' });
    var date = input('date', start.date, { required: 'required' });
    var allDay = input('checkbox', ''); allDay.checked = !!(event && event.allDay);
    var startTime = input('time', start.time);
    var endTime = input('time', end.time);
    var endDate = input('date', endDateForAllDay);
    var location = input('text', event && event.location, { maxlength: 200 });
    var description = input('text', event && event.description, { maxlength: 1000 });
    var blocks = input('checkbox', ''); blocks.checked = !!(event && event.blocksAvailability);
    form.appendChild(row('Title', title, true));
    form.appendChild(row('Date', date));
    var allDayGroup = node('div', 'form-group');
    var allDayLabel = node('label', null, ' All day'); allDayLabel.insertBefore(allDay, allDayLabel.firstChild);
    allDayGroup.appendChild(allDayLabel);
    form.appendChild(allDayGroup);
    var timed = node('div', 'booking-form__actions');
    timed.appendChild(row('Starts', startTime)); timed.appendChild(row('Ends', endTime));
    var allDayEnd = row('Last day', endDate);
    form.appendChild(timed); form.appendChild(allDayEnd);
    function sync() { timed.hidden = allDay.checked; allDayEnd.hidden = !allDay.checked; }
    allDay.addEventListener('change', sync); sync();
    form.appendChild(row('Location (optional)', location, true));
    form.appendChild(row('Notes (optional)', description, true));
    var blockGroup = node('div', 'form-group form-group--wide');
    var blockLabel = node('label', null, ' Don\'t offer my booking-link times during this event');
    blockLabel.insertBefore(blocks, blockLabel.firstChild);
    blockGroup.appendChild(blockLabel);
    form.appendChild(blockGroup);
    var actions = node('div', 'booking-form__actions');
    var save = node('button', 'btn btn-small', event ? 'Save event' : 'Add event'); save.type = 'submit';
    var cancel = node('button', 'btn-remove-row', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', function () { form.hidden = true; });
    actions.appendChild(save); actions.appendChild(cancel);
    form.appendChild(actions);
    form.onsubmit = function (submitEvent) {
      submitEvent.preventDefault();
      save.disabled = true;
      Auth.apiCall('saveTeamEvent', {
        id: event && event.id, title: title.value, date: date.value, allDay: allDay.checked,
        endDate: endDate.value, startTime: startTime.value, endTime: endTime.value,
        location: location.value, description: description.value, blocksAvailability: blocks.checked
      }).then(function (result) {
        if (!result.ok) {
          say(result.error === 'invalid_range' ? 'The end must be after the start.' : 'Could not save the event. Check the details and try again.', true);
          return;
        }
        form.hidden = true;
        say('Event saved.');
        return load();
      }).finally(function () { save.disabled = false; });
    };
    title.focus();
  }
})();

// /team/js/schedule.js — employee schedule, availability, and requests.
(function () {
  'use strict';

  var state = { weekStart: mondayFor(new Date()), data: null };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    bindWeekControls();
    bindAvailabilityForm();
    bindTimeOffForm();
    bindNotificationButton();
    populateDays();
    setDateDefaults();
    loadSchedule();
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function mondayFor(value) {
    var date = new Date(value);
    date.setHours(12, 0, 0, 0);
    var day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return localDate(date);
  }

  function localDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function addDays(dateString, days) {
    var date = new Date(dateString + 'T12:00:00');
    date.setDate(date.getDate() + days);
    return localDate(date);
  }

  function formatDate(dateString, options) {
    return new Date(dateString + 'T12:00:00').toLocaleDateString(undefined, options || { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function formatTime(value) {
    var parts = value.split(':').map(Number);
    return new Date(2000, 0, 1, parts[0], parts[1]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function minutesFor(shift) {
    var start = shift.startTime.split(':').map(Number);
    var end = shift.endTime.split(':').map(Number);
    return end[0] * 60 + end[1] - start[0] * 60 - start[1] - shift.breakMinutes;
  }

  function bindWeekControls() {
    document.getElementById('previous-week').addEventListener('click', function () { state.weekStart = addDays(state.weekStart, -7); loadSchedule(); });
    document.getElementById('next-week').addEventListener('click', function () { state.weekStart = addDays(state.weekStart, 7); loadSchedule(); });
    document.getElementById('current-week').addEventListener('click', function () { state.weekStart = mondayFor(new Date()); loadSchedule(); });
  }

  function loadSchedule() {
    setPageStatus(null, 'Loading schedule…');
    document.getElementById('schedule-week-label').textContent = formatDate(state.weekStart, { month: 'long', day: 'numeric' }) + '–' + formatDate(addDays(state.weekStart, 6), { month: 'long', day: 'numeric', year: 'numeric' });
    Auth.apiCall('getMySchedule', { weekStart: state.weekStart }).then(function (result) {
      if (!result.ok) {
        setPageStatus('error', Auth.errorMessage(result, 'Could not load your schedule.'));
        return;
      }
      state.data = result;
      setPageStatus(null, '');
      renderNotifications();
      renderShifts();
      renderAvailability();
      renderTimeOff();
    }).catch(function () { setPageStatus('error', 'Could not load your schedule.'); });
  }

  function renderShifts() {
    var session = Auth.getSession();
    var all = state.data.shifts || [];
    var mine = all.filter(function (shift) { return shift.employeeId === session.id; });
    var open = all.filter(function (shift) { return !shift.employeeId; });
    var pendingShiftIds = new Set((state.data.requests || []).filter(function (request) { return request.status === 'pending'; }).map(function (request) { return request.shiftId; }));
    var myMount = document.getElementById('my-shifts');
    var openMount = document.getElementById('open-shifts');
    myMount.innerHTML = '';
    openMount.innerHTML = '';

    if (!state.data.schedule) {
      myMount.appendChild(emptyState('No published schedule yet', 'Management has not published this week. Check back soon.'));
      openMount.appendChild(emptyState('No open shifts', 'Open shifts appear after the schedule is published.'));
      document.getElementById('my-hours').textContent = '';
      return;
    }

    if (!mine.length) myMount.appendChild(emptyState('You are not scheduled this week', 'Any shifts available to pick up appear below.'));
    mine.forEach(function (shift) {
      var card = buildShiftCard(shift, true);
      var coworkers = all.filter(function (other) { return other.date === shift.date && other.employeeId && other.employeeId !== session.id; });
      if (coworkers.length) card.appendChild(el('p', 'shift-card__coworkers', 'Working with ' + coworkers.map(function (item) { return item.employeeName; }).join(', ')));
      if (!shift.confirmedAt) {
        var confirm = el('button', 'btn btn-primary btn-small', 'Confirm shift');
        confirm.type = 'button';
        confirm.addEventListener('click', function () {
          confirm.disabled = true;
          Auth.apiCall('confirmShift', { shiftId: shift.id }).then(function (result) {
            if (result.ok) loadSchedule();
            else { confirm.disabled = false; setPageStatus('error', Auth.errorMessage(result)); }
          });
        });
        card.appendChild(confirm);
      } else {
        card.appendChild(el('span', 'confirmed-badge', '✓ Confirmed'));
      }
      myMount.appendChild(card);
    });
    var totalMinutes = mine.reduce(function (sum, shift) { return sum + minutesFor(shift); }, 0);
    document.getElementById('my-hours').textContent = (totalMinutes / 60).toFixed(totalMinutes % 60 ? 1 : 0) + ' scheduled hours';

    if (!open.length) openMount.appendChild(emptyState('No open shifts this week', 'You’re all set for now.'));
    open.forEach(function (shift) {
      var card = buildShiftCard(shift, false);
      var requested = pendingShiftIds.has(shift.id);
      var button = el('button', requested ? 'btn-outline btn-small' : 'btn btn-primary btn-small', requested ? 'Requested' : 'Request this shift');
      button.type = 'button';
      button.disabled = requested;
      button.addEventListener('click', function () {
        button.disabled = true;
        Auth.apiCall('requestOpenShift', { shiftId: shift.id }).then(function (result) {
          if (result.ok) loadSchedule();
          else { button.disabled = false; setPageStatus('error', requestError(result)); }
        });
      });
      card.appendChild(button);
      openMount.appendChild(card);
    });
  }

  function buildShiftCard(shift, assigned) {
    var card = el('article', assigned ? 'shift-card' : 'shift-card shift-card--open');
    card.style.setProperty('--shift-color', shift.positionColor || '#A56A24');
    var top = el('div', 'shift-card__top');
    var date = el('div');
    date.appendChild(el('span', 'shift-card__day', formatDate(shift.date, { weekday: 'long' })));
    date.appendChild(el('span', 'shift-card__date', formatDate(shift.date, { month: 'short', day: 'numeric' })));
    top.appendChild(date);
    top.appendChild(el('span', 'shift-card__position', shift.positionName || (assigned ? 'Team shift' : 'Open shift')));
    card.appendChild(top);
    card.appendChild(el('p', 'shift-card__time', formatTime(shift.startTime) + '–' + formatTime(shift.endTime)));
    var details = [];
    if (shift.breakMinutes) details.push(shift.breakMinutes + '-minute break');
    if (shift.notes) details.push(shift.notes);
    if (details.length) card.appendChild(el('p', 'shift-card__details', details.join(' · ')));
    return card;
  }

  function emptyState(title, message) {
    var wrap = el('div', 'schedule-empty');
    wrap.appendChild(el('strong', null, title));
    wrap.appendChild(el('p', null, message));
    return wrap;
  }

  function populateDays() {
    var select = document.getElementById('availability-day');
    [1, 2, 3, 4, 5, 6, 0].forEach(function (day) {
      var option = el('option', null, DAYS[day]);
      option.value = String(day);
      select.appendChild(option);
    });
  }

  function bindAvailabilityForm() {
    var form = document.getElementById('availability-form');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = form.querySelector('[data-form-status]');
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      setStatus(status, null, 'Saving…');
      Auth.apiCall('saveAvailability', { availability: {
        weekday: Number(form.weekday.value),
        preference: form.preference.value,
        startTime: form.startTime.value,
        endTime: form.endTime.value
      } }).then(function (result) {
        button.disabled = false;
        if (result.ok) { form.reset(); setStatus(status, 'success', 'Availability saved.'); loadSchedule(); }
        else setStatus(status, 'error', Auth.errorMessage(result, 'Could not save availability.'));
      });
    });
  }

  function renderAvailability() {
    var mount = document.getElementById('availability-list');
    mount.innerHTML = '';
    var rules = state.data.availability || [];
    if (!rules.length) { mount.appendChild(emptyState('No availability saved', 'Add the times you prefer to work or cannot work.')); return; }
    rules.forEach(function (rule) {
      var item = el('div', 'request-item');
      var copy = el('div');
      copy.appendChild(el('strong', null, DAYS[rule.weekday]));
      copy.appendChild(el('p', null, (rule.preference === 'unavailable' ? 'Unavailable' : 'Prefer to work') + ' · ' + formatTime(rule.startTime) + '–' + formatTime(rule.endTime)));
      item.appendChild(copy);
      var remove = el('button', 'btn-remove-row', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        remove.disabled = true;
        Auth.apiCall('deleteAvailability', { availabilityId: rule.id }).then(function (result) {
          if (result.ok) loadSchedule(); else remove.disabled = false;
        });
      });
      item.appendChild(remove);
      mount.appendChild(item);
    });
  }

  function setDateDefaults() {
    var today = localDate(new Date());
    document.getElementById('time-off-start').value = today;
    document.getElementById('time-off-end').value = today;
  }

  function bindTimeOffForm() {
    var form = document.getElementById('time-off-form');
    form.startDate.addEventListener('change', function () { if (form.endDate.value < form.startDate.value) form.endDate.value = form.startDate.value; });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = form.querySelector('[data-form-status]');
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      setStatus(status, null, 'Sending request…');
      Auth.apiCall('submitTimeOff', { request: {
        startDate: form.startDate.value,
        endDate: form.endDate.value,
        type: form.type.value,
        reason: form.reason.value.trim()
      } }).then(function (result) {
        button.disabled = false;
        if (result.ok) { form.reset(); setDateDefaults(); setStatus(status, 'success', 'Request sent to Management.'); loadSchedule(); }
        else setStatus(status, 'error', Auth.errorMessage(result, 'Could not send that request.'));
      });
    });
  }

  function renderTimeOff() {
    var mount = document.getElementById('time-off-list');
    mount.innerHTML = '';
    var requests = state.data.timeOff || [];
    if (!requests.length) { mount.appendChild(emptyState('No time-off requests', 'Your requests and their status appear here.')); return; }
    requests.forEach(function (request) {
      var item = el('div', 'request-item');
      var copy = el('div');
      var dateLabel = formatDate(request.startDate, { month: 'short', day: 'numeric' });
      if (request.endDate !== request.startDate) dateLabel += '–' + formatDate(request.endDate, { month: 'short', day: 'numeric' });
      copy.appendChild(el('strong', null, dateLabel));
      copy.appendChild(el('p', null, request.type.toUpperCase() + (request.reason ? ' · ' + request.reason : '')));
      item.appendChild(copy);
      item.appendChild(el('span', 'request-status request-status--' + request.status, request.status));
      mount.appendChild(item);
    });
  }

  function renderNotifications() {
    var unread = (state.data.notifications || []).filter(function (item) { return !item.readAt; });
    var section = document.getElementById('notifications-section');
    var mount = document.getElementById('notifications-list');
    mount.innerHTML = '';
    section.hidden = !unread.length;
    unread.forEach(function (notification) {
      var item = el('div', 'notification-item');
      item.appendChild(el('strong', null, notification.title));
      item.appendChild(el('p', null, notification.message));
      mount.appendChild(item);
    });
  }

  function bindNotificationButton() {
    document.getElementById('mark-notifications-read').addEventListener('click', function () {
      var ids = (state.data.notifications || []).filter(function (item) { return !item.readAt; }).map(function (item) { return item.id; });
      Auth.apiCall('markNotificationsRead', { notificationIds: ids }).then(function (result) { if (result.ok) loadSchedule(); });
    });
  }

  function requestError(result) {
    var messages = {
      not_qualified: 'That shift requires a position you are not assigned to.',
      overlapping_shift: 'That shift overlaps one of your assigned shifts.',
      request_already_pending: 'You already requested that shift.',
      shift_already_assigned: 'Someone else was assigned that shift.'
    };
    if (result.error === 'not_eligible' && result.warnings && result.warnings.length) return result.warnings[0].message;
    return messages[result.error] || Auth.errorMessage(result, 'Could not request that shift.');
  }

  function setPageStatus(stateName, message) { setStatus(document.getElementById('schedule-page-status'), stateName, message); }
  function setStatus(node, stateName, message) {
    node.textContent = message;
    if (stateName) node.setAttribute('data-state', stateName); else node.removeAttribute('data-state');
  }
})();

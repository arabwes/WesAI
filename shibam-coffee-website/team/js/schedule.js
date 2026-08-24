// /team/js/schedule.js — employee schedule, availability, and requests.
(function () {
  'use strict';

  var today = new Date();
  var state = {
    weekStart: mondayFor(today),
    data: null,
    availabilityDraft: null,
    availabilityMonth: new Date(today.getFullYear(), today.getMonth(), 1)
  };
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    bindWeekControls();
    bindAvailabilityEditor();
    bindTimeOffForm();
    bindNotificationButton();
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

  function bindAvailabilityEditor() {
    document.querySelectorAll('[data-availability-tab]').forEach(function (button) {
      button.addEventListener('click', function () { selectAvailabilityTab(button.dataset.availabilityTab); });
    });
    document.getElementById('save-weekly-availability').addEventListener('click', saveWeeklyAvailability);
    document.getElementById('copy-monday-weekdays').addEventListener('click', copyMondayToWeekdays);
    document.getElementById('previous-availability-month').addEventListener('click', function () { changeAvailabilityMonth(-1); });
    document.getElementById('next-availability-month').addEventListener('click', function () { changeAvailabilityMonth(1); });
    document.getElementById('current-availability-month').addEventListener('click', function () {
      var current = new Date();
      state.availabilityMonth = new Date(current.getFullYear(), current.getMonth(), 1);
      renderAvailabilityCalendar();
    });

    var dialog = document.getElementById('availability-exception-dialog');
    var form = document.getElementById('availability-exception-form');
    document.getElementById('close-availability-exception').addEventListener('click', function () { dialog.close(); });
    document.getElementById('cancel-availability-exception').addEventListener('click', function () { dialog.close(); });
    form.allDay.addEventListener('change', updateExceptionTimeVisibility);
    form.date.addEventListener('change', function () { populateExceptionForm(form.date.value); });
    form.addEventListener('submit', saveAvailabilityException);
    document.getElementById('delete-availability-exception').addEventListener('click', deleteAvailabilityException);
  }

  function selectAvailabilityTab(name) {
    document.querySelectorAll('[data-availability-tab]').forEach(function (button) {
      var active = button.dataset.availabilityTab === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.getElementById('regular-availability-panel').hidden = name !== 'regular';
    document.getElementById('exceptions-availability-panel').hidden = name !== 'exceptions';
    if (name === 'exceptions') renderAvailabilityCalendar();
  }

  function availabilityDraft(rules) {
    return [1, 2, 3, 4, 5, 6, 0].map(function (weekday) {
      var dayRules = rules.filter(function (rule) { return rule.weekday === weekday; });
      return {
        weekday: weekday,
        mode: dayRules.length ? dayRules[0].preference : 'available',
        windows: dayRules.map(function (rule) { return { startTime: rule.startTime, endTime: rule.endTime }; })
      };
    });
  }

  function renderAvailability() {
    state.availabilityDraft = availabilityDraft(state.data.availability || []);
    renderWeeklyAvailability();
    renderAvailabilityCalendar();
    renderAvailabilitySummary();
  }

  function renderWeeklyAvailability() {
    var mount = document.getElementById('weekly-availability-editor');
    mount.innerHTML = '';
    state.availabilityDraft.forEach(function (day) {
      var card = el('article', 'availability-day availability-day--' + day.mode);
      var heading = el('div', 'availability-day__heading');
      var title = el('div');
      title.appendChild(el('h3', null, DAYS[day.weekday]));
      title.appendChild(el('span', 'availability-day__caption', day.mode === 'available' ? 'No restrictions' : day.windows.length + ' time window' + (day.windows.length === 1 ? '' : 's')));
      heading.appendChild(title);

      var mode = document.createElement('select');
      mode.className = 'availability-mode';
      mode.setAttribute('aria-label', DAYS[day.weekday] + ' availability status');
      [['available', 'Available'], ['preferred', 'Prefer to work'], ['unavailable', 'Unavailable']].forEach(function (choice) {
        var option = el('option', null, choice[1]);
        option.value = choice[0];
        option.selected = day.mode === choice[0];
        mode.appendChild(option);
      });
      mode.addEventListener('change', function () {
        day.mode = mode.value;
        if (day.mode === 'available') day.windows = [];
        else if (!day.windows.length) day.windows = [{ startTime: '09:00', endTime: '17:00' }];
        renderWeeklyAvailability();
        renderAvailabilitySummary();
      });
      heading.appendChild(mode);
      card.appendChild(heading);

      if (day.mode === 'available') {
        card.appendChild(el('p', 'availability-day__available', '✓ Available all day unless a date exception says otherwise.'));
      } else {
        var windows = el('div', 'availability-windows');
        day.windows.forEach(function (windowValue, index) {
          windows.appendChild(buildAvailabilityWindow(day, windowValue, index));
        });
        card.appendChild(windows);
        var windowActions = el('div', 'availability-window-actions');
        var addWindow = el('button', 'availability-add-window', '+ Add time window');
        addWindow.type = 'button';
        addWindow.disabled = day.windows.length >= 5;
        addWindow.addEventListener('click', function () {
          day.windows.push({ startTime: '09:00', endTime: '17:00' });
          renderWeeklyAvailability();
        });
        windowActions.appendChild(addWindow);
        var allDay = el('button', 'availability-add-window', 'Set all day');
        allDay.type = 'button';
        allDay.addEventListener('click', function () {
          day.windows = [{ startTime: '00:00', endTime: '23:59' }];
          renderWeeklyAvailability();
        });
        windowActions.appendChild(allDay);
        card.appendChild(windowActions);
      }
      mount.appendChild(card);
    });
  }

  function buildAvailabilityWindow(day, windowValue, index) {
    var row = el('div', 'availability-window');
    var startLabel = el('label', null, 'From');
    var start = document.createElement('input');
    start.type = 'time';
    start.value = windowValue.startTime;
    start.setAttribute('aria-label', DAYS[day.weekday] + ' window ' + (index + 1) + ' start time');
    start.addEventListener('change', function () { windowValue.startTime = start.value; });
    startLabel.appendChild(start);
    row.appendChild(startLabel);
    row.appendChild(el('span', 'availability-window__dash', '—'));
    var endLabel = el('label', null, 'To');
    var end = document.createElement('input');
    end.type = 'time';
    end.value = windowValue.endTime;
    end.setAttribute('aria-label', DAYS[day.weekday] + ' window ' + (index + 1) + ' end time');
    end.addEventListener('change', function () { windowValue.endTime = end.value; });
    endLabel.appendChild(end);
    row.appendChild(endLabel);
    var remove = el('button', 'availability-remove-window', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove ' + DAYS[day.weekday] + ' time window ' + (index + 1));
    remove.addEventListener('click', function () {
      day.windows.splice(index, 1);
      if (!day.windows.length) day.mode = 'available';
      renderWeeklyAvailability();
      renderAvailabilitySummary();
    });
    row.appendChild(remove);
    return row;
  }

  function copyMondayToWeekdays() {
    var monday = state.availabilityDraft.find(function (day) { return day.weekday === 1; });
    state.availabilityDraft.forEach(function (day) {
      if (day.weekday >= 2 && day.weekday <= 5) {
        day.mode = monday.mode;
        day.windows = monday.windows.map(function (windowValue) { return { ...windowValue }; });
      }
    });
    renderWeeklyAvailability();
    renderAvailabilitySummary();
    setStatus(document.getElementById('availability-status'), 'success', 'Monday was copied to Tuesday through Friday. Save to apply.');
  }

  function weeklyAvailabilityPayload() {
    var rules = [];
    state.availabilityDraft.forEach(function (day) {
      if (day.mode === 'available') return;
      var sorted = day.windows.slice().sort(function (left, right) { return left.startTime.localeCompare(right.startTime); });
      sorted.forEach(function (windowValue, index) {
        if (!windowValue.startTime || !windowValue.endTime || windowValue.startTime >= windowValue.endTime) {
          throw new Error(DAYS[day.weekday] + ' has an invalid time window.');
        }
        if (index && sorted[index - 1].endTime > windowValue.startTime) {
          throw new Error(DAYS[day.weekday] + ' has overlapping time windows.');
        }
        rules.push({
          weekday: day.weekday,
          preference: day.mode,
          startTime: windowValue.startTime,
          endTime: windowValue.endTime
        });
      });
    });
    return rules;
  }

  function saveWeeklyAvailability() {
    var button = document.getElementById('save-weekly-availability');
    var status = document.getElementById('availability-status');
    var rules;
    try { rules = weeklyAvailabilityPayload(); }
    catch (error) { setStatus(status, 'error', error.message); return; }
    button.disabled = true;
    setStatus(status, null, 'Saving your regular week…');
    Auth.apiCall('replaceAvailability', { availability: rules }).then(function (result) {
      button.disabled = false;
      if (result.ok) {
        setStatus(status, 'success', 'Weekly availability saved.');
        loadSchedule();
      } else {
        setStatus(status, 'error', result.error === 'overlapping_availability'
          ? 'Time windows cannot overlap.' : Auth.errorMessage(result, 'Could not save availability.'));
      }
    }).catch(function () {
      button.disabled = false;
      setStatus(status, 'error', 'Could not reach the server. Try again.');
    });
  }

  function renderAvailabilitySummary() {
    var preferred = state.availabilityDraft.filter(function (day) { return day.mode === 'preferred'; }).length;
    var unavailable = state.availabilityDraft.filter(function (day) { return day.mode === 'unavailable'; }).length;
    var exceptions = (state.data.availabilityExceptions || []).filter(function (item) { return item.date >= localDate(new Date()); }).length;
    var parts = [];
    if (preferred) parts.push(preferred + ' preferred day' + (preferred === 1 ? '' : 's'));
    if (unavailable) parts.push(unavailable + ' restricted day' + (unavailable === 1 ? '' : 's'));
    if (exceptions) parts.push(exceptions + ' upcoming exception' + (exceptions === 1 ? '' : 's'));
    document.getElementById('availability-summary').textContent = parts.length ? parts.join(' · ') : 'Available all week';
  }

  function changeAvailabilityMonth(amount) {
    state.availabilityMonth = new Date(state.availabilityMonth.getFullYear(), state.availabilityMonth.getMonth() + amount, 1);
    renderAvailabilityCalendar();
  }

  function renderAvailabilityCalendar() {
    if (!state.data) return;
    var month = state.availabilityMonth;
    document.getElementById('availability-month-label').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var mount = document.getElementById('availability-calendar-grid');
    mount.innerHTML = '';
    var firstOffset = (month.getDay() + 6) % 7;
    var firstCell = new Date(month.getFullYear(), month.getMonth(), 1 - firstOffset);
    var todayString = localDate(new Date());
    for (var index = 0; index < 42; index += 1) {
      var cellDate = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index);
      var dateString = localDate(cellDate);
      var exception = findAvailabilityException(dateString);
      var button = el('button', 'availability-calendar__day');
      button.type = 'button';
      if (cellDate.getMonth() !== month.getMonth()) button.classList.add('is-adjacent');
      if (dateString === todayString) button.classList.add('is-today');
      if (exception) button.classList.add('has-exception', 'is-' + exception.preference);
      button.setAttribute('aria-label', formatDate(dateString) + (exception ? ', ' + availabilityPreferenceLabel(exception.preference) : ', available'));
      button.appendChild(el('span', 'availability-calendar__number', String(cellDate.getDate())));
      if (exception) {
        button.appendChild(el('span', 'availability-calendar__event', availabilityPreferenceLabel(exception.preference)));
        if (!exception.allDay) button.appendChild(el('small', null, formatTime(exception.startTime) + '–' + formatTime(exception.endTime)));
      } else if (cellDate.getMonth() === month.getMonth()) {
        button.appendChild(el('span', 'availability-calendar__add', '+ Add'));
      }
      (function (selectedDate) {
        button.addEventListener('click', function () { openAvailabilityException(selectedDate); });
      })(dateString);
      mount.appendChild(button);
    }
  }

  function findAvailabilityException(dateString) {
    return (state.data.availabilityExceptions || []).find(function (item) { return item.date === dateString; });
  }

  function availabilityPreferenceLabel(preference) {
    return preference === 'preferred' ? 'Prefer to work' : 'Unavailable';
  }

  function openAvailabilityException(dateString) {
    populateExceptionForm(dateString);
    document.getElementById('availability-exception-dialog').showModal();
  }

  function populateExceptionForm(dateString) {
    var form = document.getElementById('availability-exception-form');
    var exception = findAvailabilityException(dateString);
    form.reset();
    form.exceptionId.value = exception ? exception.id : '';
    form.date.value = dateString;
    form.preference.value = exception ? exception.preference : 'unavailable';
    form.allDay.checked = exception ? exception.allDay : true;
    form.startTime.value = exception && !exception.allDay ? exception.startTime : '09:00';
    form.endTime.value = exception && !exception.allDay ? exception.endTime : '17:00';
    form.note.value = exception ? exception.note : '';
    document.getElementById('availability-exception-heading').textContent = exception ? 'Edit exception' : 'Add exception';
    document.getElementById('delete-availability-exception').hidden = !exception;
    setStatus(form.querySelector('[data-form-status]'), null, '');
    updateExceptionTimeVisibility();
  }

  function updateExceptionTimeVisibility() {
    var form = document.getElementById('availability-exception-form');
    document.getElementById('availability-exception-times').hidden = form.allDay.checked;
    form.startTime.required = !form.allDay.checked;
    form.endTime.required = !form.allDay.checked;
  }

  function saveAvailabilityException(event) {
    event.preventDefault();
    var form = event.currentTarget;
    var button = form.querySelector('button[type="submit"]');
    var status = form.querySelector('[data-form-status]');
    if (!form.allDay.checked && form.startTime.value >= form.endTime.value) {
      setStatus(status, 'error', 'The end time must be after the start time.');
      return;
    }
    button.disabled = true;
    setStatus(status, null, 'Saving exception…');
    Auth.apiCall('saveAvailabilityException', { exception: {
      id: form.exceptionId.value,
      date: form.date.value,
      preference: form.preference.value,
      allDay: form.allDay.checked,
      startTime: form.startTime.value,
      endTime: form.endTime.value,
      note: form.note.value.trim()
    } }).then(function (result) {
      button.disabled = false;
      if (result.ok) {
        document.getElementById('availability-exception-dialog').close();
        loadSchedule();
        selectAvailabilityTab('exceptions');
      } else setStatus(status, 'error', Auth.errorMessage(result, 'Could not save this exception.'));
    }).catch(function () {
      button.disabled = false;
      setStatus(status, 'error', 'Could not reach the server. Try again.');
    });
  }

  function deleteAvailabilityException() {
    var form = document.getElementById('availability-exception-form');
    if (!form.exceptionId.value || !window.confirm('Delete this date exception?')) return;
    var button = document.getElementById('delete-availability-exception');
    button.disabled = true;
    Auth.apiCall('deleteAvailabilityException', { exceptionId: form.exceptionId.value }).then(function (result) {
      button.disabled = false;
      if (result.ok) {
        document.getElementById('availability-exception-dialog').close();
        loadSchedule();
        selectAvailabilityTab('exceptions');
      } else setStatus(form.querySelector('[data-form-status]'), 'error', Auth.errorMessage(result, 'Could not delete this exception.'));
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

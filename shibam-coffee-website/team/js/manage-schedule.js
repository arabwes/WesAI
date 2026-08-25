// /team/js/manage-schedule.js — management weekly schedule builder.
(function () {
  'use strict';

  var state = { weekStart: mondayFor(new Date()), data: null };
  var dialog;
  var form;

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    dialog = document.getElementById('shift-dialog');
    form = document.getElementById('shift-form');
    bindWeekControls();
    bindToolbar();
    bindShiftDialog();
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
    return new Date(dateString + 'T12:00:00').toLocaleDateString(undefined, options || { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatTime(value) {
    var parts = value.split(':').map(Number);
    return new Date(2000, 0, 1, parts[0], parts[1]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function shiftMinutes(shift) {
    var start = shift.startTime.split(':').map(Number);
    var end = shift.endTime.split(':').map(Number);
    return end[0] * 60 + end[1] - start[0] * 60 - start[1] - shift.breakMinutes;
  }

  function bindWeekControls() {
    document.getElementById('manage-previous-week').addEventListener('click', function () { state.weekStart = addDays(state.weekStart, -7); loadSchedule(); });
    document.getElementById('manage-next-week').addEventListener('click', function () { state.weekStart = addDays(state.weekStart, 7); loadSchedule(); });
    document.getElementById('manage-current-week').addEventListener('click', function () { state.weekStart = mondayFor(new Date()); loadSchedule(); });
  }

  function bindToolbar() {
    document.getElementById('add-shift').addEventListener('click', function () { openShiftDialog(null, state.weekStart); });
    document.getElementById('copy-previous').addEventListener('click', function () {
      if (!window.confirm('Copy every active shift from the previous week into this draft?')) return;
      setPageStatus(null, 'Copying previous week…');
      Auth.apiCall('copySchedule', { sourceWeekStart: addDays(state.weekStart, -7), targetWeekStart: state.weekStart }).then(function (result) {
        if (result.ok) { setPageStatus('success', result.copiedShifts + ' shifts copied.'); loadSchedule(); }
        else setPageStatus('error', copyError(result));
      });
    });
    document.getElementById('publish-schedule').addEventListener('click', function () {
      if (!state.data || !state.data.schedule) return;
      if (!window.confirm('Publish this schedule? The team will be notified.')) return;
      var button = this;
      button.disabled = true;
      setPageStatus(null, 'Publishing schedule…');
      Auth.apiCall('publishSchedule', { scheduleId: state.data.schedule.id }).then(function (result) {
        button.disabled = false;
        if (result.ok) { setPageStatus('success', 'Schedule published.'); loadSchedule(); }
        else setPageStatus('error', Auth.errorMessage(result, 'Could not publish the schedule.'));
      });
    });
  }

  function loadSchedule() {
    setPageStatus(null, 'Loading schedule…');
    document.getElementById('manage-week-label').textContent = formatDate(state.weekStart, { month: 'long', day: 'numeric' }) + '–' + formatDate(addDays(state.weekStart, 6), { month: 'long', day: 'numeric', year: 'numeric' });
    Auth.apiCall('getManagerSchedule', { weekStart: state.weekStart, create: true }).then(function (result) {
      if (!result.ok) { setPageStatus('error', Auth.errorMessage(result, 'Could not load the schedule.')); return; }
      state.data = result;
      document.dispatchEvent(new CustomEvent('schedule:loaded', { detail: { data: result, weekStart: state.weekStart } }));
      setPageStatus(null, '');
      document.getElementById('schedule-state').textContent = result.schedule.status;
      document.getElementById('schedule-state').className = 'schedule-state schedule-state--' + result.schedule.status;
      document.getElementById('publish-schedule').textContent = result.schedule.status === 'published' ? 'Republish & notify all' : 'Publish schedule';
      populateShiftOptions();
      renderGrid();
      renderRequests();
    }).catch(function () { setPageStatus('error', 'Could not load the schedule.'); });
  }

  function populateShiftOptions() {
    var employee = form.employeeId;
    var position = form.positionId;
    employee.innerHTML = '<option value="">Open shift</option>';
    position.innerHTML = '<option value="">No position</option>';
    state.data.team.forEach(function (user) {
      var option = el('option', null, user.name + ' · ' + user.role);
      option.value = user.id;
      employee.appendChild(option);
    });
    state.data.positions.forEach(function (item) {
      var option = el('option', null, item.name);
      option.value = item.id;
      position.appendChild(option);
    });
  }

  function renderGrid() {
    var mount = document.getElementById('manager-schedule-grid');
    mount.innerHTML = '';
    var grid = el('div', 'schedule-grid-table');
    grid.style.setProperty('--schedule-columns', 'minmax(150px, 1.1fr) repeat(7, minmax(145px, 1fr))');
    grid.appendChild(el('div', 'schedule-grid-cell schedule-grid-cell--corner', 'Employee'));
    for (var day = 0; day < 7; day++) {
      var date = addDays(state.weekStart, day);
      var header = el('div', 'schedule-grid-cell schedule-grid-cell--day');
      header.appendChild(el('strong', null, formatDate(date, { weekday: 'short' })));
      header.appendChild(el('span', null, formatDate(date, { month: 'short', day: 'numeric' })));
      var add = el('button', 'day-add-button', '+');
      add.type = 'button';
      add.setAttribute('aria-label', 'Add shift on ' + formatDate(date));
      add.addEventListener('click', openForDate(date));
      header.appendChild(add);
      grid.appendChild(header);
    }

    var rows = state.data.team.map(function (user) { return { user: user, id: user.id, name: user.name }; });
    rows.push({ user: null, id: '', name: 'Open shifts' });
    rows.forEach(function (row) {
      var label = el('div', row.id ? 'schedule-grid-cell schedule-grid-cell--employee' : 'schedule-grid-cell schedule-grid-cell--employee schedule-grid-cell--open');
      label.appendChild(el('strong', null, row.name));
      if (row.user) {
        var minutes = state.data.shifts.filter(function (shift) { return shift.employeeId === row.id; }).reduce(function (sum, shift) { return sum + shiftMinutes(shift); }, 0);
        label.appendChild(el('span', null, (minutes / 60).toFixed(minutes % 60 ? 1 : 0) + ' hrs'));
      }
      grid.appendChild(label);
      for (var day = 0; day < 7; day++) {
        var date = addDays(state.weekStart, day);
        var cell = el('div', 'schedule-grid-cell schedule-grid-cell--shifts');
        var shifts = state.data.shifts.filter(function (shift) { return shift.employeeId === row.id && shift.date === date; });
        shifts.forEach(function (shift) { cell.appendChild(buildGridShift(shift)); });
        var unavailability = row.id ? availabilityFor(row.id, day === 6 ? 0 : day + 1, date) : [];
        if (unavailability.length) cell.appendChild(el('span', 'availability-note', unavailability.join(', ')));
        grid.appendChild(cell);
      }
    });
    mount.appendChild(grid);
    var total = state.data.shifts.reduce(function (sum, shift) { return sum + shiftMinutes(shift); }, 0);
    var open = state.data.shifts.filter(function (shift) { return !shift.employeeId; }).length;
    document.getElementById('schedule-totals').textContent = state.data.shifts.length + ' shifts · ' + (total / 60).toFixed(1) + ' labor hours · ' + open + ' open';
  }

  function openForDate(date) { return function () { openShiftDialog(null, date); }; }

  function availabilityFor(employeeId, weekday, date) {
    var recurring = (state.data.availability || []).filter(function (rule) {
      return rule.employeeId === employeeId && rule.weekday === weekday && rule.preference === 'unavailable';
    }).map(function (rule) { return 'Unavailable ' + formatTime(rule.startTime) + '–' + formatTime(rule.endTime); });
    var exceptions = (state.data.availabilityExceptions || []).filter(function (item) {
      return item.employeeId === employeeId && item.date === date;
    }).map(function (item) {
      var label = item.preference === 'preferred' ? 'Prefers' : 'Unavailable';
      return label + (item.allDay ? ' all day' : ' ' + formatTime(item.startTime) + '–' + formatTime(item.endTime));
    });
    return recurring.concat(exceptions);
  }

  function buildGridShift(shift) {
    var button = el('button', 'grid-shift' + (!shift.employeeId ? ' grid-shift--open' : '') + (shift.overrideReason ? ' grid-shift--warning' : ''));
    button.type = 'button';
    button.style.setProperty('--shift-color', shift.positionColor || '#A56A24');
    button.appendChild(el('strong', null, formatTime(shift.startTime) + '–' + formatTime(shift.endTime)));
    button.appendChild(el('span', null, shift.positionName || 'Shift'));
    if (shift.breakMinutes) button.appendChild(el('small', null, shift.breakMinutes + ' min break'));
    button.addEventListener('click', function () { openShiftDialog(shift, shift.date); });
    return button;
  }

  function bindShiftDialog() {
    document.getElementById('close-shift-dialog').addEventListener('click', closeDialog);
    document.getElementById('dismiss-shift').addEventListener('click', closeDialog);
    document.getElementById('cancel-shift').addEventListener('click', function () {
      if (!form.id.value || !window.confirm('Cancel this shift? Published employees will be notified.')) return;
      var button = this;
      button.disabled = true;
      Auth.apiCall('cancelShift', { shiftId: form.id.value }).then(function (result) {
        button.disabled = false;
        if (result.ok) { closeDialog(); loadSchedule(); }
        else setFormStatus('error', Auth.errorMessage(result, 'Could not cancel the shift.'));
      });
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      saveCurrentShift();
    });
  }

  function openShiftDialog(shift, date) {
    form.reset();
    form.id.value = shift ? shift.id : '';
    form.version.value = shift ? shift.version : '';
    form.employeeId.value = shift ? shift.employeeId : '';
    form.positionId.value = shift ? shift.positionId : '';
    form.date.value = shift ? shift.date : date;
    form.startTime.value = shift ? shift.startTime : '08:00';
    form.endTime.value = shift ? shift.endTime : '16:00';
    form.breakMinutes.value = String(shift ? shift.breakMinutes : 30);
    form.notes.value = shift ? shift.notes : '';
    form.overrideReason.value = '';
    document.getElementById('shift-dialog-title').textContent = shift ? 'Edit shift' : 'Add shift';
    document.getElementById('cancel-shift').hidden = !shift;
    document.getElementById('shift-conflicts').hidden = true;
    document.getElementById('override-field').hidden = true;
    setFormStatus(null, '');
    dialog.showModal();
  }

  function closeDialog() { dialog.close(); }

  function saveCurrentShift() {
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setFormStatus(null, 'Saving…');
    var payload = {
      shift: {
        id: form.id.value || undefined,
        version: form.version.value ? Number(form.version.value) : undefined,
        scheduleId: state.data.schedule.id,
        employeeId: form.employeeId.value,
        positionId: form.positionId.value,
        date: form.date.value,
        startTime: form.startTime.value,
        endTime: form.endTime.value,
        breakMinutes: Number(form.breakMinutes.value),
        notes: form.notes.value.trim()
      },
      overrideReason: form.overrideReason.value.trim()
    };
    Auth.apiCall('saveShift', payload).then(function (result) {
      button.disabled = false;
      if (result.ok) { closeDialog(); loadSchedule(); return; }
      if (result.error === 'schedule_conflict') { showConflicts(result); return; }
      setFormStatus('error', Auth.errorMessage(result, 'Could not save the shift.'));
    }).catch(function () { button.disabled = false; setFormStatus('error', 'Could not save the shift.'); });
  }

  function showConflicts(result) {
    var mount = document.getElementById('shift-conflicts');
    mount.innerHTML = '';
    mount.hidden = false;
    mount.appendChild(el('strong', null, 'Scheduling concerns'));
    var list = el('ul');
    (result.warnings || []).forEach(function (warning) { list.appendChild(el('li', null, warning.message)); });
    mount.appendChild(list);
    if (result.canOverride) {
      document.getElementById('override-field').hidden = false;
      setFormStatus('error', 'Management can enter a reason and save again to override these concerns.');
      form.overrideReason.focus();
    } else {
      setFormStatus('error', 'Ask Management to review this assignment.');
    }
  }

  function renderRequests() {
    renderTimeOffRequests();
    renderShiftRequests();
  }

  function renderTimeOffRequests() {
    var mount = document.getElementById('manager-time-off');
    mount.innerHTML = '';
    var requests = (state.data.timeOff || []).filter(function (request) { return request.status === 'pending'; });
    if (!requests.length) { mount.appendChild(emptyState('No pending requests', 'Time-off requests for this week are clear.')); return; }
    requests.forEach(function (request) {
      var item = requestItem(request.employeeName, formatDate(request.startDate) + (request.endDate !== request.startDate ? '–' + formatDate(request.endDate) : ''), request.reason || request.type.toUpperCase());
      item.appendChild(approvalButtons(function (status) {
        return Auth.apiCall('reviewTimeOff', { requestId: request.id, status: status }).then(function (result) { if (result.ok) loadSchedule(); else setPageStatus('error', Auth.errorMessage(result)); });
      }));
      mount.appendChild(item);
    });
  }

  function renderShiftRequests() {
    var mount = document.getElementById('manager-shift-requests');
    mount.innerHTML = '';
    var requests = state.data.requests || [];
    if (!requests.length) { mount.appendChild(emptyState('No pending requests', 'Open-shift requests appear here.')); return; }
    requests.forEach(function (request) {
      var item = requestItem(request.employeeName, formatDate(request.date) + ' · ' + formatTime(request.startTime) + '–' + formatTime(request.endTime), request.positionName || 'Open shift');
      item.appendChild(approvalButtons(function (status) {
        return Auth.apiCall('reviewShiftRequest', { requestId: request.id, status: status }).then(function (result) { if (result.ok) loadSchedule(); else setPageStatus('error', requestError(result)); });
      }));
      mount.appendChild(item);
    });
  }

  function requestItem(title, subtitle, detail) {
    var item = el('article', 'request-card');
    item.appendChild(el('strong', null, title));
    item.appendChild(el('p', null, subtitle));
    if (detail) item.appendChild(el('small', null, detail));
    return item;
  }

  function approvalButtons(handler) {
    var actions = el('div', 'request-actions');
    var approve = el('button', 'btn btn-primary btn-small', 'Approve');
    var decline = el('button', 'btn-outline btn-small', 'Decline');
    approve.type = decline.type = 'button';
    approve.addEventListener('click', function () { approve.disabled = decline.disabled = true; handler('approved').finally(function () { approve.disabled = decline.disabled = false; }); });
    decline.addEventListener('click', function () { approve.disabled = decline.disabled = true; handler('declined').finally(function () { approve.disabled = decline.disabled = false; }); });
    actions.appendChild(approve);
    actions.appendChild(decline);
    return actions;
  }

  function emptyState(title, message) {
    var wrap = el('div', 'schedule-empty');
    wrap.appendChild(el('strong', null, title));
    wrap.appendChild(el('p', null, message));
    return wrap;
  }

  function copyError(result) {
    var messages = { source_schedule_not_found: 'There is no schedule to copy from last week.', target_not_empty: 'This week already has shifts. Clear them before copying.', target_already_published: 'A published schedule cannot be replaced by a copy.' };
    return messages[result.error] || Auth.errorMessage(result, 'Could not copy the previous week.');
  }

  function requestError(result) {
    if (result.error === 'shift_already_assigned') return 'That open shift was already assigned.';
    if (result.error === 'request_no_longer_eligible' && result.warnings && result.warnings.length) return result.warnings[0].message;
    return Auth.errorMessage(result, 'Could not review that request.');
  }

  function setPageStatus(stateName, message) { setStatus(document.getElementById('manage-status'), stateName, message); }
  function setFormStatus(stateName, message) { setStatus(form.querySelector('[data-form-status]'), stateName, message); }
  function setStatus(node, stateName, message) {
    node.textContent = message;
    if (stateName) node.setAttribute('data-state', stateName); else node.removeAttribute('data-state');
  }
})();

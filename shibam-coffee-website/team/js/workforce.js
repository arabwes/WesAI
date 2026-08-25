(function () {
  'use strict';
  var state = { schedule: null, weekStart: '', templates: [], rotations: [], positions: [] };

  document.addEventListener('DOMContentLoaded', function () {
    bindForms();
    document.addEventListener('schedule:loaded', function (event) {
      state.schedule = event.detail.data.schedule;
      state.weekStart = event.detail.weekStart;
      state.positions = event.detail.data.positions || [];
      populatePositions(); loadAll();
    });
  });

  function bindForms() {
    document.getElementById('create-template-form').addEventListener('submit', function (event) {
      event.preventDefault(); var form = event.currentTarget;
      if (!state.schedule) return setForm(form, 'error', 'Create this week before saving a template.');
      Auth.apiCall('createTemplateFromSchedule', { scheduleId: state.schedule.id, name: form.name.value, description: form.description.value }).then(function (result) {
        if (result.ok) { form.reset(); setForm(form, 'success', 'Template saved.'); loadTemplates(); }
        else setForm(form, 'error', result.error === 'template_name_taken' ? 'That template name is already in use.' : Auth.errorMessage(result));
      });
    });
    document.getElementById('rotation-form').addEventListener('submit', function (event) {
      event.preventDefault(); var form = event.currentTarget;
      var templateIds = Array.from(form.querySelectorAll('[name="templateIds"]:checked')).map(function (input) { return input.value; });
      Auth.apiCall('saveScheduleRotation', { name: form.name.value, startsOn: form.startsOn.value, templateIds: templateIds }).then(function (result) {
        if (result.ok) { form.reset(); setForm(form, 'success', 'Rotation saved.'); loadTemplates(); }
        else setForm(form, 'error', Auth.errorMessage(result, 'Could not save rotation.'));
      });
    });
    document.getElementById('coverage-position').addEventListener('change', loadCoverage);
  }

  function loadAll() { loadExchanges(); loadTemplates(); loadCoverage(); loadHistory(); }

  function loadExchanges() {
    var mount = document.getElementById('manager-exchanges');
    Auth.apiCall('getExchangeData', {}).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok) return;
      var exchanges = (result.exchanges || []).filter(function (item) { return ['open', 'employee_accepted'].includes(item.status); });
      if (!exchanges.length) return mount.appendChild(empty('No pending trades or drops.'));
      exchanges.forEach(function (exchange) {
        var card = featureCard(exchange.type === 'swap' ? 'Direct swap' : 'Shift drop', exchange.requesterName + ' · ' + exchange.offeredDate + ' · ' + formatTime(exchange.offeredStartTime) + '–' + formatTime(exchange.offeredEndTime));
        var actions = document.createElement('div'); actions.className = 'request-actions';
        if (exchange.type === 'drop') {
          var select = document.createElement('select'); select.setAttribute('aria-label', 'Choose employee');
          (exchange.candidates || []).filter(function (candidate) { return candidate.status === 'volunteered'; }).forEach(function (candidate) { var option = document.createElement('option'); option.value = candidate.employeeId; option.textContent = candidate.employeeName; select.appendChild(option); });
          actions.appendChild(select);
          var approve = action('Approve coverage', 'btn btn-primary btn-small', function () { return reviewExchange(exchange.id, 'approved', select.value); }); approve.disabled = !select.options.length; actions.appendChild(approve);
        } else {
          var swap = action(exchange.status === 'employee_accepted' ? 'Approve swap' : 'Waiting for coworker', 'btn btn-primary btn-small', function () { return reviewExchange(exchange.id, 'approved'); }); swap.disabled = exchange.status !== 'employee_accepted'; actions.appendChild(swap);
        }
        actions.appendChild(action('Decline', 'btn-remove-row', function () { return reviewExchange(exchange.id, 'declined'); })); card.appendChild(actions); mount.appendChild(card);
      });
    });
  }

  function reviewExchange(id, status, candidate) {
    return Auth.apiCall('reviewExchangeRequest', { exchangeId: id, status: status, candidateEmployeeId: candidate || '' }).then(function (result) {
      if (result.ok) { loadExchanges(); document.dispatchEvent(new Event('schedule:refresh-requested')); location.reload(); }
      else window.alert(result.warnings && result.warnings.length ? result.warnings[0].message : Auth.errorMessage(result, 'Could not review exchange.'));
    });
  }

  function loadTemplates() {
    Auth.apiCall('listScheduleTemplates', {}).then(function (result) {
      if (!result.ok) return; state.templates = result.templates || []; state.rotations = result.rotations || []; renderTemplates(); renderRotations();
    });
  }

  function renderTemplates() {
    var mount = document.getElementById('template-list'); mount.innerHTML = '';
    state.templates.forEach(function (template) {
      var card = featureCard(template.name, template.shifts.length + ' shifts' + (template.description ? ' · ' + template.description : ''));
      card.appendChild(action('Apply to this draft', 'btn btn-primary btn-small', function () {
        if (!state.schedule) return Promise.resolve();
        return applyTemplate(template, false, '');
      }));
      if (Auth.hasRole(Auth.getSession(), 'management')) card.appendChild(action('Archive', 'btn-remove-row', function () { return Auth.apiCall('deleteScheduleTemplate', { templateId: template.id }).then(loadTemplates); }));
      mount.appendChild(card);
    });
    if (!mount.children.length) mount.appendChild(empty('Save a completed week to create your first template.'));
    var options = document.getElementById('rotation-template-options'); options.innerHTML = '';
    state.templates.forEach(function (template) { var label = document.createElement('label'); label.innerHTML = '<input type="checkbox" name="templateIds" value="' + template.id + '"> <span></span>'; label.querySelector('span').textContent = template.name; options.appendChild(label); });
    if (state.weekStart) document.getElementById('rotation-start').value = state.weekStart;
  }

  function applyTemplate(template, replace, overrideReason) {
    return Auth.apiCall('applyScheduleTemplate', { templateId: template.id, scheduleId: state.schedule.id, replace: replace, overrideReason: overrideReason }).then(function (result) {
      if (result.ok) { location.reload(); return result; }
      if (result.error === 'target_not_empty' && window.confirm('This draft is not empty. Replace its shifts with the template?')) return applyTemplate(template, true, overrideReason);
      if (result.error === 'template_conflicts' && result.canOverride) {
        var reason = window.prompt('This template has scheduling concerns. Enter a Management override reason to continue:');
        if (reason && reason.trim()) return applyTemplate(template, replace, reason.trim());
      } else window.alert(Auth.errorMessage(result, 'Could not apply template.'));
      return result;
    });
  }

  function renderRotations() {
    var mount = document.getElementById('rotation-list'); mount.innerHTML = '';
    state.rotations.forEach(function (rotation) {
      var card = featureCard(rotation.name, rotation.templateIds.length + '-week rotation beginning ' + rotation.startsOn);
      card.appendChild(action('Generate next 4 drafts', 'btn-outline btn-small', function () { return Auth.apiCall('generateScheduleRotation', { rotationId: rotation.id, firstWeek: state.weekStart, weeks: 4 }).then(function (result) { if (result.ok) window.alert(result.weeks.map(function (week) { return week.weekStart + ': ' + week.status; }).join('\n')); }); }));
      mount.appendChild(card);
    });
  }

  function populatePositions() {
    var select = document.getElementById('coverage-position'); var value = select.value; select.innerHTML = '<option value="">All positions</option>';
    state.positions.forEach(function (position) { var option = document.createElement('option'); option.value = position.id; option.textContent = position.name; select.appendChild(option); }); select.value = value;
  }

  function loadCoverage() {
    if (!state.weekStart) return; var mount = document.getElementById('coverage-heatmap'); mount.textContent = 'Loading coverage…';
    Auth.apiCall('getTeamCoverage', { weekStart: state.weekStart, positionId: document.getElementById('coverage-position').value }).then(function (result) {
      if (!result.ok) { mount.textContent = 'Could not load coverage.'; return; } renderCoverage(result.slots || []);
    });
  }

  function renderCoverage(slots) {
    var mount = document.getElementById('coverage-heatmap'); mount.innerHTML = '';
    var dates = Array.from(new Set(slots.map(function (slot) { return slot.date; })));
    var times = Array.from(new Set(slots.map(function (slot) { return slot.time; }))).filter(function (time) { return time.endsWith(':00'); });
    var grid = document.createElement('div'); grid.className = 'coverage-grid'; grid.style.setProperty('--coverage-columns', dates.length + 1);
    grid.appendChild(cell('Time', 'coverage-cell coverage-cell--heading'));
    dates.forEach(function (date) { grid.appendChild(cell(new Date(date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), 'coverage-cell coverage-cell--heading')); });
    times.forEach(function (time) {
      grid.appendChild(cell(formatTime(time), 'coverage-cell coverage-cell--time'));
      dates.forEach(function (date) {
        var slot = slots.find(function (item) { return item.date === date && item.time === time; }); var node = cell(slot.available + ' available · ' + slot.scheduled + ' scheduled', 'coverage-cell');
        node.dataset.coverage = slot.available <= slot.scheduled ? 'tight' : slot.scheduled ? 'covered' : 'open';
        node.tabIndex = 0; node.title = slot.people.map(function (person) { return person.name + ': ' + person.reason + (person.scheduled ? ', scheduled' : ''); }).join('\n'); grid.appendChild(node);
      });
    }); mount.appendChild(grid);
  }

  function loadHistory() {
    var mount = document.getElementById('schedule-history'); if (!state.schedule || !Auth.hasRole(Auth.getSession(), 'management')) return;
    Auth.apiCall('getScheduleHistory', { scheduleId: state.schedule.id }).then(function (result) {
      mount.innerHTML = ''; if (!result.ok || !result.versions.length) return mount.appendChild(empty('No captured versions yet. Publish the schedule first.'));
      result.versions.forEach(function (version) { var row = featureCard('Version ' + version.version + ' · ' + version.reason, version.activeShifts + ' active shifts · ' + new Date(version.createdAt).toLocaleString() + ' · ' + version.createdBy);
        if (version.version !== state.schedule.version) row.appendChild(action('Restore this version', 'btn-outline btn-small', function () { if (!window.confirm('Restore version ' + version.version + '? Employees will be notified.')) return Promise.resolve(); return Auth.apiCall('restoreScheduleVersion', { scheduleId: state.schedule.id, versionId: version.id, expectedVersion: state.schedule.version }).then(function (outcome) { if (outcome.ok) location.reload(); else window.alert(Auth.errorMessage(outcome)); }); })); mount.appendChild(row); });
    });
  }

  function formatTime(value) { var parts = value.split(':').map(Number); return new Date(2000, 0, 1, parts[0], parts[1]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function featureCard(title, copy) { var card = document.createElement('article'); card.className = 'request-card feature-card'; var strong = document.createElement('strong'); strong.textContent = title; var p = document.createElement('p'); p.textContent = copy; card.appendChild(strong); card.appendChild(p); return card; }
  function action(label, className, handler) { var button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.addEventListener('click', function () { button.disabled = true; Promise.resolve(handler()).finally(function () { button.disabled = false; }); }); return button; }
  function empty(message) { var node = document.createElement('div'); node.className = 'schedule-empty'; node.textContent = message; return node; }
  function cell(text, className) { var node = document.createElement('div'); node.className = className; node.textContent = text; return node; }
  function setForm(form, kind, message) { var node = form.querySelector('[data-form-status]'); node.textContent = message; if (kind) node.dataset.state = kind; else delete node.dataset.state; }
})();

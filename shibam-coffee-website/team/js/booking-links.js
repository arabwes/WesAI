// /team/js/booking-links.js
// Lead+ setup page: meeting addresses, meeting types and links, booking hours.
// All text is written with textContent; nothing from the server is rendered as HTML.
(function () {
  'use strict';

  var DAYS = [
    { weekday: 1, name: 'Monday' }, { weekday: 2, name: 'Tuesday' }, { weekday: 3, name: 'Wednesday' },
    { weekday: 4, name: 'Thursday' }, { weekday: 5, name: 'Friday' }, { weekday: 6, name: 'Saturday' },
    { weekday: 0, name: 'Sunday' }
  ];
  var state = { locations: [], types: [], weekly: [], timezone: '', avoidShifts: false, overrides: [] };

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('footer-year').textContent = new Date().getFullYear();
    var session = Auth.getSession();
    if (session) document.getElementById('session-banner').textContent = 'Logged in as ' + session.name + ' (' + session.role + ')';
    document.getElementById('new-type-btn').addEventListener('click', function () { openTypeForm(null); });
    document.getElementById('new-location-btn').addEventListener('click', function () { openLocationForm(null); });
    loadAll();
  });

  // ---- helpers ----

  function node(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = value;
    return element;
  }

  function button(label, className, onClick) {
    var element = node('button', className || 'btn-inline-action', label);
    element.type = 'button';
    if (onClick) element.addEventListener('click', onClick);
    return element;
  }

  function say(message, isError) {
    var status = document.getElementById('booking-status');
    status.textContent = message || '';
    status.className = 'booking-status' + (isError ? ' is-error' : '');
  }

  var ERRORS = {
    location_required: 'Choose a meeting address first.',
    location_in_use: 'That address is still used by an active meeting type. Archive or change those first.',
    invalid_postal_code: 'Enter a 5-digit ZIP code.',
    invalid_state: 'Use the two-letter state code, like GA.',
    invalid_hours: 'Each time range needs an end after its start.',
    overlapping_hours: 'Time ranges on the same day cannot overlap.',
    too_many_questions: 'You can ask up to 5 questions.',
    invalid_expiry: 'Pick an expiry date in the future.',
    event_type_archived: 'Restore the meeting type before creating links.',
    session_expired: 'Your session expired. Log in again.'
  };
  function fail(result) {
    say(ERRORS[result && result.error] || 'Something went wrong. Check the form and try again.', true);
  }

  function field(labelText, control, wide) {
    var group = node('div', 'form-group' + (wide ? ' form-group--wide' : ''));
    var label = node('label', null, labelText);
    control.id = control.id || 'f_' + Math.random().toString(36).slice(2, 9);
    label.htmlFor = control.id;
    group.appendChild(label);
    group.appendChild(control);
    return group;
  }

  function input(type, value, attrs) {
    var element = node('input');
    element.type = type;
    element.value = value === undefined || value === null ? '' : value;
    Object.keys(attrs || {}).forEach(function (key) { element.setAttribute(key, attrs[key]); });
    return element;
  }

  function select(options, value) {
    var element = node('select');
    options.forEach(function (option) {
      var item = node('option', null, option.label);
      item.value = option.value;
      item.selected = String(option.value) === String(value);
      element.appendChild(item);
    });
    return element;
  }

  function timeLabel(value) {
    if (value === '00:00') return '12:00 AM';
    var parts = value.split(':');
    var hour = Number(parts[0]);
    return ((hour % 12) || 12) + ':' + parts[1] + ' ' + (hour < 12 ? 'AM' : 'PM');
  }

  function timeOptions(includeMidnightEnd) {
    var options = [];
    for (var minutes = 0; minutes < 1440; minutes += 15) {
      var value = pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60);
      options.push({ value: value, label: timeLabel(value) });
    }
    if (includeMidnightEnd) options.push({ value: '00:00', label: '12:00 AM (midnight)' });
    return options;
  }
  function pad(number) { return number < 10 ? '0' + number : String(number); }

  function loadAll() {
    return Promise.all([loadLocations(), loadTypes(), loadHours()]);
  }

  // ---- addresses ----

  function loadLocations() {
    return Auth.apiCall('listMeetingLocations', { includeArchived: true }).then(function (result) {
      if (!result.ok) throw new Error('load');
      state.locations = result.locations;
      renderLocations();
    }).catch(function () {
      document.getElementById('locations-list').textContent = 'Could not load addresses. Refresh to try again.';
    });
  }

  function addressText(location) {
    return [location.addressLine1, location.addressLine2, location.city + ', ' + location.state + ' ' + location.postalCode]
      .filter(Boolean).join(', ');
  }

  function renderLocations() {
    var mount = document.getElementById('locations-list');
    mount.replaceChildren();
    if (!state.locations.length) {
      mount.textContent = 'No addresses yet. Add one before creating a meeting type.';
      return;
    }
    var grid = node('div', 'booking-card-grid');
    state.locations.forEach(function (location) {
      var card = node('div', 'document-card');
      card.appendChild(node('h4', 'document-card__title', location.name));
      if (!location.active) card.appendChild(node('span', 'badge', 'Archived'));
      card.appendChild(node('p', 'document-card__description', addressText(location)));
      if (location.notes) card.appendChild(node('p', 'document-card__description', location.notes));
      var actions = node('div', 'booking-card-actions');
      actions.appendChild(button('Edit', null, function () { openLocationForm(location); }));
      actions.appendChild(button(location.active ? 'Archive' : 'Restore', 'btn-inline-action' + (location.active ? ' btn-inline-action--danger' : ''), function () {
        Auth.apiCall('archiveMeetingLocation', { id: location.id, archived: location.active }).then(function (result) {
          if (!result.ok) return fail(result);
          say(location.active ? 'Address archived.' : 'Address restored.');
          return loadLocations().then(loadTypes);
        });
      }));
      card.appendChild(actions);
      grid.appendChild(card);
    });
    mount.appendChild(grid);
  }

  function openLocationForm(location) {
    var form = document.getElementById('location-form');
    form.replaceChildren();
    form.hidden = false;
    var data = location || {};
    var name = input('text', data.name, { maxlength: 80, required: 'required', placeholder: 'Alpharetta shop' });
    var line1 = input('text', data.addressLine1, { maxlength: 120, required: 'required', autocomplete: 'off' });
    var line2 = input('text', data.addressLine2, { maxlength: 120 });
    var city = input('text', data.city, { maxlength: 80, required: 'required' });
    var stateInput = input('text', data.state, { maxlength: 2, required: 'required', placeholder: 'GA' });
    var zip = input('text', data.postalCode, { maxlength: 10, required: 'required', inputmode: 'numeric' });
    var notes = input('text', data.notes, { maxlength: 300, placeholder: 'Parking, which door, who to ask for' });
    form.appendChild(field('Name', name));
    form.appendChild(field('Street address', line1));
    form.appendChild(field('Suite / unit (optional)', line2));
    form.appendChild(field('City', city));
    form.appendChild(field('State', stateInput));
    form.appendChild(field('ZIP code', zip));
    form.appendChild(field('Notes for visitors (optional)', notes, true));
    var actions = node('div', 'booking-form__actions');
    var save = node('button', 'btn btn-small', location ? 'Save address' : 'Add address');
    save.type = 'submit';
    actions.appendChild(save);
    actions.appendChild(button('Cancel', 'btn-remove-row', function () { form.hidden = true; }));
    form.appendChild(actions);
    form.onsubmit = function (event) {
      event.preventDefault();
      save.disabled = true;
      Auth.apiCall('saveMeetingLocation', {
        id: data.id, name: name.value, addressLine1: line1.value, addressLine2: line2.value, city: city.value,
        state: stateInput.value, postalCode: zip.value, notes: notes.value
      }).then(function (result) {
        if (!result.ok) return fail(result);
        form.hidden = true;
        say('Address saved.');
        return loadLocations();
      }).finally(function () { save.disabled = false; });
    };
    name.focus();
  }

  // ---- meeting types and links ----

  function loadTypes() {
    return Auth.apiCall('listEventTypes', {}).then(function (result) {
      if (!result.ok) throw new Error('load');
      state.types = result.eventTypes;
      renderTypes();
    }).catch(function () {
      document.getElementById('types-list').textContent = 'Could not load meeting types. Refresh to try again.';
    });
  }

  function renderTypes() {
    var mount = document.getElementById('types-list');
    mount.replaceChildren();
    if (!state.types.length) {
      mount.textContent = 'No meeting types yet. Create one, then make a link to send to people.';
      return;
    }
    var grid = node('div', 'booking-card-grid');
    state.types.forEach(function (type) { grid.appendChild(typeCard(type)); });
    mount.appendChild(grid);
  }

  function typeCard(type) {
    var card = node('div', 'document-card');
    card.appendChild(node('h4', 'document-card__title', type.name));
    if (!type.active) card.appendChild(node('span', 'badge', 'Archived'));
    card.appendChild(node('p', 'document-card__description', type.durationMinutes + ' minutes · ' + type.locationName));
    if (type.description) card.appendChild(node('p', 'document-card__description', type.description));
    var actions = node('div', 'booking-card-actions');
    if (type.active) actions.appendChild(button('Create link', 'btn-inline-action', function () { openLinkForm(card, type); }));
    actions.appendChild(button('Edit', null, function () { openTypeForm(type); }));
    actions.appendChild(button(type.active ? 'Archive' : 'Restore', 'btn-inline-action' + (type.active ? ' btn-inline-action--danger' : ''), function () {
      Auth.apiCall('archiveEventType', { id: type.id, archived: type.active }).then(function (result) {
        if (!result.ok) return fail(result);
        say(type.active ? 'Meeting type archived. Its links no longer work.' : 'Meeting type restored.');
        return loadTypes();
      });
    }));
    card.appendChild(actions);
    var links = node('div', 'booking-links');
    links.appendChild(node('h5', null, 'Links (' + type.activeLinks + ' active)'));
    var list = node('div');
    links.appendChild(list);
    card.appendChild(links);
    loadLinks(type, list);
    return card;
  }

  function statusText(link) {
    var parts = [link.status.replace('_', ' ')];
    parts.push(link.useCount + (link.maxUses ? ' of ' + link.maxUses : '') + ' booked');
    if (link.expiresAt) parts.push('expires ' + new Date(link.expiresAt).toLocaleDateString());
    return parts.join(' · ');
  }

  function loadLinks(type, mount) {
    mount.textContent = 'Loading links…';
    Auth.apiCall('listBookingLinks', { eventTypeId: type.id }).then(function (result) {
      if (!result.ok) throw new Error('load');
      mount.replaceChildren();
      if (!result.links.length) { mount.textContent = 'No links yet.'; return; }
      result.links.forEach(function (link) {
        var row = node('div', 'booking-link-row');
        row.appendChild(node('span', 'booking-link-row__label', link.label || 'Untitled link'));
        row.appendChild(node('span', null, statusText(link)));
        if (link.status !== 'revoked') {
          row.appendChild(button('Revoke', 'btn-inline-action btn-inline-action--danger', function () {
            if (!window.confirm('Revoke this link? People who have it will no longer be able to book. Existing bookings stay.')) return;
            Auth.apiCall('revokeBookingLink', { linkId: link.id }).then(function (res) {
              if (!res.ok) return fail(res);
              say('Link revoked.');
              return loadTypes();
            });
          }));
        }
        mount.appendChild(row);
      });
    }).catch(function () { mount.textContent = 'Could not load links.'; });
  }

  function openLinkForm(card, type) {
    var existing = card.querySelector('.booking-form');
    if (existing) { existing.remove(); return; }
    var form = node('form', 'booking-form');
    var label = input('text', '', { maxlength: 120, placeholder: 'e.g. Spring hiring' });
    var expires = input('date', '', { min: new Date().toISOString().slice(0, 10) });
    var max = input('number', '', { min: 1, max: 10000, step: 1, placeholder: 'No limit' });
    form.appendChild(field('Label (just for you)', label, true));
    form.appendChild(field('Stops working on (optional)', expires));
    form.appendChild(field('Maximum bookings (optional)', max));
    var actions = node('div', 'booking-form__actions');
    var create = node('button', 'btn btn-small', 'Create link');
    create.type = 'submit';
    actions.appendChild(create);
    actions.appendChild(button('Cancel', 'btn-remove-row', function () { form.remove(); }));
    form.appendChild(actions);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      create.disabled = true;
      Auth.apiCall('createBookingLink', {
        eventTypeId: type.id, label: label.value, expiresOn: expires.value || undefined, maxUses: max.value || undefined
      }).then(function (result) {
        if (!result.ok) return fail(result);
        form.remove();
        showNewLink(card, result.url);
        say('Link created. Copy it now: it is not shown again.');
        loadLinks(type, card.querySelector('.booking-links div'));
      }).finally(function () { create.disabled = false; });
    });
    card.appendChild(form);
    label.focus();
  }

  function showNewLink(card, url) {
    var previous = card.querySelector('.booking-link-reveal');
    if (previous) previous.remove();
    var box = node('div', 'booking-link-reveal');
    box.appendChild(node('strong', null, 'Your new link'));
    var field_ = input('text', url, { readonly: 'readonly', 'aria-label': 'New booking link' });
    box.appendChild(field_);
    var copy = button('Copy link', 'btn btn-small', function () {
      field_.select();
      var done = function () { copy.textContent = 'Copied'; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    });
    box.appendChild(copy);
    box.appendChild(node('p', 'booking-hint', 'Anyone with this link can book. It will not be shown again, but you can make another link any time.'));
    card.insertBefore(box, card.querySelector('.booking-links'));
  }

  function openTypeForm(type) {
    var form = document.getElementById('type-form');
    form.replaceChildren();
    if (!state.locations.some(function (l) { return l.active; })) {
      say('Add a meeting address first (below), then create a meeting type.', true);
      return;
    }
    form.hidden = false;
    var data = type || { durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minNoticeMinutes: 240, maxDaysAhead: 60, slotIntervalMinutes: 30, questions: [] };
    var name = input('text', data.name, { maxlength: 80, required: 'required', placeholder: 'Interview' });
    var description = input('text', data.description, { maxlength: 500, placeholder: 'What the visitor should know' });
    var locations = state.locations.filter(function (l) { return l.active || l.id === data.locationId; });
    var location = select([{ value: '', label: 'Select an address…' }].concat(locations.map(function (l) {
      return { value: l.id, label: l.name + ' — ' + addressText(l) };
    })), data.locationId || '');
    location.required = true;
    var duration = select([15, 20, 30, 45, 60, 90, 120].map(function (n) { return { value: n, label: n + ' minutes' }; }), data.durationMinutes);
    var before = input('number', data.bufferBeforeMinutes, { min: 0, max: 240, step: 5 });
    var after = input('number', data.bufferAfterMinutes, { min: 0, max: 240, step: 5 });
    var notice = select([
      { value: 60, label: '1 hour' }, { value: 240, label: '4 hours' }, { value: 1440, label: '1 day' }, { value: 2880, label: '2 days' }
    ], data.minNoticeMinutes);
    var ahead = select([14, 30, 60, 90].map(function (n) { return { value: n, label: n + ' days' }; }), data.maxDaysAhead);
    var interval = select([15, 30, 60].map(function (n) { return { value: n, label: 'Every ' + n + ' minutes' }; }), data.slotIntervalMinutes);
    var questions = node('div');
    var questionRows = [];
    function addQuestion(question) {
      var row = node('div', 'hours-row');
      var label = input('text', question ? question.label : '', { maxlength: 120, placeholder: 'e.g. Which position are you applying for?', 'aria-label': 'Question' });
      var required = input('checkbox', '');
      required.checked = !!(question && question.required);
      var requiredLabel = node('label', null, 'Required');
      requiredLabel.appendChild(required);
      var entry = { id: question && question.id, label: label, required: required, row: row };
      questionRows.push(entry);
      row.appendChild(label);
      row.appendChild(requiredLabel);
      row.appendChild(button('Remove', 'btn-inline-action btn-inline-action--danger', function () {
        questionRows.splice(questionRows.indexOf(entry), 1);
        row.remove();
      }));
      questions.appendChild(row);
    }
    (data.questions || []).forEach(addQuestion);

    form.appendChild(field('Meeting name', name));
    form.appendChild(field('Address', location, true));
    form.appendChild(field('Description (optional)', description, true));
    form.appendChild(field('Length', duration));
    form.appendChild(field('Time between slots', interval));
    form.appendChild(field('Buffer before (minutes)', before));
    form.appendChild(field('Buffer after (minutes)', after));
    form.appendChild(field('Minimum notice', notice));
    form.appendChild(field('Book up to', ahead));
    var qGroup = node('div', 'form-group form-group--wide');
    qGroup.appendChild(node('label', null, 'Questions for the visitor (name and email are always asked)'));
    qGroup.appendChild(questions);
    qGroup.appendChild(button('Add question', null, function () { if (questionRows.length < 5) addQuestion(null); }));
    form.appendChild(qGroup);
    var actions = node('div', 'booking-form__actions');
    var save = node('button', 'btn btn-small', type ? 'Save meeting type' : 'Create meeting type');
    save.type = 'submit';
    actions.appendChild(save);
    actions.appendChild(button('Cancel', 'btn-remove-row', function () { form.hidden = true; }));
    form.appendChild(actions);
    form.onsubmit = function (event) {
      event.preventDefault();
      save.disabled = true;
      Auth.apiCall('saveEventType', {
        id: data.id, name: name.value, description: description.value, locationId: location.value,
        durationMinutes: Number(duration.value), bufferBeforeMinutes: Number(before.value || 0), bufferAfterMinutes: Number(after.value || 0),
        minNoticeMinutes: Number(notice.value), maxDaysAhead: Number(ahead.value), slotIntervalMinutes: Number(interval.value),
        questions: questionRows.filter(function (q) { return q.label.value.trim(); }).map(function (q) {
          return { id: q.id, label: q.label.value, required: q.required.checked };
        })
      }).then(function (result) {
        if (!result.ok) return fail(result);
        form.hidden = true;
        say('Meeting type saved.');
        return loadTypes();
      }).finally(function () { save.disabled = false; });
    };
    name.focus();
  }

  // ---- booking hours ----

  function loadHours() {
    return Auth.apiCall('getBookingAvailability', {}).then(function (result) {
      if (!result.ok) throw new Error('load');
      state.weekly = result.weekly.map(function (w) { return { weekday: w.weekday, startTime: w.startTime, endTime: w.endTime }; });
      state.timezone = result.timezone;
      state.avoidShifts = result.avoidShifts;
      state.overrides = result.overrides;
      renderHours();
    }).catch(function () {
      document.getElementById('hours-editor').textContent = 'Could not load your hours. Refresh to try again.';
    });
  }

  function timezoneChoices() {
    var common = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
    if (common.indexOf(state.timezone) === -1) common.unshift(state.timezone);
    return common.map(function (zone) { return { value: zone, label: zone.replace(/_/g, ' ') }; });
  }

  function renderHours() {
    var mount = document.getElementById('hours-editor');
    mount.replaceChildren();
    var settings = node('div', 'hours-settings');
    var zone = select(timezoneChoices(), state.timezone);
    zone.addEventListener('change', function () { state.timezone = zone.value; });
    settings.appendChild(field('Time zone for these hours', zone));
    var avoidGroup = node('div', 'form-group');
    var avoid = input('checkbox', '');
    avoid.checked = state.avoidShifts;
    avoid.addEventListener('change', function () { state.avoidShifts = avoid.checked; });
    var avoidLabel = node('label', null, ' Don\'t offer times when I\'m on a published work shift');
    avoidLabel.insertBefore(avoid, avoidLabel.firstChild);
    avoidGroup.appendChild(avoidLabel);
    settings.appendChild(avoidGroup);
    mount.appendChild(settings);

    DAYS.forEach(function (day) {
      var row = node('div', 'hours-day');
      row.appendChild(node('div', 'hours-day__name', day.name));
      var body = node('div');
      var windows = state.weekly.filter(function (w) { return w.weekday === day.weekday; });
      if (!windows.length) body.appendChild(node('span', 'hours-closed', 'Not available'));
      windows.forEach(function (window_) {
        var line = node('div', 'hours-row');
        var start = select(timeOptions(false), window_.startTime);
        var end = select(timeOptions(true).slice(1), window_.endTime);
        start.setAttribute('aria-label', day.name + ' start');
        end.setAttribute('aria-label', day.name + ' end');
        start.addEventListener('change', function () { window_.startTime = start.value; });
        end.addEventListener('change', function () { window_.endTime = end.value; });
        line.appendChild(start);
        line.appendChild(node('span', null, 'to'));
        line.appendChild(end);
        line.appendChild(button('Remove', 'btn-inline-action btn-inline-action--danger', function () {
          state.weekly.splice(state.weekly.indexOf(window_), 1);
          renderHours();
        }));
        body.appendChild(line);
      });
      if (windows.length < 5) {
        body.appendChild(button('Add hours', null, function () {
          state.weekly.push({ weekday: day.weekday, startTime: '09:00', endTime: '17:00' });
          renderHours();
        }));
      }
      row.appendChild(body);
      mount.appendChild(row);
    });

    var actions = node('div', 'booking-actions');
    var save = node('button', 'btn btn-small', 'Save hours');
    save.type = 'button';
    save.addEventListener('click', function () {
      save.disabled = true;
      Auth.apiCall('saveBookingAvailability', { timezone: state.timezone, avoidShifts: state.avoidShifts, weekly: state.weekly })
        .then(function (result) {
          if (!result.ok) return fail(result);
          say('Hours saved.');
        }).finally(function () { save.disabled = false; });
    });
    actions.appendChild(save);
    mount.appendChild(actions);
    mount.appendChild(overridesSection());
  }

  function overridesSection() {
    var wrap = node('div');
    wrap.appendChild(node('h3', null, 'Days off and special hours'));
    wrap.appendChild(node('p', 'booking-hint', 'A date listed here replaces your usual hours for that day.'));
    var form = node('form', 'override-form');
    var date = input('date', '', { required: 'required', min: new Date().toISOString().slice(0, 10) });
    var kind = select([{ value: 'off', label: 'Not available' }, { value: 'hours', label: 'Different hours' }], 'off');
    var start = select(timeOptions(false), '09:00');
    var end = select(timeOptions(true).slice(1), '17:00');
    var times = node('span', 'hours-row');
    times.hidden = true;
    times.appendChild(start);
    times.appendChild(node('span', null, 'to'));
    times.appendChild(end);
    kind.addEventListener('change', function () { times.hidden = kind.value !== 'hours'; });
    form.appendChild(field('Date', date));
    form.appendChild(field('That day', kind));
    form.appendChild(times);
    var add = node('button', 'btn btn-small', 'Save date');
    add.type = 'submit';
    form.appendChild(add);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var body = { date: date.value };
      if (kind.value === 'off') body.blocked = true;
      else body.windows = [{ startTime: start.value, endTime: end.value }];
      Auth.apiCall('saveDateOverride', body).then(function (result) {
        if (!result.ok) return fail(result);
        say('Date saved.');
        return loadHours();
      });
    });
    wrap.appendChild(form);
    if (!state.overrides.length) {
      wrap.appendChild(node('p', 'booking-hint', 'No upcoming exceptions.'));
    }
    state.overrides.forEach(function (override) {
      var row = node('div', 'booking-link-row');
      row.appendChild(node('span', 'booking-link-row__label', override.date));
      row.appendChild(node('span', null, override.blocked ? 'Not available' : override.windows.map(function (w) {
        return timeLabel(w.startTime) + ' – ' + timeLabel(w.endTime);
      }).join(', ')));
      row.appendChild(button('Remove', 'btn-inline-action btn-inline-action--danger', function () {
        Auth.apiCall('deleteDateOverride', { date: override.date }).then(function (result) {
          if (!result.ok) return fail(result);
          return loadHours();
        });
      }));
      wrap.appendChild(row);
    });
    return wrap;
  }
})();

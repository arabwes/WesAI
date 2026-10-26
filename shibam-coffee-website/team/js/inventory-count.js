// /team/js/inventory-count.js
// Weekly inventory count. One shared draft per count lives on the server
// (getInventoryCount / saveInventoryDraft), so a count can be finished over
// time or on another device and is submitted exactly once
// (submitInventoryCount). The server re-checks every rule here — this file
// only gives instant feedback. Loaded after config.js, auth.js, count-ui.js.

(function () {
  'use strict';

  var UI = window.CountUI;
  var el = UI.el;
  var SAVE_DELAY_MS = 1200;
  var RETRY_DELAY_MS = 10000;
  var POLL_MS = 45000;

  var state = {
    data: null,
    draftId: '',
    dateOption: 'today',
    rows: new Map(),       // catalogId → { item, row, kitchen, storage, note, sectionId, edits }
    sections: new Map(),   // sectionId → { root, chip, body, ids }
    dirty: new Map(),      // catalogId → edit counter at the time it was marked dirty
    dateDirty: false,
    saveTimer: null,
    saving: null,
    pollTimer: null,
    submitting: false,
    closed: false
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (!document.getElementById('inventory-sections')) return;
    initBar();
    initFooter();
    UI.initKeyboardFlow(document.getElementById('inventory-sections'));
    window.addEventListener('beforeunload', function (e) {
      if (state.dirty.size || state.dateDirty) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && (state.dirty.size || state.dateDirty)) saveNow();
    });
    load();
  });

  // ---------------------------------------------------------------------
  // Loading and rendering
  // ---------------------------------------------------------------------
  function load() {
    var mount = document.getElementById('inventory-sections');
    return Auth.apiCall('getInventoryCount', {}).then(function (result) {
      if (!result.ok) {
        mount.textContent = 'Could not load the count. Refresh to try again.';
        return;
      }
      state.data = result;
      state.closed = false;
      render(result);
      schedulePoll();
    }).catch(function () {
      mount.textContent = 'Could not load the count. Check your connection and refresh to try again.';
    });
  }

  function render(data) {
    var mount = document.getElementById('inventory-sections');
    mount.innerHTML = '';
    state.rows.clear();
    state.sections.clear();
    state.dirty.clear();
    state.dateDirty = false;

    var items = data.sections.reduce(function (all, section) { return all.concat(section.items); }, []);
    if (!items.length) {
      mount.textContent = 'No inventory items are configured yet. Ask Management to add catalog items.';
      return;
    }

    var draft = data.draft;
    state.draftId = draft ? draft.draftId : '';
    setDateOption(draft && draft.countDate === data.yesterday ? 'yesterday' : 'today', false);
    document.getElementById('date-reason').value = draft ? draft.dateReason : '';

    var canManage = Auth.hasRole(Auth.getSession(), 'lead');
    var jump = document.getElementById('section-jump');
    jump.innerHTML = '';

    data.sections.forEach(function (section, index) {
      var key = section.sectionId || 'unassigned';
      var root = el('section', 'count-group');
      root.id = 'count-section-' + index;

      var head = UI.button('count-group__head', null, { 'aria-expanded': 'true', 'aria-controls': root.id + '-body' });
      head.appendChild(el('span', 'count-group__title', section.name));
      var chip = el('span', 'count-group__chip');
      head.appendChild(chip);
      root.appendChild(head);

      var body = el('div', 'count-group__body');
      body.id = root.id + '-body';
      var ids = [];
      section.items.forEach(function (item) {
        body.appendChild(buildRow(item, key, canManage));
        ids.push(item.catalogId);
      });
      if (canManage) body.appendChild(buildAddItem(section));
      root.appendChild(body);

      head.addEventListener('click', function () {
        var open = head.getAttribute('aria-expanded') !== 'true';
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        body.hidden = !open;
      });

      state.sections.set(key, { root: root, chip: chip, body: body, head: head, ids: ids, name: section.name });
      mount.appendChild(root);

      var option = el('option', null, section.name);
      option.value = root.id;
      jump.appendChild(option);
    });

    if (draft) {
      Object.keys(draft.items).forEach(function (catalogId) { applyEntry(catalogId, draft.items[catalogId]); });
    }
    renderDraftStatus();
    updateProgress();
    setSaveStatus(draft ? 'Draft saved ' + timeLabel(draft.updatedAt) : '');
  }

  function buildRow(item, sectionKey, canManage) {
    var row = el('div', 'count-row');
    row.dataset.catalogId = item.catalogId;

    var head = el('div', 'count-row__head');
    var label = el('div', 'count-row__label');
    label.appendChild(el('span', 'count-row__name', item.name));
    var unit = el('span', 'count-row__unit');
    if (item.unit) {
      unit.appendChild(document.createTextNode('Count in '));
      unit.appendChild(el('strong', null, item.unit));
    } else {
      unit.classList.add('count-row__unit--missing');
      unit.textContent = 'No count unit set — ask a manager';
    }
    label.appendChild(unit);
    head.appendChild(label);

    var tools = el('div', 'count-row__tools');
    var none = UI.button('count-row__none', 'None', { 'aria-label': 'None of ' + item.name + ' — record 0 as checked' });
    var noteToggle = UI.button('count-row__note-toggle', 'Note', { 'aria-label': 'Add a note for ' + item.name, 'aria-expanded': 'false' });
    tools.appendChild(none);
    tools.appendChild(noteToggle);
    if (canManage) tools.appendChild(UI.rowMenu(item.name, rowActions(item)));
    head.appendChild(tools);
    row.appendChild(head);

    var fields = el('div', 'count-row__fields');
    var kitchen = UI.quantityField({ label: 'Kitchen', ariaName: item.name, unit: item.unit });
    var storage = UI.quantityField({ label: 'Storage', ariaName: item.name, unit: item.unit });
    fields.appendChild(kitchen.root);
    fields.appendChild(storage.root);
    row.appendChild(fields);

    var note = el('input', 'count-row__note');
    note.type = 'text';
    note.maxLength = 300;
    note.placeholder = 'Note (optional)';
    note.setAttribute('aria-label', 'Note for ' + item.name);
    note.hidden = true;
    row.appendChild(note);

    var record = { item: item, row: row, kitchen: kitchen, storage: storage, note: note, none: none, sectionKey: sectionKey, edits: 0 };
    state.rows.set(item.catalogId, record);

    row.addEventListener('input', function () { markDirty(record); });
    row.addEventListener('change', function () { markDirty(record); });
    none.addEventListener('click', function () {
      // Fills whichever boxes are still empty with 0, so "3 in the kitchen,
      // none in storage" is one number plus one tap.
      if (kitchen.get() === null) kitchen.set(0);
      if (storage.get() === null) storage.set(0);
      markDirty(record);
    });
    noteToggle.addEventListener('click', function () {
      note.hidden = !note.hidden;
      noteToggle.setAttribute('aria-expanded', note.hidden ? 'false' : 'true');
      if (!note.hidden) note.focus();
    });

    return row;
  }

  function rowActions(item) {
    var actions = [{
      label: 'Flag for review',
      onSelect: function () {
        Auth.apiCall('flagItem', { catalogId: item.catalogId }).then(function (result) {
          setSaveStatus(result.ok ? '"' + item.name + '" flagged for Management.' : 'Could not flag that item.', !result.ok);
        });
      }
    }];
    if (Auth.hasRole(Auth.getSession(), 'management')) {
      actions.push({
        label: 'Retire item (inactive)…',
        danger: true,
        onSelect: function () {
          UI.confirmSheet({
            title: 'Retire "' + item.name + '"?',
            message: 'It leaves the count form but keeps its history. You can restore it from Admin → Catalog.',
            confirmLabel: 'Retire item',
            danger: true
          }).then(function (ok) {
            if (!ok) return;
            saveNow().then(function () {
              return Auth.apiCall('discontinueItem', { catalogId: item.catalogId });
            }).then(function (result) {
              if (result && result.ok) load(); else setSaveStatus('Could not retire that item.', true);
            });
          });
        }
      });
    }
    return actions;
  }

  function buildAddItem(section) {
    var wrap = el('div', 'count-add');
    var toggle = UI.button('btn-outline count-add__toggle', '+ Add item to ' + section.name);
    var form = el('div', 'count-add__form');
    form.hidden = true;

    function field(label, placeholder) {
      var group = el('label', 'count-add__field');
      group.appendChild(el('span', null, label));
      var input = el('input');
      input.type = 'text';
      input.placeholder = placeholder;
      group.appendChild(input);
      form.appendChild(group);
      return input;
    }
    var name = field('Item name', 'e.g. Pistachio Sauce');
    var unit = field('Count unit (how we buy it)', 'e.g. 950 g bottles');
    var max = field('Most we ever stock (optional)', 'e.g. 24');
    max.inputMode = 'numeric';
    var error = el('p', 'inline-error', '');
    form.appendChild(error);
    var save = UI.button('btn btn-primary', 'Add item');
    form.appendChild(save);

    toggle.addEventListener('click', function () { form.hidden = !form.hidden; if (!form.hidden) name.focus(); });
    save.addEventListener('click', function () {
      error.textContent = '';
      if (!name.value.trim() || !unit.value.trim()) { error.textContent = 'Name and count unit are both required.'; return; }
      save.disabled = true;
      var category = section.items.length ? section.items[0].category : '';
      saveNow().then(function () {
        return Auth.apiCall('addItem', {
          formType: 'inventory',
          item: { name: name.value.trim(), unit: unit.value.trim(), maxQty: max.value.trim(), group: category, sectionId: section.sectionId }
        });
      }).then(function (result) {
        save.disabled = false;
        if (result && result.ok) { load(); return; }
        error.textContent = result && result.error === 'duplicate_name' ? 'An item with that name already exists.'
          : result && result.error === 'invalid_max_qty' ? 'The maximum must be a number above 0.' : 'Could not add the item.';
      });
    });

    wrap.appendChild(toggle);
    wrap.appendChild(form);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Row state and progress
  // ---------------------------------------------------------------------
  function entryOf(record) {
    return { qtyKitchen: record.kitchen.get(), qtyStorage: record.storage.get(), note: record.note.value.trim() };
  }

  function isComplete(record) {
    return record.kitchen.get() !== null && record.storage.get() !== null;
  }

  function applyEntry(catalogId, entry) {
    var record = state.rows.get(catalogId);
    if (!record || !entry) return;
    record.kitchen.set(entry.qtyKitchen);
    record.storage.set(entry.qtyStorage);
    record.note.value = entry.note || '';
    if (record.note.value) record.note.hidden = false;
    updateRow(record);
  }

  function updateRow(record) {
    var complete = isComplete(record);
    record.row.classList.toggle('is-complete', complete);
    if (complete) record.row.classList.remove('is-missing');
    var zero = complete && record.kitchen.get() === 0 && record.storage.get() === 0;
    record.row.classList.toggle('is-zero', zero);
    var oneFilled = !complete && (record.kitchen.get() !== null || record.storage.get() !== null);
    record.none.textContent = zero ? '0 ✓' : oneFilled ? 'Rest is 0' : 'None';
  }

  function markDirty(record) {
    record.edits += 1;
    state.dirty.set(record.item.catalogId, record.edits);
    updateRow(record);
    updateProgress();
    scheduleSave();
  }

  function updateProgress() {
    var total = state.rows.size;
    var done = 0;
    state.rows.forEach(function (record) { if (isComplete(record)) done += 1; });
    var left = total - done;

    document.getElementById('progress-fill').style.width = total ? (done / total * 100) + '%' : '0';
    document.getElementById('progress-text').textContent = done + ' of ' + total + ' counted';

    state.sections.forEach(function (section) {
      var sectionDone = section.ids.filter(function (id) { return isComplete(state.rows.get(id)); }).length;
      var finished = sectionDone === section.ids.length;
      section.chip.textContent = finished ? '✓ ' + sectionDone + '/' + section.ids.length : sectionDone + '/' + section.ids.length;
      section.root.classList.toggle('is-complete', finished);
    });

    var submit = document.getElementById('submit-count');
    submit.setAttribute('aria-disabled', left || state.submitting ? 'true' : 'false');
    submit.textContent = left ? 'Submit · ' + left + ' left' : 'Submit count';
  }

  function firstIncomplete() {
    var found = null;
    state.rows.forEach(function (record) { if (!found && !isComplete(record)) found = record; });
    return found;
  }

  function openSectionOf(record) {
    var section = state.sections.get(record.sectionKey);
    if (section && section.body.hidden) {
      section.body.hidden = false;
      section.head.setAttribute('aria-expanded', 'true');
    }
  }

  // ---------------------------------------------------------------------
  // Count bar: date, jump, next empty
  // ---------------------------------------------------------------------
  function initBar() {
    document.querySelectorAll('[data-date-option]').forEach(function (option) {
      option.addEventListener('click', function () { setDateOption(option.dataset.dateOption, true); });
    });
    document.getElementById('date-reason').addEventListener('input', function () {
      state.dateDirty = true;
      scheduleSave();
    });
    document.getElementById('section-jump').addEventListener('change', function (e) {
      var target = document.getElementById(e.target.value);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('next-empty').addEventListener('click', function () {
      var record = firstIncomplete();
      if (!record) { setSaveStatus('Every item is counted — ready to submit.'); return; }
      openSectionOf(record);
      UI.focusRow(record.row);
    });
  }

  function setDateOption(option, userChange) {
    state.dateOption = option;
    document.querySelectorAll('[data-date-option]').forEach(function (button) {
      var active = button.dataset.dateOption === option;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    document.getElementById('date-reason-wrap').hidden = option !== 'yesterday';
    if (userChange) {
      state.dateDirty = true;
      if (option === 'yesterday') document.getElementById('date-reason').focus();
      scheduleSave();
    }
    renderDraftStatus();
  }

  function countDate() {
    if (!state.data) return '';
    return state.dateOption === 'yesterday' ? state.data.yesterday : state.data.today;
  }

  function renderDraftStatus() {
    var box = document.getElementById('draft-status');
    var data = state.data;
    if (!data) return;
    box.innerHTML = '';
    var lines = [];
    if (data.draft) {
      var who = data.draft.contributors.length ? data.draft.contributors.join(', ') : data.draft.startedByName;
      lines.push('Draft started by ' + data.draft.startedByName + ' ' + timeLabel(data.draft.startedAt) + '. Counted so far by ' + who + '.');
    }
    if (data.submittedDates.indexOf(countDate()) !== -1) {
      lines.push('A count for ' + (state.dateOption === 'yesterday' ? 'yesterday' : 'today') +
        ' has already been submitted. If it needs fixing, ask a manager to edit it rather than starting another.');
      box.classList.add('draft-status--warning');
    } else {
      box.classList.remove('draft-status--warning');
    }
    if (!lines.length) { box.hidden = true; return; }
    lines.forEach(function (line) { box.appendChild(el('p', null, line)); });
    var session = Auth.getSession();
    if (data.draft && (Auth.hasRole(session, 'lead') || (session && data.draft.startedByName === session.name))) {
      var discard = UI.button('btn-remove-row', 'Discard draft');
      discard.addEventListener('click', discardDraft);
      box.appendChild(discard);
    }
    box.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Draft saving (debounced, only changed items) and polling
  // ---------------------------------------------------------------------
  function scheduleSave() {
    clearTimeout(state.saveTimer);
    setSaveStatus('Unsaved changes…');
    state.saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
  }

  function saveNow() {
    clearTimeout(state.saveTimer);
    if (state.closed) return Promise.resolve(false);
    if (state.saving) return state.saving.then(function () { return state.dirty.size || state.dateDirty ? saveNow() : true; });
    if (!state.dirty.size && !state.dateDirty) return Promise.resolve(true);

    var sent = new Map(state.dirty);
    var changes = {};
    sent.forEach(function (edits, catalogId) { changes[catalogId] = entryOf(state.rows.get(catalogId)); });
    var payload = {
      draftId: state.draftId,
      countDate: countDate(),
      dateReason: state.dateOption === 'yesterday' ? document.getElementById('date-reason').value.trim() : '',
      changes: changes
    };
    state.dateDirty = false;
    setSaveStatus('Saving…');

    state.saving = Auth.apiCall('saveInventoryDraft', payload).then(function (result) {
      state.saving = null;
      if (!result.ok) return handleSaveError(result, sent);
      sent.forEach(function (edits, catalogId) {
        // Only clear rows that weren't typed in again while this save was in flight.
        if (state.dirty.get(catalogId) === edits) state.dirty.delete(catalogId);
      });
      state.draftId = result.draft.draftId;
      state.data.draft = result.draft;
      mergeRemote(result.draft);
      renderDraftStatus();
      setSaveStatus('Draft saved ' + timeLabel(result.draft.updatedAt));
      if (state.dirty.size || state.dateDirty) scheduleSave();
      return true;
    }).catch(function () {
      state.saving = null;
      state.dateDirty = true;
      setSaveStatus('Not saved — no connection. Retrying…', true);
      state.saveTimer = setTimeout(saveNow, RETRY_DELAY_MS);
      return false;
    });
    return state.saving;
  }

  function handleSaveError(result, sent) {
    if (result.error === 'draft_closed') {
      state.closed = true;
      state.dirty.clear();
      setSaveStatus('This count was submitted or discarded on another device.', true);
      UI.confirmSheet({
        title: 'This count was closed elsewhere',
        message: 'Someone submitted or discarded the draft you were working on. Reload to see the current state. Unsaved numbers on this screen will be lost.',
        confirmLabel: 'Reload'
      }).then(function (ok) { if (ok) load(); });
      return false;
    }
    if (result.error === 'count_date_not_allowed') {
      if (result.today) { state.data.today = result.today; state.data.yesterday = result.yesterday; }
      setDateOption('today', false);
      state.dateDirty = true;
      sent.forEach(function (edits, catalogId) { if (!state.dirty.has(catalogId)) state.dirty.set(catalogId, edits); });
      setSaveStatus('The count date was reset to today — counts can only be dated today or yesterday.', true);
      scheduleSave();
      return false;
    }
    if (result.error === 'invalid_quantity' && result.catalogId) {
      var record = state.rows.get(result.catalogId);
      if (record) { record.row.classList.add('is-missing'); openSectionOf(record); UI.focusRow(record.row); }
      setSaveStatus('One quantity isn’t a whole number or quarter — fix the highlighted item.', true);
      return false;
    }
    sent.forEach(function (edits, catalogId) { if (!state.dirty.has(catalogId)) state.dirty.set(catalogId, edits); });
    setSaveStatus('Could not save the draft — retrying shortly.', true);
    state.saveTimer = setTimeout(saveNow, RETRY_DELAY_MS);
    return false;
  }

  // Values someone else saved, for rows this device isn't editing.
  function mergeRemote(draft) {
    var focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.count-row') : null;
    Object.keys(draft.items).forEach(function (catalogId) {
      var record = state.rows.get(catalogId);
      if (!record || state.dirty.has(catalogId) || record.row === focused) return;
      var remote = draft.items[catalogId];
      var local = entryOf(record);
      if (local.qtyKitchen !== remote.qtyKitchen || local.qtyStorage !== remote.qtyStorage || local.note !== (remote.note || '')) {
        applyEntry(catalogId, remote);
      }
    });
    updateProgress();
  }

  function schedulePoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(function () {
      if (document.visibilityState !== 'visible' || state.saving || state.dirty.size || state.submitting || state.closed) return;
      Auth.apiCall('getInventoryCount', {}).then(function (result) {
        if (!result.ok || state.dirty.size) return;
        var remoteId = result.draft ? result.draft.draftId : '';
        if (state.draftId && remoteId !== state.draftId) {
          state.closed = true;
          setSaveStatus('This count was submitted or discarded on another device. Refresh to continue.', true);
          return;
        }
        state.data.submittedDates = result.submittedDates;
        if (result.draft) {
          state.draftId = remoteId;
          state.data.draft = result.draft;
          mergeRemote(result.draft);
          renderDraftStatus();
        }
      }).catch(function () { /* the next tick retries */ });
    }, POLL_MS);
  }

  function discardDraft() {
    UI.confirmSheet({
      title: 'Discard this draft?',
      message: 'Every number entered in this count so far is deleted for everyone. This can’t be undone.',
      confirmLabel: 'Discard draft',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      clearTimeout(state.saveTimer);
      Auth.apiCall('discardInventoryDraft', { draftId: state.draftId }).then(function (result) {
        if (result.ok) { state.dirty.clear(); load(); } else setSaveStatus('Could not discard the draft.', true);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Submit: completeness → date reason → save → outlier review → submit
  // ---------------------------------------------------------------------
  function initFooter() {
    document.getElementById('save-draft').addEventListener('click', function () {
      if (!state.dirty.size && !state.dateDirty) {
        if (!state.draftId) state.dateDirty = true; else { setSaveStatus('Draft is up to date.'); return; }
      }
      saveNow();
    });
    document.getElementById('submit-count').addEventListener('click', function () { submit([]); });
  }

  function submit(confirmed) {
    if (state.submitting || state.closed || !state.data) return;
    var missing = firstIncomplete();
    if (missing) {
      var left = 0;
      state.rows.forEach(function (record) { if (!isComplete(record)) { left += 1; record.row.classList.add('is-missing'); } });
      setSaveStatus(left + (left === 1 ? ' item still needs' : ' items still need') + ' a number or None. Taking you to the next one.', true);
      openSectionOf(missing);
      UI.focusRow(missing.row);
      return;
    }
    var reason = document.getElementById('date-reason');
    if (state.dateOption === 'yesterday' && reason.value.trim().length < 3) {
      setSaveStatus('Add a short reason why this count is for yesterday.', true);
      reason.focus();
      return;
    }

    state.submitting = true;
    updateProgress();
    setSaveStatus('Submitting…');
    if (!state.draftId) state.dateDirty = true;
    saveNow().then(function (saved) {
      // Numbers typed while the first save was in flight need one more save.
      return saved && (state.dirty.size || state.dateDirty) ? saveNow() : saved;
    }).then(function (saved) {
      if (!saved || state.dirty.size) throw new Error('not_saved');
      return Auth.apiCall('submitInventoryCount', {
        draftId: state.draftId,
        countDate: countDate(),
        dateReason: state.dateOption === 'yesterday' ? reason.value.trim() : '',
        confirmedOutliers: confirmed
      });
    }).then(function (result) {
      state.submitting = false;
      updateProgress();
      if (result.ok) return showSubmitted(result);
      handleSubmitError(result, confirmed);
    }).catch(function () {
      state.submitting = false;
      updateProgress();
      setSaveStatus('Could not submit — check your connection and try again. Your draft is safe.', true);
    });
  }

  function handleSubmitError(result, confirmed) {
    if (result.error === 'outliers_need_confirmation') {
      reviewOutliers(result.outliers || []).then(function (ids) {
        if (ids) submit(confirmed.concat(ids));
        else setSaveStatus('Fix the highlighted numbers, then submit again.', true);
      });
      return;
    }
    if (result.error === 'incomplete') {
      (result.missing || []).forEach(function (item) {
        var record = state.rows.get(item.catalogId);
        if (record) record.row.classList.add('is-missing');
      });
      var first = result.missing && result.missing[0] && state.rows.get(result.missing[0].catalogId);
      setSaveStatus(result.missingCount + ' items still need a count.', true);
      if (first) { openSectionOf(first); UI.focusRow(first.row); }
      return;
    }
    var messages = {
      count_exists_for_date: 'A count for this date was already submitted. Ask a manager to edit that one instead.',
      date_reason_required: 'Add a short reason why this count is for yesterday.',
      count_date_not_allowed: 'Counts can only be dated today or yesterday.',
      already_submitted: 'This count was already submitted.',
      draft_not_found: 'This draft no longer exists — it may have been discarded. Reload to start again.'
    };
    setSaveStatus(messages[result.error] || 'Something went wrong submitting the count. Your draft is safe — try again.', true);
    if (result.error === 'already_submitted' || result.error === 'draft_not_found') load();
  }

  // One sheet lists every unusual number; each needs a "Yes, that's right"
  // tick, or "Fix it" closes the sheet and jumps to the item.
  function reviewOutliers(outliers) {
    var list = el('div', 'outlier-list');
    var checks = [];
    var reasonText = {
      over_3x: 'more than 3× the last count',
      under_third: 'less than ⅓ of the last count',
      above_max: 'above the most we normally stock'
    };
    var handle;
    outliers.forEach(function (outlier) {
      var record = state.rows.get(outlier.catalogId);
      var card = el('div', 'outlier');
      card.appendChild(el('p', 'outlier__name', outlier.name));
      var detail = 'Now ' + UI.formatQty(outlier.newTotal) + ' ' + (outlier.unit || '') +
        (outlier.previousTotal !== null ? ' · last count ' + UI.formatQty(outlier.previousTotal) + (outlier.previousDate ? ' on ' + shortDate(outlier.previousDate) : '') : '') +
        (outlier.maxQty ? ' · usual maximum ' + outlier.maxQty : '');
      card.appendChild(el('p', 'outlier__detail', detail));
      card.appendChild(el('p', 'outlier__reason', outlier.reasons.map(function (r) { return reasonText[r] || r; }).join(' and ')));

      var actions = el('div', 'outlier__actions');
      var label = el('label', 'outlier__confirm');
      var check = el('input');
      check.type = 'checkbox';
      check.value = outlier.catalogId;
      label.appendChild(check);
      label.appendChild(el('span', null, 'Yes, ' + UI.formatQty(outlier.newTotal) + ' is right'));
      actions.appendChild(label);
      var fix = UI.button('btn-outline', 'Fix it');
      fix.addEventListener('click', function () {
        handle.close(null);
        if (record) { record.row.classList.add('is-missing'); openSectionOf(record); UI.focusRow(record.row); }
      });
      actions.appendChild(fix);
      card.appendChild(actions);
      list.appendChild(card);
      checks.push(check);
      check.addEventListener('change', function () {
        handle.setConfirmEnabled(checks.every(function (c) { return c.checked; }));
      });
    });

    handle = UI.sheet({
      title: outliers.length === 1 ? 'Check this number' : 'Check these ' + outliers.length + ' numbers',
      message: 'These are very different from the last count. Typos and counting in a different unit are the usual causes.',
      body: list,
      confirmLabel: 'Confirm and submit',
      cancelLabel: 'Back to count',
      onConfirm: function () { return checks.map(function (c) { return c.value; }); }
    });
    handle.setConfirmEnabled(false);
    return handle.promise.then(function (ids) { return Array.isArray(ids) ? ids : null; });
  }

  function showSubmitted(result) {
    clearInterval(state.pollTimer);
    state.closed = true;
    state.dirty.clear();
    var session = Auth.getSession();
    var mount = document.getElementById('inventory-sections');
    mount.innerHTML = '';
    var done = el('div', 'count-done');
    done.appendChild(el('h2', null, 'Count submitted'));
    done.appendChild(el('p', null, result.itemCount + ' items recorded for ' + shortDate(result.countDate) +
      '. Thanks' + (session ? ', ' + session.name.split(' ')[0] : '') + '!'));
    var back = el('a', 'btn btn-primary', 'Back to Inventory');
    back.href = '/team/inventory-hub';
    done.appendChild(back);
    mount.appendChild(done);
    document.getElementById('draft-status').hidden = true;
    document.querySelector('.count-help').hidden = true;
    document.getElementById('count-footer').hidden = true;
    document.getElementById('count-bar').hidden = true;
    window.scrollTo({ top: 0 });
  }

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function setSaveStatus(message, isError) {
    var status = document.getElementById('save-status');
    status.textContent = message || '';
    if (isError) status.setAttribute('data-state', 'error'); else status.removeAttribute('data-state');
  }

  function timeLabel(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    var sameDay = date.toDateString() === new Date().toDateString();
    var time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? 'at ' + time : 'on ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' at ' + time;
  }

  function shortDate(isoDate) {
    var date = new Date(isoDate + 'T12:00:00');
    return isNaN(date.getTime()) ? isoDate : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
})();

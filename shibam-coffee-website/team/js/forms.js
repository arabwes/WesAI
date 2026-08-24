// /team/js/forms.js
// Shibam Coffee Atlanta — employee portal form behavior.
// Loaded after config.js, auth.js, and data.js. No dependencies, no build step.

(function () {
  'use strict';

  var LOCAL_ORDER_NOTES = {
    'Check Downstairs Storage First': 'Walk down and look before adding either of these — we often already have them in storage.'
  };

  document.addEventListener('DOMContentLoaded', function () {
    setFooterYear();
    setTodayDefaults();
    renderSessionBanner();
    renderInventoryForm();
    renderDessertDailyForm();
    renderDessertOrderForm();
    renderLocalOrderForm();
    initTabs();
    initUnlistedItems();
    initReviewGate();
    initForms();
  });

  function setTodayDefaults() {
    var today = new Date();
    var iso = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');

    document.querySelectorAll('[data-today]').forEach(function (input) {
      if (!input.value) input.value = iso;
    });
  }

  function setFooterYear() {
    document.querySelectorAll('#footer-year').forEach(function (el) {
      el.textContent = new Date().getFullYear();
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

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Labels each cell in a built row to match its column header, so the
  // mobile card-collapse CSS (styles.css) can show "Label: value" once the
  // table stops laying out as a table below ~640px.
  function applyDataLabels(row, headerLabels) {
    Array.from(row.children).forEach(function (cell, i) {
      if (headerLabels[i]) cell.setAttribute('data-label', headerLabels[i]);
    });
  }

  // Sorts a table's rows in place by a string read off each row — the
  // opposite of the admin dashboard's sort (which rebuilds rows from a
  // data array; safe there since those tables show read-only data). Here
  // the values that matter live only in each row's live input elements, so
  // sorting must reorder the existing <tr> nodes (appendChild on an
  // existing child MOVES it, it doesn't clone) rather than rebuild them —
  // rebuilding would silently wipe whatever the user just typed.
  //
  // `columns` is one or more { index, getValue } sortable headers on the
  // same table. Only one column shows as the active sort at a time (the
  // previous one's arrow clears), matching the admin dashboard's look;
  // clicking a column reverses it on repeat clicks, same as before.
  function initSortableColumns(theadRow, tbody, columns) {
    var activeTh = null;
    var activeDir = 1;

    columns.forEach(function (col) {
      var th = theadRow.children[col.index];
      if (!th) return;
      th.classList.add('is-sortable');

      th.addEventListener('click', function () {
        var dir = activeTh === th ? -activeDir : 1;

        var rows = Array.from(tbody.children).sort(function (a, b) {
          return col.getValue(a).localeCompare(col.getValue(b)) * dir;
        });
        rows.forEach(function (row) { tbody.appendChild(row); });

        if (activeTh && activeTh !== th) activeTh.classList.remove('is-sorted-asc', 'is-sorted-desc');
        th.classList.toggle('is-sorted-asc', dir === 1);
        th.classList.toggle('is-sorted-desc', dir === -1);
        activeTh = th;
        activeDir = dir;
      });
    });
  }

  function numberInput(attrs) {
    var input = el('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.inputMode = 'decimal';
    Object.keys(attrs).forEach(function (key) {
      input.setAttribute(key, attrs[key]);
    });
    return input;
  }

  // Groups a flat catalog array into an ordered Map, preserving first-seen
  // group order (catalog rows come back in sheet insertion order).
  function groupBy(items, key) {
    var groups = new Map();
    items.forEach(function (item) {
      var k = item[key] || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    });
    return groups;
  }

  // =========================================================================
  // Autosave — in-progress entries survive a refresh or interruption until
  // the user submits. Scoped per form type AND per logged-in username, so
  // one person's draft never surfaces for the next person on a shared
  // device (e.g. a shop tablet).
  // =========================================================================
  var DRAFT_BANNER_SHOWN = {};
  var autosaveTimers = {};

  function draftKey(formType) {
    var session = window.Auth && Auth.getSession();
    return 'shibam_team_draft_' + formType + '_' + (session ? session.username : 'anon');
  }

  function loadDraft(formType) {
    try {
      var raw = localStorage.getItem(draftKey(formType));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveDraft(formType, data) {
    try {
      data.savedAt = new Date().toISOString();
      localStorage.setItem(draftKey(formType), JSON.stringify(data));
    } catch (e) { /* storage full/unavailable — autosave just no-ops */ }
  }

  function clearDraft(formType) {
    try { localStorage.removeItem(draftKey(formType)); } catch (e) {}
  }

  function formatDraftTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  // Reads every tracked field inside `mount`'s rows into a plain object
  // keyed by each row's id (its dataset attributes in `idAttrs`, joined —
  // e.g. catalogId, or product+vendor for the one form with no catalogId).
  // `fields` maps a short key to the CSS selector for that input in a row.
  function collectRowFields(mount, idAttrs, fields) {
    var byId = {};
    mount.querySelectorAll('tbody tr').forEach(function (row) {
      var id = idAttrs.map(function (a) { return row.dataset[a] || ''; }).join('|');
      if (!id.trim()) return;
      var values = {};
      Object.keys(fields).forEach(function (key) {
        var input = row.querySelector(fields[key]);
        if (input) values[key] = input.value;
      });
      byId[id] = values;
    });
    return byId;
  }

  function applyRowFields(mount, idAttrs, fields, byId) {
    if (!byId) return false;
    var applied = false;
    mount.querySelectorAll('tbody tr').forEach(function (row) {
      var id = idAttrs.map(function (a) { return row.dataset[a] || ''; }).join('|');
      var saved = byId[id];
      if (!saved) return;
      Object.keys(fields).forEach(function (key) {
        if (saved[key] === undefined) return;
        var input = row.querySelector(fields[key]);
        if (input) { input.value = saved[key]; applied = true; }
      });
    });
    return applied;
  }

  // =========================================================================
  // Recall — reopen a submission from earlier today (same calendar day, per
  // the backend's own check) to fix a mistake. Resubmitting overwrites that
  // submission via updateMyEntries instead of creating a new one.
  // =========================================================================
  var editingSubmissionId = {}; // formType -> submissionId currently being edited, or null

  function formatRecallTime(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function showEditingBanner(form, formType, onCancel) {
    clearEditingBanner(form);
    var banner = el('div', 'editing-banner');
    banner.appendChild(el('span', 'editing-banner__text', 'Editing a submission from earlier today — submitting will update it, not add a new one.'));
    var cancelBtn = el('button', 'btn-remove-row', 'Cancel edit');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', onCancel);
    banner.appendChild(cancelBtn);
    form.insertBefore(banner, form.firstChild);
  }

  function clearEditingBanner(form) {
    var existing = form.querySelector('.editing-banner');
    if (existing) existing.remove();
  }

  // Builds the "Recall today's submission" toggle + picker, and wires
  // `applyItems(submission)` to actually populate the form once one is
  // chosen. Appended near the top of `mount` (the item table's container),
  // right before its rows — this is called once per form, right after that
  // form's rows exist, same timing as initAutosave.
  function initRecall(formType, form, mount, applyItems) {
    var bar = el('div', 'recall-bar');
    var toggle = el('button', 'btn-outline', 'Recall today’s submission');
    toggle.type = 'button';
    bar.appendChild(toggle);

    var panel = el('div', 'recall-panel');
    panel.hidden = true;
    bar.appendChild(panel);

    toggle.addEventListener('click', function () {
      if (!panel.hidden) { panel.hidden = true; return; }
      panel.hidden = false;
      panel.innerHTML = 'Loading…';

      Auth.apiCall('getMyEntries', { formType: formType }).then(function (result) {
        panel.innerHTML = '';
        if (!result.ok || !Array.isArray(result.submissions) || !result.submissions.length) {
          panel.appendChild(el('span', null, 'No submissions from earlier today yet.'));
          return;
        }

        var select = el('select');
        select.setAttribute('aria-label', 'Choose a submission from today to edit');
        result.submissions.forEach(function (sub, i) {
          var label = formatRecallTime(sub.submittedAt) + ' — ' + sub.items.length + (sub.items.length === 1 ? ' item' : ' items');
          var option = el('option', null, label);
          option.value = String(i);
          select.appendChild(option);
        });
        panel.appendChild(select);

        var loadBtn = el('button', 'btn btn-primary', 'Load');
        loadBtn.type = 'button';
        loadBtn.addEventListener('click', function () {
          var sub = result.submissions[Number(select.value)];
          applyItems(sub);
          editingSubmissionId[formType] = sub.submissionId;
          showEditingBanner(form, formType, function () {
            editingSubmissionId[formType] = null;
            clearEditingBanner(form);
          });
          panel.hidden = true;
        });
        panel.appendChild(loadBtn);
      });
    });

    mount.insertBefore(bar, mount.firstChild);
  }

  function showDraftBanner(form, formType, savedAt) {
    if (DRAFT_BANNER_SHOWN[formType]) return;
    DRAFT_BANNER_SHOWN[formType] = true;

    var banner = el('div', 'draft-banner');
    banner.appendChild(el('span', 'draft-banner__text', 'Restored a saved draft from ' + formatDraftTime(savedAt) + '.'));

    var discardBtn = el('button', 'btn-remove-row', 'Discard draft');
    discardBtn.type = 'button';
    discardBtn.addEventListener('click', function () {
      clearDraft(formType);
      // A full reload is the simplest reliable way back to a genuinely
      // blank form across all four forms' different rendering paths,
      // and discarding is a rare, deliberate action.
      window.location.reload();
    });

    var dismissBtn = el('button', 'draft-banner__dismiss', '×');
    dismissBtn.type = 'button';
    dismissBtn.setAttribute('aria-label', 'Dismiss this message');
    dismissBtn.addEventListener('click', function () { banner.remove(); });

    banner.appendChild(discardBtn);
    banner.appendChild(dismissBtn);
    form.insertBefore(banner, form.firstChild);
  }

  // Wires up debounced autosave (any input inside `form` triggers a save
  // ~500ms after the last keystroke) and, if a draft already exists for
  // this form+user, applies it via `restore(draft)` and shows the banner.
  function initAutosave(formType, form, collect, restore) {
    var draft = loadDraft(formType);
    if (draft && restore(draft)) {
      showDraftBanner(form, formType, draft.savedAt);
    }

    form.addEventListener('input', function () {
      clearTimeout(autosaveTimers[formType]);
      autosaveTimers[formType] = setTimeout(function () {
        saveDraft(formType, collect());
      }, 500);
    });
  }

  // ---------------------------------------------------------------------
  // Role-gated "flag / discontinue" actions cell, appended to a table row
  // for any catalog-backed item. Lead can flag, Management can discontinue
  // outright — both act immediately and re-render on success.
  // ---------------------------------------------------------------------
  function appendActionsCell(row, item, onChange) {
    var session = window.Auth && Auth.getSession();
    if (!Auth.hasRole(session, 'lead')) return;

    var cell = el('td', 'count-table__actions');

    if (Auth.hasRole(session, 'lead')) {
      var flagBtn = el('button', 'btn-inline-action', item.status === 'flagged' ? 'Flagged' : 'Flag');
      flagBtn.type = 'button';
      flagBtn.disabled = item.status === 'flagged';
      flagBtn.addEventListener('click', function () {
        flagBtn.disabled = true;
        Auth.apiCall('flagItem', { catalogId: item.catalogId }).then(function (result) {
          if (result.ok) { flagBtn.textContent = 'Flagged'; }
          else { flagBtn.disabled = false; }
        });
      });
      cell.appendChild(flagBtn);
    }

    if (Auth.hasRole(session, 'management')) {
      var discontinueBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Discontinue');
      discontinueBtn.type = 'button';
      discontinueBtn.addEventListener('click', function () {
        if (!window.confirm('Discontinue "' + item.name + '"? It will disappear from this form immediately.')) return;
        discontinueBtn.disabled = true;
        Auth.apiCall('discontinueItem', { catalogId: item.catalogId }).then(function (result) {
          if (result.ok && onChange) onChange();
        });
      });
      cell.appendChild(discontinueBtn);
    }

    row.appendChild(cell);
  }

  // "+ Add item" affordance shown under a section for Lead+. Posts addItem
  // and re-renders the whole form so the new row appears in place.
  function appendAddItemRow(container, formType, defaults, fields, onAdded) {
    var session = window.Auth && Auth.getSession();
    if (!Auth.hasRole(session, 'lead')) return;

    var wrap = el('div', 'add-item-row');
    var toggle = el('button', 'btn-outline btn-add-item', '+ Add item');
    toggle.type = 'button';

    var formWrap = el('div', 'add-item-form');
    formWrap.hidden = true;

    var inputs = {};
    fields.forEach(function (f) {
      var input = el('input');
      input.type = 'text';
      input.placeholder = f.label;
      input.setAttribute('aria-label', f.label);
      inputs[f.key] = input;
      formWrap.appendChild(input);
    });

    var saveBtn = el('button', 'btn btn-primary', 'Save item');
    saveBtn.type = 'button';
    var cancelBtn = el('button', 'btn-remove-row', 'Cancel');
    cancelBtn.type = 'button';

    saveBtn.addEventListener('click', function () {
      var name = inputs.name.value.trim();
      if (!name) { inputs.name.classList.add('invalid'); return; }

      var item = Object.assign({}, defaults, { name: name });
      fields.forEach(function (f) {
        if (f.key !== 'name') item[f.key] = inputs[f.key].value.trim();
      });

      saveBtn.disabled = true;
      Auth.apiCall('addItem', { formType: formType, item: item }).then(function (result) {
        if (result.ok && onAdded) onAdded();
        else saveBtn.disabled = false;
      });
    });

    cancelBtn.addEventListener('click', function () {
      formWrap.hidden = true;
      toggle.hidden = false;
    });
    formWrap.appendChild(saveBtn);
    formWrap.appendChild(cancelBtn);

    toggle.addEventListener('click', function () {
      toggle.hidden = true;
      formWrap.hidden = false;
      inputs.name.focus();
    });

    wrap.appendChild(toggle);
    wrap.appendChild(formWrap);
    container.appendChild(wrap);
  }

  // ---------------------------------------------------------------------
  // Form 1 — weekly count. One section per catalog group, labeled with the
  // room it's counted in so the sheet can be worked through room by room.
  // ---------------------------------------------------------------------
  function renderInventoryForm() {
    var mount = document.getElementById('inventory-items');
    if (!mount) return;
    mount.textContent = 'Loading catalog…';

    Auth.apiCall('getCatalog', { formType: 'inventory' }).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok || !Array.isArray(result.items)) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }

      var session = Auth.getSession();
      var showActions = Auth.hasRole(session, 'lead');
      var groups = groupBy(result.items, 'group');

      groups.forEach(function (items, groupName) {
        var section = el('section', 'count-section');
        var head = el('div', 'count-section__head');
        head.appendChild(el('h3', 'count-section__title', groupName));
        head.appendChild(el('span', 'count-section__location', items[0].location || ''));
        section.appendChild(head);

        var wrap = el('div', 'table-scroll');
        var table = el('table', 'count-table');
        var thead = el('thead');
        var headRow = el('tr');
        var headers = ['Item', 'Unit', 'Qty in Kitchen', 'Qty in Storage', 'Notes'];
        if (showActions) headers.push('Actions');
        headers.forEach(function (label) { headRow.appendChild(el('th', null, label)); });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        items.forEach(function (item) {
          var row = el('tr');
          row.dataset.product = item.name;
          row.dataset.category = groupName;
          row.dataset.catalogId = item.catalogId;
          row.dataset.unit = item.unit || '';

          row.appendChild(el('th', 'count-table__item', item.name));
          row.appendChild(el('td', 'count-table__unit', item.unit));

          var qtyKitchenCell = el('td');
          qtyKitchenCell.appendChild(numberInput({ 'data-qty-kitchen': '', 'required': '', 'value': '0', 'aria-label': 'Quantity in the kitchen for ' + item.name }));
          row.appendChild(qtyKitchenCell);

          var qtyStorageCell = el('td');
          qtyStorageCell.appendChild(numberInput({ 'data-qty-storage': '', 'required': '', 'value': '0', 'aria-label': 'Quantity in storage for ' + item.name }));
          row.appendChild(qtyStorageCell);

          var noteCell = el('td');
          var note = el('input');
          note.type = 'text';
          note.setAttribute('data-note', '');
          note.setAttribute('aria-label', 'Notes for ' + item.name);
          note.placeholder = 'Optional';
          noteCell.appendChild(note);
          row.appendChild(noteCell);

          if (showActions) appendActionsCell(row, item, renderInventoryForm);

          applyDataLabels(row, headers);
          tbody.appendChild(row);
        });

        initSortableColumns(headRow, tbody, [
          { index: 0, getValue: function (row) { return row.dataset.product || ''; } },
          { index: 1, getValue: function (row) { return row.dataset.unit || ''; } }
        ]);

        table.appendChild(tbody);
        wrap.appendChild(table);
        section.appendChild(wrap);

        appendAddItemRow(section, 'inventory',
          { group: groupName, location: items[0].location || '' },
          [{ key: 'name', label: 'Item name' }, { key: 'unit', label: 'Unit (lb, Box, Tray…)' }],
          renderInventoryForm);

        mount.appendChild(section);
      });

      var form = mount.closest('form');
      if (form) {
        initAutosave('inventory', form,
          function collect() {
            return {
              weekOf: form.querySelector('[name="weekOf"]').value,
              items: collectRowFields(mount, ['catalogId'], { qtyKitchen: '[data-qty-kitchen]', qtyStorage: '[data-qty-storage]', note: '[data-note]' })
            };
          },
          function restore(draft) {
            if (draft.weekOf) form.querySelector('[name="weekOf"]').value = draft.weekOf;
            return applyRowFields(mount, ['catalogId'], { qtyKitchen: '[data-qty-kitchen]', qtyStorage: '[data-qty-storage]', note: '[data-note]' }, draft.items);
          });

        initRecall('inventory', form, mount, function applyItems(sub) {
          form.querySelector('[name="weekOf"]').value = sub.date;
          var byProduct = {};
          sub.items.forEach(function (item) {
            var parsed = JSON.parse(item.details);
            byProduct[item.product] = { qtyKitchen: parsed.qtyKitchen, qtyStorage: parsed.qtyStorage, note: parsed.notes || '' };
          });
          applyRowFields(mount, ['product'], { qtyKitchen: '[data-qty-kitchen]', qtyStorage: '[data-qty-storage]', note: '[data-note]' }, byProduct);
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Form 2, Tab A — daily dessert count plus deliveries received.
  // ---------------------------------------------------------------------
  function renderDessertDailyForm() {
    var mount = document.getElementById('dessert-daily-items');
    if (!mount) return;
    mount.textContent = 'Loading catalog…';

    Auth.apiCall('getCatalog', { formType: 'dessert' }).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok || !Array.isArray(result.items)) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }

      var session = Auth.getSession();
      var showActions = Auth.hasRole(session, 'lead');

      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      var headers = ['Dessert', 'Group', 'Count on Hand', 'New Delivery Received'];
      if (showActions) headers.push('Actions');
      headers.forEach(function (label) { headRow.appendChild(el('th', null, label)); });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      result.items.forEach(function (item) {
        var row = el('tr');
        row.dataset.product = item.name;
        row.dataset.catalogId = item.catalogId;
        row.dataset.group = item.group || '';

        row.appendChild(el('th', 'count-table__item', item.name));
        row.appendChild(el('td', 'count-table__unit', item.group || '—'));

        var countCell = el('td');
        countCell.appendChild(numberInput({ 'data-count': '', 'required': '', 'value': '0', 'aria-label': 'Count on hand for ' + item.name }));
        row.appendChild(countCell);

        var deliveryCell = el('td');
        deliveryCell.appendChild(numberInput({ 'data-delivery': '', 'required': '', 'value': '0', 'aria-label': 'New delivery received for ' + item.name }));
        row.appendChild(deliveryCell);

        if (showActions) appendActionsCell(row, item, renderDessertDailyForm);

        applyDataLabels(row, headers);
        tbody.appendChild(row);
      });

      initSortableColumns(headRow, tbody, [
        { index: 0, getValue: function (row) { return row.dataset.product || ''; } },
        { index: 1, getValue: function (row) { return row.dataset.group || ''; } }
      ]);

      table.appendChild(tbody);
      wrap.appendChild(table);
      mount.appendChild(wrap);

      appendAddItemRow(mount, 'dessert', { group: '', location: '' },
        [{ key: 'name', label: 'Dessert name' }],
        renderDessertDailyForm);

      var form = mount.closest('form');
      if (form) {
        initAutosave('dessert-daily', form,
          function collect() {
            return {
              date: form.querySelector('[name="date"]').value,
              items: collectRowFields(mount, ['catalogId'], { count: '[data-count]', delivery: '[data-delivery]' })
            };
          },
          function restore(draft) {
            if (draft.date) form.querySelector('[name="date"]').value = draft.date;
            return applyRowFields(mount, ['catalogId'], { count: '[data-count]', delivery: '[data-delivery]' }, draft.items);
          });

        initRecall('dessert-daily', form, mount, function applyItems(sub) {
          form.querySelector('[name="date"]').value = sub.date;
          var byProduct = {};
          sub.items.forEach(function (item) {
            var parsed = JSON.parse(item.details);
            byProduct[item.product] = { count: parsed.countOnHand, delivery: parsed.deliveryReceived };
          });
          applyRowFields(mount, ['product'], { count: '[data-count]', delivery: '[data-delivery]' }, byProduct);
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Form 2, Tab B — standing vendor order. Kept as a static list (not
  // catalog-managed) since Mon/Fri standing quantities don't fit the
  // shared Catalog schema — see team/README.md.
  // ---------------------------------------------------------------------
  function renderDessertOrderForm() {
    var mount = document.getElementById('dessert-order-items');
    if (!mount || typeof DESSERT_VENDOR_ORDERS === 'undefined') return;
    mount.innerHTML = ''; // defensive: this form has no re-render trigger of its own today, but a draft Discard reloads the page rather than calling this again, so this guards against any future double-call.

    DESSERT_VENDOR_ORDERS.forEach(function (group) {
      var section = el('section', 'count-section');
      var head = el('div', 'count-section__head');
      head.appendChild(el('h3', 'count-section__title', group.vendor));
      section.appendChild(head);

      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      var headers = ['Item', 'Standing Mon', 'Standing Fri', 'New Mon', 'New Fri'];
      headers.forEach(function (label) {
        headRow.appendChild(el('th', null, label));
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      group.items.forEach(function (item) {
        var row = el('tr');
        row.dataset.product = item.name;
        row.dataset.vendor = group.vendor;
        row.dataset.standingMon = item.mon;
        row.dataset.standingFri = item.fri;

        row.appendChild(el('th', 'count-table__item', item.name));
        row.appendChild(el('td', 'count-table__standing', String(item.mon)));
        row.appendChild(el('td', 'count-table__standing', String(item.fri)));

        var newMonCell = el('td');
        newMonCell.appendChild(numberInput({ 'data-new-mon': '', 'required': '', 'value': String(item.mon), 'aria-label': 'New Monday quantity for ' + item.name }));
        row.appendChild(newMonCell);

        var newFriCell = el('td');
        newFriCell.appendChild(numberInput({ 'data-new-fri': '', 'required': '', 'value': String(item.fri), 'aria-label': 'New Friday quantity for ' + item.name }));
        row.appendChild(newFriCell);

        applyDataLabels(row, headers);
        tbody.appendChild(row);
      });

      initSortableColumns(headRow, tbody, [
        { index: 0, getValue: function (row) { return row.dataset.product || ''; } }
      ]);

      table.appendChild(tbody);
      wrap.appendChild(table);
      section.appendChild(wrap);
      mount.appendChild(section);
    });

    var form = mount.closest('form');
    if (form) {
      initAutosave('dessert-order', form,
        function collect() {
          return {
            orderDate: form.querySelector('[name="orderDate"]').value,
            items: collectRowFields(mount, ['product', 'vendor'], { newMon: '[data-new-mon]', newFri: '[data-new-fri]' })
          };
        },
        function restore(draft) {
          if (draft.orderDate) form.querySelector('[name="orderDate"]').value = draft.orderDate;
          return applyRowFields(mount, ['product', 'vendor'], { newMon: '[data-new-mon]', newFri: '[data-new-fri]' }, draft.items);
        });

      initRecall('dessert-order', form, mount, function applyItems(sub) {
        form.querySelector('[name="orderDate"]').value = sub.date;
        var byId = {};
        sub.items.forEach(function (item) {
          var parsed = JSON.parse(item.details);
          byId[item.product + '|' + (parsed.vendor || '')] = { newMon: parsed.newMon, newFri: parsed.newFri };
        });
        applyRowFields(mount, ['product', 'vendor'], { newMon: '[data-new-mon]', newFri: '[data-new-fri]' }, byId);
      });
    }
  }

  // ---------------------------------------------------------------------
  // Form 3 — local market run. Every item is always visible; rows below
  // their threshold highlight and flip Order? to Yes as a scanning aid.
  // ---------------------------------------------------------------------
  function renderLocalOrderForm() {
    var mount = document.getElementById('local-order-items');
    if (!mount) return;
    mount.textContent = 'Loading catalog…';

    Auth.apiCall('getCatalog', { formType: 'local-order' }).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok || !Array.isArray(result.items)) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }

      var session = Auth.getSession();
      var showActions = Auth.hasRole(session, 'lead');
      var groups = groupBy(result.items, 'group');

      groups.forEach(function (items, groupName) {
        var section = el('section', 'count-section');
        var head = el('div', 'count-section__head');
        head.appendChild(el('h3', 'count-section__title', groupName));
        section.appendChild(head);

        if (LOCAL_ORDER_NOTES[groupName]) {
          section.appendChild(el('p', 'count-section__note', LOCAL_ORDER_NOTES[groupName]));
        }

        var wrap = el('div', 'table-scroll');
        var table = el('table', 'count-table');
        var thead = el('thead');
        var headRow = el('tr');
        var headers = ['Item', 'Unit', 'Order Below', 'How Many Do We Have?', 'Order?'];
        if (showActions) headers.push('Actions');
        headers.forEach(function (label) { headRow.appendChild(el('th', null, label)); });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = el('tbody');
        items.forEach(function (item) {
          var row = el('tr');
          row.dataset.product = item.name;
          row.dataset.threshold = item.threshold;
          row.dataset.unit = item.unit;
          row.dataset.catalogId = item.catalogId;

          row.appendChild(el('th', 'count-table__item', item.name));
          row.appendChild(el('td', 'count-table__unit', item.unit));
          row.appendChild(el('td', 'count-table__threshold', String(item.threshold)));

          var stockCell = el('td');
          stockCell.appendChild(numberInput({ 'data-stock': '', 'required': '', 'aria-label': 'Current stock of ' + item.name }));
          row.appendChild(stockCell);

          var orderCell = el('td');
          var order = el('select');
          order.setAttribute('data-order', '');
          order.setAttribute('aria-label', 'Order ' + item.name + '?');
          ['No', 'Yes'].forEach(function (value) {
            var option = el('option', null, value);
            option.value = value;
            order.appendChild(option);
          });
          orderCell.appendChild(order);
          row.appendChild(orderCell);

          if (showActions) appendActionsCell(row, item, renderLocalOrderForm);

          applyDataLabels(row, headers);
          tbody.appendChild(row);
        });

        initSortableColumns(headRow, tbody, [
        { index: 0, getValue: function (row) { return row.dataset.product || ''; } }
      ]);

        table.appendChild(tbody);
        wrap.appendChild(table);
        section.appendChild(wrap);

        appendAddItemRow(section, 'local-order',
          { group: groupName },
          [{ key: 'name', label: 'Item name' }, { key: 'unit', label: 'Unit' }, { key: 'threshold', label: 'Order below (number)' }],
          renderLocalOrderForm);

        mount.appendChild(section);
      });

      initThresholdLogic(mount);

      var form = mount.closest('form');
      if (form) {
        initAutosave('local-order', form,
          function collect() {
            var unlistedMount = document.getElementById('unlisted-items');
            var unlisted = unlistedMount
              ? Array.from(unlistedMount.querySelectorAll('.unlisted-row')).map(function (row) {
                return {
                  name: row.querySelector('[data-unlisted-name]').value,
                  qty: row.querySelector('[data-unlisted-qty]').value
                };
              })
              : [];
            return {
              date: form.querySelector('[name="date"]').value,
              items: collectRowFields(mount, ['catalogId'], { stock: '[data-stock]', order: '[data-order]' }),
              unlisted: unlisted
            };
          },
          function restore(draft) {
            if (draft.date) form.querySelector('[name="date"]').value = draft.date;
            var applied = applyRowFields(mount, ['catalogId'], { stock: '[data-stock]', order: '[data-order]' }, draft.items);

            // Setting .value programmatically doesn't fire an input event,
            // so the threshold-highlight listener (initThresholdLogic)
            // never sees these restored values — nudge it explicitly.
            mount.querySelectorAll('[data-stock]').forEach(function (input) {
              if (input.value !== '') input.dispatchEvent(new Event('input', { bubbles: true }));
            });

            var unlistedMount = document.getElementById('unlisted-items');
            if (unlistedMount && Array.isArray(draft.unlisted) && draft.unlisted.length) {
              unlistedMount.innerHTML = '';
              draft.unlisted.forEach(function (item) {
                var row = buildUnlistedRow();
                row.querySelector('[data-unlisted-name]').value = item.name || '';
                row.querySelector('[data-unlisted-qty]').value = item.qty || '';
                unlistedMount.appendChild(row);
              });
              applied = true;
            }
            return applied;
          });

        initRecall('local-order', form, mount, function applyItems(sub) {
          form.querySelector('[name="date"]').value = sub.date;

          var byProduct = {};
          var unlisted = [];
          sub.items.forEach(function (item) {
            var parsed = JSON.parse(item.details);
            if ('qty' in parsed && 'name' in parsed && !('currentStock' in parsed)) {
              unlisted.push({ name: parsed.name, qty: parsed.qty });
            } else {
              byProduct[item.product] = { stock: parsed.currentStock, order: parsed.order };
            }
          });
          applyRowFields(mount, ['product'], { stock: '[data-stock]', order: '[data-order]' }, byProduct);

          // Setting .value programmatically doesn't fire an input event, so
          // the threshold-highlight listener never sees these — nudge it.
          mount.querySelectorAll('[data-stock]').forEach(function (input) {
            if (input.value !== '') input.dispatchEvent(new Event('input', { bubbles: true }));
          });

          var unlistedMount = document.getElementById('unlisted-items');
          if (unlistedMount) {
            unlistedMount.innerHTML = '';
            if (unlisted.length) {
              unlisted.forEach(function (item) {
                var row = buildUnlistedRow();
                row.querySelector('[data-unlisted-name]').value = item.name || '';
                row.querySelector('[data-unlisted-qty]').value = item.qty || '';
                unlistedMount.appendChild(row);
              });
            } else {
              unlistedMount.appendChild(buildUnlistedRow());
            }
          }
        });
      }
    });
  }

  // A row whose stock has been typed and sits below the threshold turns red
  // and auto-selects Yes. The employee can still override the dropdown.
  function initThresholdLogic(mount) {
    mount.addEventListener('input', function (e) {
      var stock = e.target.closest('[data-stock]');
      if (!stock) return;

      var row = stock.closest('tr');
      var order = row.querySelector('[data-order]');
      var threshold = parseFloat(row.dataset.threshold);

      if (stock.value === '') {
        row.classList.remove('below-threshold');
        return;
      }

      var below = parseFloat(stock.value) < threshold;
      row.classList.toggle('below-threshold', below);
      if (order) order.value = below ? 'Yes' : 'No';
    });
  }

  // ---------------------------------------------------------------------
  // Free-write rows for anything not on the standing local-order list.
  // ---------------------------------------------------------------------
  function initUnlistedItems() {
    var mount = document.getElementById('unlisted-items');
    var addBtn = document.getElementById('add-unlisted-item');
    if (!mount || !addBtn) return;

    addBtn.addEventListener('click', function () {
      mount.appendChild(buildUnlistedRow());
      mount.lastElementChild.querySelector('input').focus();
    });

    mount.addEventListener('click', function (e) {
      var remove = e.target.closest('[data-remove-row]');
      if (remove) remove.closest('.unlisted-row').remove();
    });

    mount.appendChild(buildUnlistedRow());
  }

  function buildUnlistedRow() {
    var row = el('div', 'unlisted-row');

    var name = el('input');
    name.type = 'text';
    name.setAttribute('data-unlisted-name', '');
    name.setAttribute('aria-label', 'Item name');
    name.placeholder = 'Item name';
    row.appendChild(name);

    var qty = el('input');
    qty.type = 'text';
    qty.setAttribute('data-unlisted-qty', '');
    qty.setAttribute('aria-label', 'How many');
    qty.placeholder = 'How many';
    row.appendChild(qty);

    var remove = el('button', 'btn-remove-row', 'Remove');
    remove.type = 'button';
    remove.setAttribute('data-remove-row', '');
    row.appendChild(remove);

    return row;
  }

  // ---------------------------------------------------------------------
  // The local-order form's whole point is that someone looks at every item
  // before requesting a run, so submit stays locked until they confirm it.
  // ---------------------------------------------------------------------
  function initReviewGate() {
    var checkbox = document.getElementById('reviewed-full-list');
    if (!checkbox) return;

    var form = checkbox.closest('form');
    checkbox.addEventListener('change', function () { syncReviewGate(form); });
    syncReviewGate(form);
  }

  function syncReviewGate(form) {
    var checkbox = form.querySelector('#reviewed-full-list');
    var submitBtn = form.querySelector('button[type="submit"]');
    if (!checkbox || !submitBtn) return;
    submitBtn.disabled = !checkbox.checked;
  }

  // ---------------------------------------------------------------------
  // Tab switching between the two dessert sub-forms.
  // ---------------------------------------------------------------------
  function initTabs() {
    var tabs = document.querySelectorAll('[data-tab-target]');
    if (!tabs.length) return;

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var targetId = tab.getAttribute('data-tab-target');

        tabs.forEach(function (other) {
          var isActive = other === tab;
          other.classList.toggle('is-active', isActive);
          other.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        document.querySelectorAll('[data-tab-panel]').forEach(function (panel) {
          panel.hidden = panel.id !== targetId;
        });
      });
    });
  }

  // ---------------------------------------------------------------------
  // Submission — each form builds a payload and posts it through
  // Auth.apiCall('submitForm', ...), which attaches the session token.
  // employeeName is no longer typed in — it comes from the logged-in
  // session on the backend, so what's shown here is display-only.
  // ---------------------------------------------------------------------
  function initForms() {
    bindForm('inventory-form', 'inventory', buildInventoryPayload);
    bindForm('dessert-daily-form', 'dessert-daily', buildDessertDailyPayload);
    bindForm('dessert-order-form', 'dessert-order', buildDessertOrderPayload);
    bindForm('local-order-form', 'local-order', buildLocalOrderPayload);
  }

  function buildInventoryPayload(form) {
    return {
      weekOf: form.querySelector('[name="weekOf"]').value,
      items: Array.from(form.querySelectorAll('#inventory-items tbody tr')).map(function (row) {
        return {
          product: row.dataset.product,
          category: row.dataset.category,
          qtyKitchen: Number(row.querySelector('[data-qty-kitchen]').value),
          qtyStorage: Number(row.querySelector('[data-qty-storage]').value),
          notes: row.querySelector('[data-note]').value.trim()
        };
      })
    };
  }

  function buildDessertDailyPayload(form) {
    return {
      date: form.querySelector('[name="date"]').value,
      items: Array.from(form.querySelectorAll('#dessert-daily-items tbody tr')).map(function (row) {
        return {
          product: row.dataset.product,
          countOnHand: Number(row.querySelector('[data-count]').value),
          deliveryReceived: Number(row.querySelector('[data-delivery]').value)
        };
      })
    };
  }

  function buildDessertOrderPayload(form) {
    return {
      orderDate: form.querySelector('[name="orderDate"]').value,
      items: Array.from(form.querySelectorAll('#dessert-order-items tbody tr')).map(function (row) {
        return {
          product: row.dataset.product,
          vendor: row.dataset.vendor,
          standingMon: Number(row.dataset.standingMon),
          standingFri: Number(row.dataset.standingFri),
          newMon: Number(row.querySelector('[data-new-mon]').value),
          newFri: Number(row.querySelector('[data-new-fri]').value)
        };
      })
    };
  }

  function buildLocalOrderPayload(form) {
    var unlisted = Array.from(form.querySelectorAll('.unlisted-row'))
      .map(function (row) {
        return {
          name: row.querySelector('[data-unlisted-name]').value.trim(),
          qty: row.querySelector('[data-unlisted-qty]').value.trim()
        };
      })
      .filter(function (item) { return item.name !== ''; });

    return {
      date: form.querySelector('[name="date"]').value,
      items: Array.from(form.querySelectorAll('#local-order-items tbody tr')).map(function (row) {
        return {
          product: row.dataset.product,
          unit: row.dataset.unit,
          threshold: Number(row.dataset.threshold),
          currentStock: Number(row.querySelector('[data-stock]').value),
          order: row.querySelector('[data-order]').value
        };
      }),
      unlistedItems: unlisted
    };
  }

  function bindForm(formId, formType, buildPayload) {
    var form = document.getElementById(formId);
    if (!form) return;

    var status = form.querySelector('[data-form-status]');

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      if (!validateForm(form)) {
        setStatus(status, 'error', 'Some fields are missing or invalid — they’re highlighted above. Every count needs a number, even if it’s 0.');
        var firstInvalid = form.querySelector('.invalid');
        if (firstInvalid) firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      var editingId = editingSubmissionId[formType];
      var payload = Object.assign({
        formType: formType,
        store: (typeof CONFIG !== 'undefined' && CONFIG.STORE_NAME) || '',
        submittedAt: new Date().toISOString()
      }, buildPayload(form));
      if (editingId) payload.submissionId = editingId;

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      setStatus(status, null, editingId ? 'Saving…' : 'Submitting…');

      Auth.apiCall(editingId ? 'updateMyEntries' : 'submitForm', payload)
        .then(function (result) {
          if (result.ok) {
            var session = Auth.getSession();
            setStatus(status, 'success', editingId
              ? 'Updated — thanks, ' + (session ? session.name : 'you') + '. Your changes have been saved.'
              : 'Submitted — thanks, ' + (session ? session.name : 'you') + '. Your entry has been logged.');
            clearDraft(formType);
            editingSubmissionId[formType] = null;
            clearEditingBanner(form);
            form.reset();
            resetFormState(form);
          } else {
            setStatus(status, 'error', editingId
              ? 'Could not save your changes. Try again, or let a manager know.'
              : 'Something went wrong submitting that. Try again, or let a manager know.');
          }
        })
        .catch(function () {
          setStatus(status, 'error', 'Something went wrong submitting that. Try again, or let a manager know.');
        })
        .finally(function () {
          if (submitBtn) submitBtn.disabled = false;
          syncReviewGate(form);
        });
    });
  }

  // A count isn't complete until every required field has a value, so a
  // blank quantity is treated as an error rather than an implied zero.
  function validateForm(form) {
    var valid = true;

    form.querySelectorAll('[required]').forEach(function (field) {
      var value = field.value.trim();
      var fieldValid = value !== '';

      if (fieldValid && field.type === 'number') {
        var num = Number(value);
        fieldValid = !isNaN(num) && num >= 0;
      }

      field.classList.toggle('invalid', !fieldValid);
      if (!fieldValid) valid = false;
    });

    return valid;
  }

  function resetFormState(form) {
    form.querySelectorAll('.invalid').forEach(function (field) { field.classList.remove('invalid'); });
    form.querySelectorAll('.below-threshold').forEach(function (row) { row.classList.remove('below-threshold'); });
    setTodayDefaults();
  }

  function setStatus(el, state, message) {
    if (!el) return;
    el.textContent = message;
    if (state) { el.setAttribute('data-state', state); } else { el.removeAttribute('data-state'); }
  }
})();

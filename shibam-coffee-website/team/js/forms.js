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
    mount.querySelectorAll('tbody tr, .count-row').forEach(function (row) {
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
    mount.querySelectorAll('tbody tr, .count-row').forEach(function (row) {
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
  // Shared count-row pieces for the dessert and local-order forms — the
  // same compact mobile layout as the weekly inventory page (count-ui.js).
  // Values live in hidden inputs (data-count, data-stock, …) so autosave,
  // recall, and the payload builders read them like any other field.
  // ---------------------------------------------------------------------
  function buildCountHead(item, metaNodes, onNone, onChange) {
    var head = el('div', 'count-row__head');
    var label = el('div', 'count-row__label');
    label.appendChild(el('span', 'count-row__name', item.name));
    if (metaNodes) {
      var meta = el('span', 'count-row__meta');
      metaNodes.forEach(function (node) { meta.appendChild(typeof node === 'string' ? document.createTextNode(node) : node); });
      label.appendChild(meta);
    }
    head.appendChild(label);

    var tools = el('div', 'count-row__tools');
    var none = null;
    if (onNone) {
      none = CountUI.button('count-row__none', 'None', { 'aria-label': 'None of ' + item.name + ' — record 0 as checked' });
      none.addEventListener('click', onNone);
      tools.appendChild(none);
    }
    var actions = catalogActions(item, onChange);
    if (actions.length) tools.appendChild(CountUI.rowMenu(item.name, actions));
    head.appendChild(tools);
    return { root: head, none: none };
  }

  // Lead can flag; Management can retire (with a confirmation sheet). Both
  // live in the row's "⋯" menu, away from the count boxes.
  function catalogActions(item, onChange) {
    var session = window.Auth && Auth.getSession();
    var actions = [];
    if (!Auth.hasRole(session, 'lead')) return actions;
    actions.push({
      label: item.status === 'flagged' ? 'Flagged for review' : 'Flag for review',
      onSelect: function () {
        Auth.apiCall('flagItem', { catalogId: item.catalogId }).then(function (result) {
          if (result.ok) item.status = 'flagged';
        });
      }
    });
    if (Auth.hasRole(session, 'management')) {
      actions.push({
        label: 'Retire item (inactive)…',
        danger: true,
        onSelect: function () {
          CountUI.confirmSheet({
            title: 'Retire "' + item.name + '"?',
            message: 'It leaves this form but keeps its history. You can restore it from Admin → Catalog.',
            confirmLabel: 'Retire item',
            danger: true
          }).then(function (ok) {
            if (!ok) return;
            Auth.apiCall('discontinueItem', { catalogId: item.catalogId }).then(function (result) {
              if (result.ok && onChange) onChange();
            });
          });
        }
      });
    }
    return actions;
  }

  function rowComplete(row) {
    var values = Array.prototype.slice.call(row.querySelectorAll('[data-qty-hidden]'));
    return values.length > 0 && values.every(function (input) { return input.value !== ''; });
  }

  function updateCountRow(row) {
    var values = Array.prototype.slice.call(row.querySelectorAll('[data-qty-hidden]'));
    var complete = rowComplete(row);
    var zero = complete && values.every(function (input) { return Number(input.value) === 0; });
    row.classList.toggle('is-complete', complete);
    row.classList.toggle('is-zero', zero);
    if (complete) row.classList.remove('is-missing');
    var none = row.querySelector('.count-row__none');
    if (none) {
      var some = values.some(function (input) { return input.value !== ''; });
      none.textContent = zero ? '0 ✓' : (!complete && some && values.length > 1) ? 'Rest is 0' : 'None';
    }
  }

  function fillEmptyWithZero(row) {
    row.querySelectorAll('.qty-field').forEach(function (root) {
      var field = root.__qtyField;
      if (field && field.get() === null) field.set(0);
    });
    row.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Footer progress ("12 of 32 counted") and a Submit that stays disabled,
  // with the reason, until every row has a value.
  function initCountProgress(form, mount) {
    var text = form.querySelector('[data-progress-text]');
    var fill = form.querySelector('[data-progress-fill]');
    function update() {
      var rows = Array.prototype.slice.call(mount.querySelectorAll('.count-row'));
      rows.forEach(updateCountRow);
      var done = rows.filter(rowComplete).length;
      var left = rows.length - done;
      if (text) text.textContent = done + ' of ' + rows.length + ' counted';
      if (fill) fill.style.width = rows.length ? (done / rows.length * 100) + '%' : '0';
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) {
        submitBtn.setAttribute('aria-disabled', left ? 'true' : 'false');
        if (!submitBtn.dataset.label) submitBtn.dataset.label = submitBtn.textContent;
        submitBtn.textContent = left ? 'Submit · ' + left + ' left' : submitBtn.dataset.label;
      }
    }
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    form.addEventListener('count:refresh', update);
    update();
  }

  function refreshCountForm(form, mount) {
    CountUI.refreshFields(mount);
    form.dispatchEvent(new Event('count:refresh'));
  }

  // ---------------------------------------------------------------------
  // Form 2, Tab A — daily dessert count plus deliveries received. Boxes
  // start empty; "None" records 0 on purpose, so a blank means unchecked.
  // ---------------------------------------------------------------------
  function renderDessertDailyForm() {
    var mount = document.getElementById('dessert-daily-items');
    if (!mount) return;
    mount.textContent = 'Loading catalog…';

    Auth.apiCall('getCatalog', { formType: 'dessert' }).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok || !Array.isArray(result.items)) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }
      if (!result.items.length) { mount.textContent = 'No dessert items are configured yet. Ask Management to add catalog items.'; return; }

      var list = el('div', 'count-group__body');
      result.items.forEach(function (item) {
        var row = el('div', 'count-row');
        row.dataset.product = item.name;
        row.dataset.catalogId = item.catalogId;
        row.dataset.group = item.group || '';

        row.appendChild(buildCountHead(item, item.group ? [item.group] : null,
          function () { fillEmptyWithZero(row); }, renderDessertDailyForm).root);

        var fields = el('div', 'count-row__fields');
        fields.appendChild(CountUI.quantityField({ label: 'On hand', ariaName: item.name, allowFraction: false, dataAttr: 'data-count' }).root);
        fields.appendChild(CountUI.quantityField({ label: 'Delivered today', ariaName: item.name, allowFraction: false, dataAttr: 'data-delivery' }).root);
        row.appendChild(fields);
        list.appendChild(row);
      });
      mount.appendChild(list);

      appendAddItemRow(mount, 'dessert', { group: '', location: '' },
        [{ key: 'name', label: 'Dessert name' }],
        renderDessertDailyForm);

      var form = mount.closest('form');
      if (form) {
        CountUI.initKeyboardFlow(mount);
        initCountProgress(form, mount);
        initAutosave('dessert-daily', form,
          function collect() {
            return {
              date: form.querySelector('[name="date"]').value,
              items: collectRowFields(mount, ['catalogId'], { count: '[data-count]', delivery: '[data-delivery]' })
            };
          },
          function restore(draft) {
            if (draft.date) form.querySelector('[name="date"]').value = draft.date;
            var applied = applyRowFields(mount, ['catalogId'], { count: '[data-count]', delivery: '[data-delivery]' }, draft.items);
            refreshCountForm(form, mount);
            return applied;
          });

        initRecall('dessert-daily', form, mount, function applyItems(sub) {
          form.querySelector('[name="date"]').value = sub.date;
          var byProduct = {};
          sub.items.forEach(function (item) {
            var parsed = JSON.parse(item.details);
            byProduct[item.product] = { count: parsed.countOnHand, delivery: parsed.deliveryReceived };
          });
          applyRowFields(mount, ['product'], { count: '[data-count]', delivery: '[data-delivery]' }, byProduct);
          refreshCountForm(form, mount);
        });
      }
    }).catch(function () {
      mount.textContent = 'Could not load the item list. Check your connection and refresh to try again.';
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
      if (!result.items.length) { mount.textContent = 'No local-order items are configured yet. Ask Management to add catalog items.'; return; }

      var groups = groupBy(result.items, 'group');
      groups.forEach(function (items, groupName) {
        var section = el('section', 'count-group');
        var head = el('div', 'count-group__head');
        head.appendChild(el('span', 'count-group__title', groupName));
        section.appendChild(head);
        if (LOCAL_ORDER_NOTES[groupName]) section.appendChild(el('p', 'count-group__note', LOCAL_ORDER_NOTES[groupName]));

        items.forEach(function (item) {
          var row = el('div', 'count-row');
          row.dataset.product = item.name;
          row.dataset.threshold = item.threshold;
          row.dataset.unit = item.unit;
          row.dataset.catalogId = item.catalogId;

          var meta = [];
          if (item.unit) { meta.push('In '); meta.push(el('strong', null, item.unit)); }
          if (item.threshold !== '' && item.threshold !== undefined) meta.push((item.unit ? ' · ' : '') + 'order below ' + item.threshold);
          row.appendChild(buildCountHead(item, meta.length ? meta : null,
            function () { fillEmptyWithZero(row); }, renderLocalOrderForm).root);

          var fields = el('div', 'count-row__fields');
          fields.appendChild(CountUI.quantityField({ label: 'How many do we have?', ariaName: item.name, unit: item.unit, dataAttr: 'data-stock' }).root);
          fields.appendChild(buildOrderToggle(item));
          row.appendChild(fields);
          section.appendChild(row);
        });

        appendAddItemRow(section, 'local-order',
          { group: groupName },
          [{ key: 'name', label: 'Item name' }, { key: 'unit', label: 'Unit' }, { key: 'threshold', label: 'Order below (number)' }],
          renderLocalOrderForm);

        mount.appendChild(section);
      });

      initThresholdLogic(mount);

      var form = mount.closest('form');
      if (form) {
        CountUI.initKeyboardFlow(mount);
        initCountProgress(form, mount);
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
            syncLocalOrderRows(mount);
            refreshCountForm(form, mount);

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
          syncLocalOrderRows(mount);
          refreshCountForm(form, mount);

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
    }).catch(function () {
      mount.textContent = 'Could not load the item list. Check your connection and refresh to try again.';
    });
  }

  // Order? as a two-button No / Yes toggle (easier to hit than a dropdown),
  // backed by a hidden input so autosave and recall treat it like a field.
  function buildOrderToggle(item) {
    var wrap = el('div', 'count-row__order');
    wrap.appendChild(el('span', 'qty-field__label', 'Order?'));
    var toggle = el('div', 'seg-toggle');
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Order ' + item.name + '?');
    var hidden = el('input');
    hidden.type = 'hidden';
    hidden.value = 'No';
    hidden.setAttribute('data-order', '');
    ['No', 'Yes'].forEach(function (value) {
      var option = CountUI.button('seg-toggle__option' + (value === 'No' ? ' is-active' : ''), value,
        { 'aria-pressed': value === 'No' ? 'true' : 'false', 'data-order-option': value });
      option.addEventListener('click', function () {
        setOrderValue(wrap.closest('.count-row'), value);
        hidden.dispatchEvent(new Event('input', { bubbles: true }));
      });
      toggle.appendChild(option);
    });
    wrap.appendChild(toggle);
    wrap.appendChild(hidden);
    return wrap;
  }

  function setOrderValue(row, value) {
    if (!row) return;
    var hidden = row.querySelector('[data-order]');
    if (hidden) hidden.value = value;
    row.querySelectorAll('[data-order-option]').forEach(function (option) {
      var active = option.getAttribute('data-order-option') === value;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // After restore/recall: show each row's saved Order? choice and its
  // below-threshold highlight without overriding the saved choice.
  function syncLocalOrderRows(mount) {
    mount.querySelectorAll('.count-row').forEach(function (row) {
      var hidden = row.querySelector('[data-order]');
      setOrderValue(row, hidden && hidden.value === 'Yes' ? 'Yes' : 'No');
      updateThreshold(row, false);
    });
  }

  function updateThreshold(row, autoSelect) {
    var stock = row.querySelector('[data-stock]');
    var threshold = parseFloat(row.dataset.threshold);
    if (!stock || stock.value === '' || isNaN(threshold)) {
      row.classList.remove('below-threshold');
      return;
    }
    var below = parseFloat(stock.value) < threshold;
    row.classList.toggle('below-threshold', below);
    if (autoSelect) setOrderValue(row, below ? 'Yes' : 'No');
  }

  // A row whose stock has been entered and sits below the threshold turns
  // amber and auto-selects Yes. The employee can still flip it back.
  function initThresholdLogic(mount) {
    mount.addEventListener('input', function (e) {
      if (e.target.matches('[data-order]')) return;
      var row = e.target.closest('.count-row');
      if (row && row.querySelector('[data-stock]')) updateThreshold(row, true);
    });
    mount.addEventListener('change', function (e) {
      var row = e.target.closest('.count-row');
      if (row && e.target.matches('.qty-field__fraction')) updateThreshold(row, true);
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
    bindForm('dessert-daily-form', 'dessert-daily', buildDessertDailyPayload);
    bindForm('dessert-order-form', 'dessert-order', buildDessertOrderPayload);
    bindForm('local-order-form', 'local-order', buildLocalOrderPayload);
  }

  // A blank box is sent as null, never silently as 0.
  function valueOrNull(input) {
    return !input || input.value === '' ? null : Number(input.value);
  }

  function buildDessertDailyPayload(form) {
    return {
      date: form.querySelector('[name="date"]').value,
      items: Array.from(form.querySelectorAll('#dessert-daily-items .count-row')).map(function (row) {
        return {
          product: row.dataset.product,
          countOnHand: valueOrNull(row.querySelector('[data-count]')),
          deliveryReceived: valueOrNull(row.querySelector('[data-delivery]'))
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
      items: Array.from(form.querySelectorAll('#local-order-items .count-row')).map(function (row) {
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
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn && submitBtn.dataset.busy === 'true') return; // a double tap never sends twice

      if (!validateForm(form)) {
        var missingRows = form.querySelectorAll('.count-row.is-missing').length;
        setStatus(status, 'error', missingRows
          ? missingRows + (missingRows === 1 ? ' item still needs' : ' items still need') + ' a number or None.'
          : 'Some fields are missing or invalid — they’re highlighted above. Every count needs a number, even if it’s 0.');
        var firstInvalid = form.querySelector('.invalid');
        if (firstInvalid) firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      var editingId = editingSubmissionId[formType];
      var payload = Object.assign({
        formType: formType,
        store: (typeof CONFIG !== 'undefined' && CONFIG.STORE_NAME) || '',
      }, buildPayload(form));
      if (editingId) payload.submissionId = editingId;
      send(payload, editingId);
    });

    function send(payload, editingId) {
      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.dataset.busy = 'true'; }
      setStatus(status, null, editingId ? 'Saving…' : 'Submitting…');

      return Auth.apiCall(editingId ? 'updateMyEntries' : 'submitForm', payload)
        .then(function (result) {
          if (!result.ok && result.error === 'edit_reason_required') {
            // Edits more than an hour after submitting are logged with a reason.
            return CountUI.promptSheet({
              title: 'Why are you changing this?',
              message: 'It was submitted more than an hour ago, so the change is logged with a reason.',
              label: 'Reason for the change',
              confirmLabel: 'Save changes'
            }).then(function (reason) {
              if (reason === null) { setStatus(status, 'error', 'Changes not saved.'); return; }
              return send(Object.assign({}, payload, { reason: reason }), editingId);
            });
          }
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
          } else if (result.error === 'incomplete') {
            setStatus(status, 'error', (result.missingCount || 'Some') + ' items still need a number or None.');
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
          if (submitBtn) { submitBtn.disabled = false; submitBtn.dataset.busy = 'false'; }
          syncReviewGate(form);
          form.dispatchEvent(new Event('count:refresh'));
        });
    }
  }

  // A count isn't complete until every required field has a value, so a
  // blank quantity is treated as an error rather than an implied zero.
  function validateForm(form) {
    var valid = true;

    // Count rows: every item needs a value (0 entered on purpose counts).
    var firstMissing = null;
    form.querySelectorAll('.count-row').forEach(function (row) {
      var missing = !rowComplete(row);
      row.classList.toggle('is-missing', missing);
      if (missing) { valid = false; if (!firstMissing) firstMissing = row; }
    });
    if (firstMissing) CountUI.focusRow(firstMissing);

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
    // form.reset() leaves hidden inputs alone, so clear the count boxes explicitly.
    form.querySelectorAll('.qty-field').forEach(function (root) { if (root.__qtyField) root.__qtyField.set(null); });
    form.querySelectorAll('.count-row').forEach(function (row) {
      row.classList.remove('is-missing');
      if (row.querySelector('[data-order]')) setOrderValue(row, 'No');
    });
    form.dispatchEvent(new Event('count:refresh'));
    setTodayDefaults();
  }

  function setStatus(el, state, message) {
    if (!el) return;
    el.textContent = message;
    if (state) { el.setAttribute('data-state', state); } else { el.removeAttribute('data-state'); }
  }
})();

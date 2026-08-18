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
      if (!result.ok) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }

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
        var headers = ['Item', 'Unit', 'Qty on Hand', 'Notes'];
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

          row.appendChild(el('th', 'count-table__item', item.name));
          row.appendChild(el('td', 'count-table__unit', item.unit));

          var qtyCell = el('td');
          qtyCell.appendChild(numberInput({ 'data-qty': '', 'required': '', 'value': '0', 'aria-label': 'Quantity on hand for ' + item.name }));
          row.appendChild(qtyCell);

          var noteCell = el('td');
          var note = el('input');
          note.type = 'text';
          note.setAttribute('data-note', '');
          note.setAttribute('aria-label', 'Notes for ' + item.name);
          note.placeholder = 'Optional';
          noteCell.appendChild(note);
          row.appendChild(noteCell);

          if (showActions) appendActionsCell(row, item, renderInventoryForm);

          tbody.appendChild(row);
        });

        table.appendChild(tbody);
        wrap.appendChild(table);
        section.appendChild(wrap);

        appendAddItemRow(section, 'inventory',
          { group: groupName, location: items[0].location || '' },
          [{ key: 'name', label: 'Item name' }, { key: 'unit', label: 'Unit (lb, Box, Tray…)' }],
          renderInventoryForm);

        mount.appendChild(section);
      });
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
      if (!result.ok) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }

      var session = Auth.getSession();
      var showActions = Auth.hasRole(session, 'lead');

      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      var headers = ['Dessert', 'Count on Hand', 'New Delivery Received'];
      if (showActions) headers.push('Actions');
      headers.forEach(function (label) { headRow.appendChild(el('th', null, label)); });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      result.items.forEach(function (item) {
        var row = el('tr');
        row.dataset.product = item.name;
        row.dataset.catalogId = item.catalogId;

        row.appendChild(el('th', 'count-table__item', item.name));

        var countCell = el('td');
        countCell.appendChild(numberInput({ 'data-count': '', 'required': '', 'value': '0', 'aria-label': 'Count on hand for ' + item.name }));
        row.appendChild(countCell);

        var deliveryCell = el('td');
        deliveryCell.appendChild(numberInput({ 'data-delivery': '', 'required': '', 'value': '0', 'aria-label': 'New delivery received for ' + item.name }));
        row.appendChild(deliveryCell);

        if (showActions) appendActionsCell(row, item, renderDessertDailyForm);

        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
      mount.appendChild(wrap);

      appendAddItemRow(mount, 'dessert', { group: '', location: '' },
        [{ key: 'name', label: 'Dessert name' }],
        renderDessertDailyForm);
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

    DESSERT_VENDOR_ORDERS.forEach(function (group) {
      var section = el('section', 'count-section');
      var head = el('div', 'count-section__head');
      head.appendChild(el('h3', 'count-section__title', group.vendor));
      section.appendChild(head);

      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      ['Item', 'Standing Mon', 'Standing Fri', 'New Mon', 'New Fri'].forEach(function (label) {
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

        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      wrap.appendChild(table);
      section.appendChild(wrap);
      mount.appendChild(section);
    });
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
      if (!result.ok) { mount.textContent = 'Could not load the item list. Refresh to try again.'; return; }

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

          tbody.appendChild(row);
        });

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
          qtyOnHand: Number(row.querySelector('[data-qty]').value),
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

      var payload = Object.assign({
        formType: formType,
        store: (typeof CONFIG !== 'undefined' && CONFIG.STORE_NAME) || '',
        submittedAt: new Date().toISOString()
      }, buildPayload(form));

      var submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      setStatus(status, null, 'Submitting…');

      Auth.apiCall('submitForm', payload)
        .then(function (result) {
          if (result.ok) {
            var session = Auth.getSession();
            setStatus(status, 'success', 'Submitted — thanks, ' + (session ? session.name : 'you') + '. Your entry has been logged.');
            form.reset();
            resetFormState(form);
          } else {
            setStatus(status, 'error', 'Something went wrong submitting that. Try again, or let a manager know.');
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

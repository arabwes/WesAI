// /team/js/admin.js
// Shibam Coffee Atlanta — Management admin dashboard (submissions, catalog,
// users, changelog). Loaded after config.js and auth.js. This page is gated
// by data-require-role="management" in auth.js — nothing here re-checks
// that, same trust boundary as everywhere else: the backend enforces it too.

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    setFooterYear();
    renderSessionBanner();
    initTabs();
    initSubmissionsTab();
    initCatalogTab();
    initUsersTab();
    initChangelogTab();
    initDocumentsTab();
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setFooterYear() {
    document.querySelectorAll('#footer-year').forEach(function (n) {
      n.textContent = new Date().getFullYear();
    });
  }

  function renderSessionBanner() {
    var mount = document.getElementById('session-banner');
    if (!mount) return;
    var session = Auth.getSession();
    if (!session) return;
    mount.innerHTML = '';
    mount.appendChild(document.createTextNode('Logged in as '));
    mount.appendChild(el('strong', null, session.name));
    mount.appendChild(document.createTextNode(' '));
    mount.appendChild(el('span', 'badge', session.role));
  }

  function initTabs() {
    var tabs = document.querySelectorAll('[data-tab-target]');
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

  function setStatus(node, state, message) {
    if (!node) return;
    node.textContent = message;
    if (state) node.setAttribute('data-state', state); else node.removeAttribute('data-state');
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  // A single form submit can produce several rows (one per catalog item
  // ordered, plus one per free-text "unlisted" item on the local order
  // form) — without this they read as disconnected entries that happen to
  // share a timestamp. Tags each entry with a short, stable badge so rows
  // from the same submit are visibly grouped no matter how the table is
  // currently sorted or searched. Uses the real submissionId when present
  // (current backend); falls back to matching submittedAt+employeeName+date
  // for rows written before that column existed.
  function assignSubmissionBadges(entries) {
    var seen = new Map();
    var counter = 0;
    entries.forEach(function (entry) {
      var key = entry.submissionId || (entry.submittedAt + '|' + entry.employeeName + '|' + entry.date);
      if (!seen.has(key)) { counter++; seen.set(key, counter); }
      entry._submissionBadge = '#' + seen.get(key);
    });
  }

  // A line item's details JSON is {removed:true} once it's been dropped by
  // a same-day recall/edit (see getMyEntries/updateMyEntries in Code.gs) —
  // the underlying sheet row is kept for audit but has nothing to show here.
  function isRemovedEntry(entry) {
    try {
      var parsed = JSON.parse(entry.details);
      return !!parsed && parsed.removed === true;
    } catch (e) { return false; }
  }

  // =========================================================================
  // Confirmation modal — replaces window.confirm() for destructive actions.
  // Returns a Promise<boolean>; resolves false on Cancel, backdrop click, or Esc.
  // =========================================================================
  function confirmAction(message) {
    return new Promise(function (resolve) {
      var overlay = el('div', 'modal-overlay');
      var card = el('div', 'modal-card');
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      card.appendChild(el('p', 'modal-message', message));

      var actions = el('div', 'modal-actions');
      var cancelBtn = el('button', 'btn-remove-row', 'Cancel'); cancelBtn.type = 'button';
      var confirmBtn = el('button', 'btn btn-primary', 'Confirm'); confirmBtn.type = 'button';
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      confirmBtn.focus();

      function done(result) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') done(false); }

      cancelBtn.addEventListener('click', function () { done(false); });
      confirmBtn.addEventListener('click', function () { done(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey);
    });
  }

  // Every table row's cells get a data-label matching their column header,
  // so the mobile card-collapse CSS (styles.css) can show "Label: value"
  // when the table stops being a table below ~640px.
  function applyDataLabels(row, headerLabels) {
    Array.from(row.children).forEach(function (cell, i) {
      if (headerLabels[i]) cell.setAttribute('data-label', headerLabels[i]);
    });
  }

  function downloadCsv(filename, headers, rows) {
    function esc(v) {
      var s = v === undefined || v === null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [headers.map(esc).join(',')].concat(rows.map(function (r) { return r.map(esc).join(','); }));
    var blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = el('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // =========================================================================
  // Reusable table: client-side search + column sort + optional CSV export.
  // All admin tables fetch their full working set in one call already, so
  // sorting/filtering is done in memory against the last-fetched array —
  // no extra API calls. `columns[i].key` drives sort; omit it for
  // non-sortable columns (Details, Actions, the multiselect column).
  // `columns[i].render(visibleItems)` overrides the default <th> for that
  // column (used by Catalog's "select all" checkbox header).
  // =========================================================================
  function attachTableControls(opts) {
    opts.mount.innerHTML = '';

    var controlsRow = el('div', 'table-controls');
    var searchInput = el('input', 'table-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = opts.searchPlaceholder || 'Search…';
    controlsRow.appendChild(searchInput);

    if (opts.csv) {
      var exportBtn = el('button', 'btn-outline btn-export-csv', 'Export CSV');
      exportBtn.type = 'button';
      exportBtn.addEventListener('click', function () {
        // csv.row normally returns one CSV row per item. Submissions'
        // csv.row returns an array of rows instead (one per line item
        // inside that submission) — flatten one level either way.
        var rows = [];
        lastFiltered.map(opts.csv.row).forEach(function (r) {
          if (Array.isArray(r[0])) rows = rows.concat(r); else rows.push(r);
        });
        downloadCsv(opts.csv.filename, opts.csv.headers, rows);
      });
      controlsRow.appendChild(exportBtn);
    }
    opts.mount.appendChild(controlsRow);

    if (opts.extraControls) opts.mount.appendChild(opts.extraControls);

    var tableMount = el('div');
    opts.mount.appendChild(tableMount);

    var allRows = [];
    var lastFiltered = [];
    var sortKey = opts.defaultSortKey || null;
    var sortDir = 1;

    function render() {
      var query = searchInput.value.trim().toLowerCase();
      var filtered = query ? allRows.filter(function (item) { return opts.searchPredicate(item, query); }) : allRows.slice();
      if (sortKey) {
        filtered.sort(function (a, b) {
          var av = a[sortKey], bv = b[sortKey];
          av = av === undefined || av === null ? '' : av;
          bv = bv === undefined || bv === null ? '' : bv;
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sortDir;
          return String(av).localeCompare(String(bv)) * sortDir;
        });
      }
      lastFiltered = filtered;

      tableMount.innerHTML = '';
      if (!filtered.length) { tableMount.textContent = opts.emptyMessage || 'Nothing to show.'; return; }

      var scroll = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      var headerLabels = opts.columns.map(function (c) { return c.label; });

      opts.columns.forEach(function (col) {
        var th;
        if (col.render) {
          th = col.render(filtered);
        } else {
          th = el('th', null, col.label);
          if (col.key) {
            th.classList.add('is-sortable');
            if (sortKey === col.key) th.classList.add(sortDir === 1 ? 'is-sorted-asc' : 'is-sorted-desc');
            th.addEventListener('click', function () {
              if (sortKey === col.key) sortDir = -sortDir; else { sortKey = col.key; sortDir = 1; }
              render();
            });
          }
        }
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      filtered.forEach(function (item) {
        // buildRow normally returns one <tr>. A row that expands into
        // child content (Submissions' per-item detail) returns an array
        // instead — only the first (the always-visible summary row) gets
        // the mobile data-label treatment; an expanded detail row carries
        // its own inner table with its own headers.
        var built = opts.buildRow(item);
        var rows = Array.isArray(built) ? built : [built];
        rows.forEach(function (row, i) {
          if (i === 0) applyDataLabels(row, headerLabels);
          tbody.appendChild(row);
        });
      });
      table.appendChild(tbody);
      scroll.appendChild(table);
      tableMount.appendChild(scroll);
    }

    searchInput.addEventListener('input', render);

    return {
      setData: function (rows) { allRows = rows; render(); },
      render: render,
      reset: function () { searchInput.value = ''; sortKey = opts.defaultSortKey || null; sortDir = 1; render(); }
    };
  }

  // =========================================================================
  // Submissions — select a submission to expand it into its line items.
  // Keeps the table one row per submission instead of one row per product,
  // and gives each form type its own real Details columns instead of a
  // single JSON-blob column.
  // =========================================================================
  var LINE_ITEM_COLUMNS = {
    'inventory': ['Item', 'Category', 'Qty on Hand', 'Notes', 'Last Edited', 'Actions'],
    'dessert-daily': ['Item', 'Count on Hand', 'New Delivery', 'Last Edited', 'Actions'],
    'dessert-order': ['Item', 'Vendor', 'New Mon', 'New Fri', 'Last Edited', 'Actions'],
    'local-order': ['Item', 'Unit', 'Order Below', 'Have / Qty Needed', 'Order?', 'Last Edited', 'Actions']
  };

  function initSubmissionsTab() {
    var select = document.getElementById('submissions-form-type');
    var mount = document.getElementById('submissions-table');
    var expanded = new Set(); // submission keys currently expanded, survives re-render

    var controls = attachTableControls({
      mount: mount,
      searchPlaceholder: 'Search by employee or product…',
      emptyMessage: 'No submissions yet for this form.',
      columns: [
        { label: '' },
        { label: 'Submission' },
        { label: 'Submitted', key: 'submittedAt' },
        { label: 'Employee', key: 'employeeName' },
        { label: 'Date', key: 'date' },
        { label: 'Items', key: 'itemCount' },
        { label: 'Last Edited' }
      ],
      searchPredicate: function (group, q) {
        if ((group.employeeName || '').toLowerCase().indexOf(q) !== -1) return true;
        return group.entries.some(function (e) { return (e.product || '').toLowerCase().indexOf(q) !== -1; });
      },
      buildRow: function (group) {
        return buildSubmissionGroupRow(group, select.value, expanded, function () { loadSubmissions(select.value, controls, expanded); });
      },
      csv: {
        filename: 'submissions.csv',
        headers: ['Submission', 'Submitted', 'Employee', 'Date', 'Product', 'Details', 'Last Edited By', 'Last Edited At'],
        row: function (group) {
          return group.entries.map(function (e) {
            return [group.badge || '', formatDateTime(e.submittedAt), e.employeeName, e.date, e.product, e.details, e.lastEditedBy, formatDateTime(e.lastEditedAt)];
          });
        }
      }
    });

    select.addEventListener('change', function () {
      expanded.clear();
      controls.reset();
      loadSubmissions(select.value, controls, expanded);
    });
    loadSubmissions(select.value, controls, expanded);
  }

  function loadSubmissions(formType, controls, expanded) {
    Auth.apiCall('getEntries', { formType: formType, limit: 200 }).then(function (result) {
      if (!result.ok) { controls.setData([]); return; }
      assignSubmissionBadges(result.entries);
      controls.setData(groupSubmissions(result.entries));
    });
  }

  // Collapses the flat entries array into one row per submission (same
  // grouping key as assignSubmissionBadges), dropping any line item an
  // edit later removed and any submission left with nothing to show.
  function groupSubmissions(entries) {
    var byKey = new Map();
    var order = [];
    entries.forEach(function (entry) {
      var key = entry.submissionId || (entry.submittedAt + '|' + entry.employeeName + '|' + entry.date);
      var group = byKey.get(key);
      if (!group) {
        group = { key: key, badge: entry._submissionBadge, submittedAt: entry.submittedAt, employeeName: entry.employeeName, date: entry.date, entries: [] };
        byKey.set(key, group);
        order.push(group);
      }
      if (!isRemovedEntry(entry)) group.entries.push(entry);
    });

    order.forEach(function (group) {
      group.itemCount = group.entries.length;
      var edited = group.entries.filter(function (e) { return e.lastEditedAt; })
        .sort(function (a, b) { return new Date(b.lastEditedAt) - new Date(a.lastEditedAt); });
      group.lastEditedBy = edited.length ? edited[0].lastEditedBy : '';
      group.lastEditedAt = edited.length ? edited[0].lastEditedAt : '';
    });

    return order.filter(function (group) { return group.entries.length > 0; });
  }

  function buildSubmissionGroupRow(group, formType, expanded, refresh) {
    var isOpen = expanded.has(group.key);

    var row = el('tr', 'submission-row');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

    var toggleCell = el('td');
    toggleCell.appendChild(el('span', 'submission-row__toggle', isOpen ? '−' : '+'));
    row.appendChild(toggleCell);

    row.appendChild(el('td', 'count-table__unit', group.badge || ''));
    row.appendChild(el('td', 'count-table__unit', formatDateTime(group.submittedAt)));
    row.appendChild(el('td', null, group.employeeName));
    row.appendChild(el('td', null, group.date));
    row.appendChild(el('td', 'count-table__unit', group.itemCount + (group.itemCount === 1 ? ' item' : ' items')));
    row.appendChild(el('td', 'count-table__unit', group.lastEditedBy
      ? group.lastEditedBy + ' — ' + formatDateTime(group.lastEditedAt)
      : 'Not edited yet'));

    function toggle() {
      if (expanded.has(group.key)) expanded.delete(group.key); else expanded.add(group.key);
      refresh();
    }
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    if (!isOpen) return row;

    var detailRow = el('tr');
    var detailCell = el('td', 'submission-detail-cell');
    detailCell.colSpan = 7;
    detailCell.appendChild(buildLineItemsTable(group, formType, refresh));
    detailRow.appendChild(detailCell);

    return [row, detailRow];
  }

  function buildLineItemsTable(group, formType, refresh) {
    var wrap = el('div', 'table-scroll');
    var table = el('table', 'count-table');
    var thead = el('thead');
    var headRow = el('tr');
    var headers = LINE_ITEM_COLUMNS[formType] || LINE_ITEM_COLUMNS['inventory'];
    headers.forEach(function (label) { headRow.appendChild(el('th', null, label)); });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    group.entries.forEach(function (entry) {
      var lineRow = buildLineItemRow(entry, formType, refresh);
      applyDataLabels(lineRow, headers);
      tbody.appendChild(lineRow);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // Coerces a saved field back to a number when it looks like one — details
  // JSON stores quantities as numbers, and saving a bare string there would
  // silently change the value's type on every future read of this row.
  function coerceValue(raw) {
    if (raw === '') return raw;
    var num = Number(raw);
    return isNaN(num) ? raw : num;
  }

  // One line item within an expanded submission — real per-field columns
  // matching that form's shape (see LINE_ITEM_COLUMNS), with the number
  // that was actually entered visually emphasized via .count-table__qty-value.
  // Edit unlocks every field shown; Save reconstructs the details JSON from
  // just those fields, preserving any key this view doesn't surface.
  function buildLineItemRow(entry, formType, refresh) {
    var parsed;
    try { parsed = JSON.parse(entry.details); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') parsed = {};

    var row = el('tr');
    var editableInputs = [];

    var itemInput = el('input'); itemInput.type = 'text'; itemInput.value = entry.product; itemInput.readOnly = true;
    var itemCell = el('th', 'count-table__item'); itemCell.appendChild(itemInput); row.appendChild(itemCell);
    editableInputs.push(itemInput);

    var fields = []; // { input, key } — read back into details JSON on Save
    function addField(key, value, emphasize) {
      var input = el('input');
      input.type = 'text';
      input.value = value === undefined || value === null ? '' : String(value);
      input.readOnly = true;
      if (emphasize) input.classList.add('count-table__qty-value');
      var cell = el('td'); cell.appendChild(input); row.appendChild(cell);
      fields.push({ input: input, key: key });
      editableInputs.push(input);
    }
    function addStaticCell(text) {
      row.appendChild(el('td', 'count-table__unit', text));
    }

    var isUnlisted = formType === 'local-order' && 'qty' in parsed && 'name' in parsed && !('currentStock' in parsed);

    if (formType === 'inventory') {
      addField('category', parsed.category, false);
      addField('qtyOnHand', parsed.qtyOnHand, true);
      addField('notes', parsed.notes, false);
    } else if (formType === 'dessert-daily') {
      addField('countOnHand', parsed.countOnHand, true);
      addField('deliveryReceived', parsed.deliveryReceived, true);
    } else if (formType === 'dessert-order') {
      addField('vendor', parsed.vendor, false);
      addField('newMon', parsed.newMon, true);
      addField('newFri', parsed.newFri, true);
    } else if (formType === 'local-order' && isUnlisted) {
      addStaticCell('Not on list');
      addStaticCell('—');
      addField('qty', parsed.qty, true);
      addStaticCell('—');
    } else if (formType === 'local-order') {
      addField('unit', parsed.unit, false);
      addField('threshold', parsed.threshold, false);
      addField('currentStock', parsed.currentStock, true);
      addField('order', parsed.order, false);
    } else {
      addField('_raw', entry.details, false);
    }

    row.appendChild(el('td', 'count-table__unit', entry.lastEditedBy
      ? entry.lastEditedBy + ' — ' + formatDateTime(entry.lastEditedAt)
      : 'Not edited yet'));

    var actionCell = el('td', 'count-table__actions');
    var editBtn = el('button', 'btn-inline-action', 'Edit');
    editBtn.type = 'button';
    var saveBtn = el('button', 'btn-inline-action', 'Save');
    saveBtn.type = 'button';
    saveBtn.hidden = true;

    editBtn.addEventListener('click', function () {
      editableInputs.forEach(function (input) { input.readOnly = false; });
      editBtn.hidden = true;
      saveBtn.hidden = false;
      itemInput.focus();
    });

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      var newDetails = Object.assign({}, parsed);
      fields.forEach(function (f) { newDetails[f.key] = coerceValue(f.input.value); });

      Auth.apiCall('updateEntry', {
        formType: formType,
        entryId: entry.entryId,
        changes: { product: itemInput.value, details: JSON.stringify(newDetails) }
      }).then(function (result) {
        if (result.ok) refresh();
        else saveBtn.disabled = false;
      });
    });

    actionCell.appendChild(editBtn);
    actionCell.appendChild(saveBtn);
    row.appendChild(actionCell);

    return row;
  }

  // =========================================================================
  // Catalog — every item across the three catalog-backed forms: search/sort,
  // multiselect bulk discontinue/restore, and inline edit of name/unit/group.
  // =========================================================================
  function initCatalogTab() {
    var select = document.getElementById('catalog-form-type');
    var mount = document.getElementById('catalog-table');
    var selected = new Set();
    var controls;

    var toolbar = el('div', 'table-bulk-toolbar');
    toolbar.hidden = true;
    var toolbarLabel = el('span', 'table-bulk-toolbar__label', '');
    var discBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Discontinue selected');
    discBtn.type = 'button';
    var restoreBtn = el('button', 'btn-inline-action', 'Restore selected');
    restoreBtn.type = 'button';
    toolbar.appendChild(toolbarLabel);
    toolbar.appendChild(discBtn);
    toolbar.appendChild(restoreBtn);

    function updateToolbar() {
      toolbar.hidden = selected.size === 0;
      toolbarLabel.textContent = selected.size + ' selected';
    }

    function bulkApply(action, verb) {
      var ids = Array.from(selected);
      if (!ids.length) return;
      confirmAction(verb + ' ' + ids.length + ' item' + (ids.length === 1 ? '' : 's') + '? This applies immediately.').then(function (ok) {
        if (!ok) return;
        discBtn.disabled = true; restoreBtn.disabled = true;
        Auth.apiCall(action, { catalogIds: ids }).then(function () {
          discBtn.disabled = false; restoreBtn.disabled = false;
          selected.clear();
          loadCatalog(select.value, controls, selected, updateToolbar);
        });
      });
    }
    discBtn.addEventListener('click', function () { bulkApply('discontinueItem', 'Discontinue'); });
    restoreBtn.addEventListener('click', function () { bulkApply('restoreItem', 'Restore'); });

    controls = attachTableControls({
      mount: mount,
      searchPlaceholder: 'Search by item or group…',
      emptyMessage: 'No items in this list yet.',
      extraControls: toolbar,
      columns: [
        {
          label: 'Select',
          render: function (visible) {
            var th = el('th');
            if (!visible.length) return th;
            var checkbox = el('input');
            checkbox.type = 'checkbox';
            checkbox.checked = visible.every(function (i) { return selected.has(i.catalogId); });
            checkbox.setAttribute('aria-label', 'Select all visible items');
            checkbox.addEventListener('change', function () {
              visible.forEach(function (i) { checkbox.checked ? selected.add(i.catalogId) : selected.delete(i.catalogId); });
              updateToolbar();
              controls.render();
            });
            th.appendChild(checkbox);
            return th;
          }
        },
        { label: 'Item', key: 'name' },
        { label: 'Group', key: 'group' },
        { label: 'Unit', key: 'unit' },
        { label: 'Status', key: 'status' },
        { label: 'Added By', key: 'addedBy' },
        { label: 'Actions' }
      ],
      searchPredicate: function (item, q) {
        return (item.name || '').toLowerCase().indexOf(q) !== -1 ||
          (item.group || '').toLowerCase().indexOf(q) !== -1;
      },
      buildRow: function (item) {
        return buildCatalogRow(item, {
          selected: selected,
          onSelectionChange: function () { updateToolbar(); },
          refresh: function () { loadCatalog(select.value, controls, selected, updateToolbar); }
        });
      },
      csv: {
        filename: 'catalog.csv',
        headers: ['Item', 'Group', 'Unit', 'Status', 'Added By'],
        row: function (i) { return [i.name, i.group, i.unit, i.status, i.addedBy]; }
      }
    });

    select.addEventListener('change', function () {
      selected.clear();
      updateToolbar();
      controls.reset();
      loadCatalog(select.value, controls, selected, updateToolbar);
    });
    loadCatalog(select.value, controls, selected, updateToolbar);
  }

  function loadCatalog(formType, controls, selected, updateToolbar) {
    Auth.apiCall('getCatalog', { formType: formType, includeAll: true }).then(function (result) {
      if (!result.ok) { controls.setData([]); return; }
      controls.setData(result.items);
      if (updateToolbar) updateToolbar();
    });
  }

  function buildCatalogRow(item, ctx) {
    var row = el('tr');
    if (item.status === 'flagged') row.classList.add('below-threshold');
    if (item.status === 'discontinued') row.classList.add('is-discontinued');

    var checkCell = el('td');
    var checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = ctx.selected.has(item.catalogId);
    checkbox.setAttribute('aria-label', 'Select ' + item.name);
    checkbox.addEventListener('change', function () {
      checkbox.checked ? ctx.selected.add(item.catalogId) : ctx.selected.delete(item.catalogId);
      ctx.onSelectionChange();
    });
    checkCell.appendChild(checkbox);
    row.appendChild(checkCell);

    var nameInput = el('input'); nameInput.type = 'text'; nameInput.value = item.name; nameInput.readOnly = true;
    var nameCell = el('th', 'count-table__item'); nameCell.appendChild(nameInput); row.appendChild(nameCell);

    var groupInput = el('input'); groupInput.type = 'text'; groupInput.value = item.group || ''; groupInput.readOnly = true;
    var groupCell = el('td'); groupCell.appendChild(groupInput); row.appendChild(groupCell);

    var unitInput = el('input'); unitInput.type = 'text'; unitInput.value = item.unit || ''; unitInput.readOnly = true;
    var unitCell = el('td'); unitCell.appendChild(unitInput); row.appendChild(unitCell);

    row.appendChild(el('td', null, item.status));
    row.appendChild(el('td', 'count-table__unit', item.addedBy));

    var actionCell = el('td', 'count-table__actions');

    var editBtn = el('button', 'btn-inline-action', 'Edit');
    editBtn.type = 'button';
    var saveBtn = el('button', 'btn-inline-action', 'Save');
    saveBtn.type = 'button';
    saveBtn.hidden = true;
    var editError = el('span', 'inline-error', '');

    editBtn.addEventListener('click', function () {
      nameInput.readOnly = false;
      groupInput.readOnly = false;
      unitInput.readOnly = false;
      editBtn.hidden = true;
      saveBtn.hidden = false;
      nameInput.focus();
    });

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      editError.textContent = '';
      Auth.apiCall('updateItem', {
        catalogId: item.catalogId,
        changes: { name: nameInput.value.trim(), group: groupInput.value.trim(), unit: unitInput.value.trim() }
      }).then(function (result) {
        if (result.ok) { ctx.refresh(); return; }
        saveBtn.disabled = false;
        editError.textContent = result.error === 'duplicate_name' ? 'Another item already has that name.' : 'Could not save.';
      });
    });

    actionCell.appendChild(editBtn);
    actionCell.appendChild(saveBtn);
    actionCell.appendChild(editError);

    if (item.status === 'discontinued') {
      var restoreBtn = el('button', 'btn-inline-action', 'Restore');
      restoreBtn.type = 'button';
      restoreBtn.addEventListener('click', function () {
        restoreBtn.disabled = true;
        Auth.apiCall('restoreItem', { catalogId: item.catalogId }).then(function (r) {
          if (r.ok) ctx.refresh(); else restoreBtn.disabled = false;
        });
      });
      actionCell.appendChild(restoreBtn);
    } else {
      var discBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Discontinue');
      discBtn.type = 'button';
      discBtn.addEventListener('click', function () {
        confirmAction('Discontinue "' + item.name + '"? It disappears from the active form immediately.').then(function (ok) {
          if (!ok) return;
          discBtn.disabled = true;
          Auth.apiCall('discontinueItem', { catalogId: item.catalogId }).then(function (r) {
            if (r.ok) ctx.refresh(); else discBtn.disabled = false;
          });
        });
      });
      actionCell.appendChild(discBtn);
    }
    row.appendChild(actionCell);

    return row;
  }

  // =========================================================================
  // Users — list + add + remove (soft-delete) + reset password
  // =========================================================================
  function initUsersTab() {
    var mount = document.getElementById('users-table');
    var controls = attachTableControls({
      mount: mount,
      searchPlaceholder: 'Search by username or name…',
      emptyMessage: 'No users yet.',
      columns: [
        { label: 'Username', key: 'username' },
        { label: 'Name', key: 'name' },
        { label: 'Role', key: 'role' },
        { label: 'Status', key: 'statusLabel' },
        { label: 'Actions' }
      ],
      searchPredicate: function (user, q) {
        return (user.username || '').toLowerCase().indexOf(q) !== -1 ||
          (user.name || '').toLowerCase().indexOf(q) !== -1;
      },
      buildRow: function (user) { return buildUserRow(user, function () { loadUsers(controls); }); }
    });
    loadUsers(controls);

    var form = document.getElementById('add-user-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var status = form.querySelector('[data-form-status]');

      var newUser = {
        username: form.username.value.trim(),
        name: form.name.value.trim(),
        role: form.role.value,
        password: form.password.value
      };
      if (!newUser.username || !newUser.password) {
        setStatus(status, 'error', 'Username and password are required.');
        return;
      }

      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      Auth.apiCall('addUser', { newUser: newUser }).then(function (result) {
        btn.disabled = false;
        if (result.ok) {
          setStatus(status, 'success', 'User added.');
          form.reset();
          loadUsers(controls);
        } else {
          setStatus(status, 'error', result.error === 'username_taken' ? 'That username is already taken.' : 'Could not add that user.');
        }
      });
    });
  }

  function loadUsers(controls) {
    Auth.apiCall('getUsers', {}).then(function (result) {
      if (!result.ok) { controls.setData([]); return; }
      controls.setData(result.users.map(function (u) {
        return Object.assign({}, u, { statusLabel: u.active ? 'Active' : 'Removed' });
      }));
    });
  }

  function buildUserRow(user, refresh) {
    var session = Auth.getSession();
    var row = el('tr');
    row.appendChild(el('th', 'count-table__item', user.username));
    row.appendChild(el('td', null, user.name));
    row.appendChild(el('td', null, user.role));
    row.appendChild(el('td', null, user.statusLabel));

    var actionCell = el('td', 'count-table__actions');
    var isSelf = !!session && user.username.toLowerCase() === session.username.toLowerCase();

    if (user.active) {
      var resetBtn = el('button', 'btn-inline-action', 'Reset password');
      resetBtn.type = 'button';
      resetBtn.addEventListener('click', function () {
        var newPassword = window.prompt('New temporary password for "' + user.username + '":');
        if (!newPassword) return;
        resetBtn.disabled = true;
        Auth.apiCall('resetPassword', { username: user.username, newPassword: newPassword }).then(function (result) {
          resetBtn.disabled = false;
          window.alert(result.ok ? 'Password reset. Share the new temporary password with them directly.' : 'Could not reset that password.');
        });
      });
      actionCell.appendChild(resetBtn);
    }

    if (user.active && !isSelf) {
      var removeBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Remove');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', function () {
        confirmAction('Remove portal access for "' + user.username + '"?').then(function (ok) {
          if (!ok) return;
          removeBtn.disabled = true;
          Auth.apiCall('removeUser', { username: user.username }).then(function (result) {
            if (result.ok) {
              refresh();
            } else {
              removeBtn.disabled = false;
              window.alert(result.error === 'cannot_remove_last_management'
                ? 'Can’t remove the last active Management account.'
                : 'Could not remove that user.');
            }
          });
        });
      });
      actionCell.appendChild(removeBtn);
    }
    row.appendChild(actionCell);

    return row;
  }

  // =========================================================================
  // Changelog — read-only audit trail of every mutating admin action
  // =========================================================================
  function initChangelogTab() {
    var mount = document.getElementById('changelog-table');
    if (!mount) return;

    function load() {
      Auth.apiCall('getChangelog', { limit: 500 }).then(function (result) {
        if (!result.ok) { controls.setData([]); return; }
        controls.setData(result.entries);
      });
    }

    var controls = attachTableControls({
      mount: mount,
      searchPlaceholder: 'Search by user or action…',
      emptyMessage: 'No changes logged yet.',
      defaultSortKey: 'timestamp',
      columns: [
        { label: 'Time', key: 'timestamp' },
        { label: 'User', key: 'username' },
        { label: 'Role', key: 'role' },
        { label: 'Action', key: 'action' },
        { label: 'Target', key: 'target' },
        { label: 'Details' }
      ],
      searchPredicate: function (entry, q) {
        return (entry.username || '').toLowerCase().indexOf(q) !== -1 ||
          (entry.action || '').toLowerCase().indexOf(q) !== -1;
      },
      buildRow: buildChangelogRow,
      csv: {
        filename: 'changelog.csv',
        headers: ['Time', 'User', 'Role', 'Action', 'Target', 'Details'],
        row: function (e) { return [formatDateTime(e.timestamp), e.username, e.role, e.action, e.target, e.details]; }
      }
    });

    // Refetch every time this tab is opened, not just once at page load —
    // otherwise it shows whatever was true when the page first loaded,
    // which is stale the moment any other tab makes a change.
    var tabBtn = document.querySelector('[data-tab-target="tab-changelog"]');
    if (tabBtn) tabBtn.addEventListener('click', load);
    load();
  }

  function buildChangelogRow(entry) {
    var row = el('tr');
    row.appendChild(el('td', 'count-table__unit', formatDateTime(entry.timestamp)));
    row.appendChild(el('th', 'count-table__item', entry.username));
    row.appendChild(el('td', null, entry.role));
    row.appendChild(el('td', null, entry.action));
    row.appendChild(el('td', 'count-table__unit', entry.target));
    row.appendChild(el('td', null, entry.details));
    return row;
  }

  // =========================================================================
  // Documents — add/edit/discontinue/restore the docs shown on /team/documents.
  // Same CRUD shape as Catalog: soft-delete via status, no hard removal.
  // =========================================================================
  function initDocumentsTab() {
    var mount = document.getElementById('documents-table');
    if (!mount) return;

    var controls = attachTableControls({
      mount: mount,
      searchPlaceholder: 'Search by title or category…',
      emptyMessage: 'No documents added yet.',
      columns: [
        { label: 'Title', key: 'title' },
        { label: 'Category', key: 'category' },
        { label: 'Description', key: 'description' },
        { label: 'Status', key: 'status' },
        { label: 'Added By', key: 'addedBy' },
        { label: 'Actions' }
      ],
      searchPredicate: function (doc, q) {
        return (doc.title || '').toLowerCase().indexOf(q) !== -1 ||
          (doc.category || '').toLowerCase().indexOf(q) !== -1;
      },
      buildRow: function (doc) { return buildDocumentRow(doc, function () { loadDocuments(controls); }); },
      csv: {
        filename: 'documents.csv',
        headers: ['Title', 'Category', 'Description', 'Status', 'Added By'],
        row: function (d) { return [d.title, d.category, d.description, d.status, d.addedBy]; }
      }
    });
    loadDocuments(controls);

    var form = document.getElementById('add-document-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var status = form.querySelector('[data-form-status]');

      var document_ = {
        title: form.title.value.trim(),
        category: form.category.value.trim(),
        description: form.description.value.trim(),
        driveFileId: form.driveFileId.value.trim()
      };
      if (!document_.title) {
        setStatus(status, 'error', 'Title is required.');
        return;
      }

      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      Auth.apiCall('addDocument', { document: document_ }).then(function (result) {
        btn.disabled = false;
        if (result.ok) {
          setStatus(status, 'success', 'Document added.');
          form.reset();
          loadDocuments(controls);
        } else {
          setStatus(status, 'error', 'Could not add that document.');
        }
      });
    });
  }

  function loadDocuments(controls) {
    Auth.apiCall('getDocuments', { includeAll: true }).then(function (result) {
      if (!result.ok) { controls.setData([]); return; }
      controls.setData(result.documents);
    });
  }

  function buildDocumentRow(doc, refresh) {
    var row = el('tr');
    if (doc.status === 'discontinued') row.classList.add('is-discontinued');

    var titleInput = el('input'); titleInput.type = 'text'; titleInput.value = doc.title; titleInput.readOnly = true;
    var titleCell = el('th', 'count-table__item'); titleCell.appendChild(titleInput); row.appendChild(titleCell);

    var categoryInput = el('input'); categoryInput.type = 'text'; categoryInput.value = doc.category || ''; categoryInput.readOnly = true;
    var categoryCell = el('td'); categoryCell.appendChild(categoryInput); row.appendChild(categoryCell);

    var descInput = el('input'); descInput.type = 'text'; descInput.value = doc.description || ''; descInput.readOnly = true;
    var descCell = el('td'); descCell.appendChild(descInput); row.appendChild(descCell);

    row.appendChild(el('td', null, doc.status));
    row.appendChild(el('td', 'count-table__unit', doc.addedBy));

    var actionCell = el('td', 'count-table__actions');

    var editBtn = el('button', 'btn-inline-action', 'Edit');
    editBtn.type = 'button';
    var saveBtn = el('button', 'btn-inline-action', 'Save');
    saveBtn.type = 'button';
    saveBtn.hidden = true;

    editBtn.addEventListener('click', function () {
      titleInput.readOnly = false;
      categoryInput.readOnly = false;
      descInput.readOnly = false;
      editBtn.hidden = true;
      saveBtn.hidden = false;
      titleInput.focus();
    });

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      Auth.apiCall('updateDocument', {
        documentId: doc.documentId,
        changes: { title: titleInput.value.trim(), category: categoryInput.value.trim(), description: descInput.value.trim() }
      }).then(function (result) {
        if (result.ok) refresh();
        else saveBtn.disabled = false;
      });
    });

    actionCell.appendChild(editBtn);
    actionCell.appendChild(saveBtn);

    if (doc.status === 'discontinued') {
      var restoreBtn = el('button', 'btn-inline-action', 'Restore');
      restoreBtn.type = 'button';
      restoreBtn.addEventListener('click', function () {
        restoreBtn.disabled = true;
        Auth.apiCall('restoreDocument', { documentId: doc.documentId }).then(function (r) {
          if (r.ok) refresh(); else restoreBtn.disabled = false;
        });
      });
      actionCell.appendChild(restoreBtn);
    } else {
      var discBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Remove');
      discBtn.type = 'button';
      discBtn.addEventListener('click', function () {
        confirmAction('Remove "' + doc.title + '" from the Documents page?').then(function (ok) {
          if (!ok) return;
          discBtn.disabled = true;
          Auth.apiCall('discontinueDocument', { documentId: doc.documentId }).then(function (r) {
            if (r.ok) refresh(); else discBtn.disabled = false;
          });
        });
      });
      actionCell.appendChild(discBtn);
    }
    row.appendChild(actionCell);

    return row;
  }
})();

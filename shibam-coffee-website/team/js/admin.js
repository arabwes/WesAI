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
        downloadCsv(opts.csv.filename, opts.csv.headers, lastFiltered.map(opts.csv.row));
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
        var row = opts.buildRow(item);
        applyDataLabels(row, headerLabels);
        tbody.appendChild(row);
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
  // Submissions — view + inline edit any field on a past entry
  // =========================================================================
  function initSubmissionsTab() {
    var select = document.getElementById('submissions-form-type');
    var mount = document.getElementById('submissions-table');

    var controls = attachTableControls({
      mount: mount,
      searchPlaceholder: 'Search by employee or product…',
      emptyMessage: 'No submissions yet for this form.',
      columns: [
        { label: 'Submitted', key: 'submittedAt' },
        { label: 'Employee', key: 'employeeName' },
        { label: 'Date', key: 'date' },
        { label: 'Product', key: 'product' },
        { label: 'Details' },
        { label: 'Last Edited', key: 'lastEditedAt' },
        { label: 'Actions' }
      ],
      searchPredicate: function (entry, q) {
        return (entry.employeeName || '').toLowerCase().indexOf(q) !== -1 ||
          (entry.product || '').toLowerCase().indexOf(q) !== -1;
      },
      buildRow: function (entry) { return buildSubmissionRow(entry, select.value, function () { loadSubmissions(select.value, controls); }); },
      csv: {
        filename: 'submissions.csv',
        headers: ['Submitted', 'Employee', 'Date', 'Product', 'Details', 'Last Edited By', 'Last Edited At'],
        row: function (e) { return [formatDateTime(e.submittedAt), e.employeeName, e.date, e.product, e.details, e.lastEditedBy, formatDateTime(e.lastEditedAt)]; }
      }
    });

    select.addEventListener('change', function () { controls.reset(); loadSubmissions(select.value, controls); });
    loadSubmissions(select.value, controls);
  }

  function loadSubmissions(formType, controls) {
    Auth.apiCall('getEntries', { formType: formType, limit: 200 }).then(function (result) {
      if (!result.ok) { controls.setData([]); return; }
      controls.setData(result.entries);
    });
  }

  function buildSubmissionRow(entry, formType, refresh) {
    var row = el('tr');
    row.appendChild(el('td', 'count-table__unit', formatDateTime(entry.submittedAt)));
    row.appendChild(el('td', null, entry.employeeName));

    var dateInput = el('input'); dateInput.type = 'text'; dateInput.value = entry.date; dateInput.readOnly = true;
    var dateCell = el('td'); dateCell.appendChild(dateInput); row.appendChild(dateCell);

    var productInput = el('input'); productInput.type = 'text'; productInput.value = entry.product; productInput.readOnly = true;
    var productCell = el('td'); productCell.appendChild(productInput); row.appendChild(productCell);

    var detailsInput = el('textarea'); detailsInput.value = entry.details; detailsInput.readOnly = true; detailsInput.rows = 2;
    var detailsCell = el('td'); detailsCell.appendChild(detailsInput); row.appendChild(detailsCell);

    row.appendChild(el('td', 'count-table__unit', entry.lastEditedBy
      ? entry.lastEditedBy + ' — ' + formatDateTime(entry.lastEditedAt)
      : '—'));

    var actionCell = el('td');
    var editBtn = el('button', 'btn-inline-action', 'Edit');
    editBtn.type = 'button';
    var saveBtn = el('button', 'btn-inline-action', 'Save');
    saveBtn.type = 'button';
    saveBtn.hidden = true;

    editBtn.addEventListener('click', function () {
      dateInput.readOnly = false;
      productInput.readOnly = false;
      detailsInput.readOnly = false;
      editBtn.hidden = true;
      saveBtn.hidden = false;
      productInput.focus();
    });

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      Auth.apiCall('updateEntry', {
        formType: formType,
        entryId: entry.entryId,
        changes: { date: dateInput.value, product: productInput.value, details: detailsInput.value }
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
})();

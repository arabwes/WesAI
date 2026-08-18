// /team/js/admin.js
// Shibam Coffee Atlanta — Management admin dashboard (submissions, catalog,
// users). Loaded after config.js and auth.js. This page is gated by
// data-require-role="management" in auth.js — nothing here re-checks that,
// same trust boundary as everywhere else: the backend enforces it too.

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    setFooterYear();
    renderSessionBanner();
    initTabs();
    initSubmissionsTab();
    initCatalogTab();
    initUsersTab();
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
  // Submissions — view + inline edit any field on a past entry
  // =========================================================================
  function initSubmissionsTab() {
    var select = document.getElementById('submissions-form-type');
    var mount = document.getElementById('submissions-table');
    select.addEventListener('change', function () { loadSubmissions(select.value, mount); });
    loadSubmissions(select.value, mount);
  }

  function loadSubmissions(formType, mount) {
    mount.textContent = 'Loading…';
    Auth.apiCall('getEntries', { formType: formType, limit: 200 }).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok) { mount.textContent = 'Could not load submissions.'; return; }
      if (!result.entries.length) { mount.textContent = 'No submissions yet for this form.'; return; }

      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      ['Submitted', 'Employee', 'Date', 'Product', 'Details', 'Last Edited', 'Actions'].forEach(function (label) {
        headRow.appendChild(el('th', null, label));
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      result.entries.forEach(function (entry) {
        tbody.appendChild(buildSubmissionRow(entry, formType, function () { loadSubmissions(formType, mount); }));
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      mount.appendChild(wrap);
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
  // Catalog — every item across the three catalog-backed forms, with status
  // =========================================================================
  function initCatalogTab() {
    var select = document.getElementById('catalog-form-type');
    var mount = document.getElementById('catalog-table');
    select.addEventListener('change', function () { loadCatalog(select.value, mount); });
    loadCatalog(select.value, mount);
  }

  function loadCatalog(formType, mount) {
    mount.textContent = 'Loading…';
    Auth.apiCall('getCatalog', { formType: formType, includeAll: true }).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok) { mount.textContent = 'Could not load the catalog.'; return; }

      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      ['Item', 'Group', 'Unit', 'Status', 'Added By', 'Actions'].forEach(function (label) {
        headRow.appendChild(el('th', null, label));
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      result.items.forEach(function (item) {
        var row = el('tr');
        if (item.status === 'flagged') row.classList.add('below-threshold');
        if (item.status === 'discontinued') row.classList.add('is-discontinued');

        row.appendChild(el('th', 'count-table__item', item.name));
        row.appendChild(el('td', null, item.group));
        row.appendChild(el('td', null, item.unit));
        row.appendChild(el('td', null, item.status));
        row.appendChild(el('td', 'count-table__unit', item.addedBy));

        var actionCell = el('td');
        if (item.status === 'discontinued') {
          var restoreBtn = el('button', 'btn-inline-action', 'Restore');
          restoreBtn.type = 'button';
          restoreBtn.addEventListener('click', function () {
            restoreBtn.disabled = true;
            Auth.apiCall('restoreItem', { catalogId: item.catalogId }).then(function (r) {
              if (r.ok) loadCatalog(formType, mount); else restoreBtn.disabled = false;
            });
          });
          actionCell.appendChild(restoreBtn);
        } else {
          var discBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Discontinue');
          discBtn.type = 'button';
          discBtn.addEventListener('click', function () {
            if (!window.confirm('Discontinue "' + item.name + '"? It disappears from the active form immediately.')) return;
            discBtn.disabled = true;
            Auth.apiCall('discontinueItem', { catalogId: item.catalogId }).then(function (r) {
              if (r.ok) loadCatalog(formType, mount); else discBtn.disabled = false;
            });
          });
          actionCell.appendChild(discBtn);
        }
        row.appendChild(actionCell);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      mount.appendChild(wrap);
    });
  }

  // =========================================================================
  // Users — list + add + remove (soft-delete) accounts
  // =========================================================================
  function initUsersTab() {
    loadUsers();

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
          loadUsers();
        } else {
          setStatus(status, 'error', result.error === 'username_taken' ? 'That username is already taken.' : 'Could not add that user.');
        }
      });
    });
  }

  function loadUsers() {
    var mount = document.getElementById('users-table');
    mount.textContent = 'Loading…';
    Auth.apiCall('getUsers', {}).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok) { mount.textContent = 'Could not load users.'; return; }

      var session = Auth.getSession();
      var wrap = el('div', 'table-scroll');
      var table = el('table', 'count-table');
      var thead = el('thead');
      var headRow = el('tr');
      ['Username', 'Name', 'Role', 'Status', 'Actions'].forEach(function (label) {
        headRow.appendChild(el('th', null, label));
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      var tbody = el('tbody');
      result.users.forEach(function (user) {
        var row = el('tr');
        row.appendChild(el('th', 'count-table__item', user.username));
        row.appendChild(el('td', null, user.name));
        row.appendChild(el('td', null, user.role));
        row.appendChild(el('td', null, user.active ? 'Active' : 'Removed'));

        var actionCell = el('td');
        if (user.active && user.username !== session.username) {
          var removeBtn = el('button', 'btn-inline-action btn-inline-action--danger', 'Remove');
          removeBtn.type = 'button';
          removeBtn.addEventListener('click', function () {
            if (!window.confirm('Remove portal access for "' + user.username + '"?')) return;
            removeBtn.disabled = true;
            Auth.apiCall('removeUser', { username: user.username }).then(function (result) {
              if (result.ok) {
                loadUsers();
              } else {
                removeBtn.disabled = false;
                window.alert(result.error === 'cannot_remove_last_management'
                  ? 'Can’t remove the last active Management account.'
                  : 'Could not remove that user.');
              }
            });
          });
          actionCell.appendChild(removeBtn);
        }
        row.appendChild(actionCell);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      mount.appendChild(wrap);
    });
  }
})();

// /team/js/documents.js
// Shibam Coffee Atlanta — company documents list, managed by Management from
// the admin Documents tab (Catalog CRUD pattern) rather than hardcoded here.
// Loaded after config.js and auth.js. Each card links to its own page
// (document.html?id=...) instead of embedding inline.

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    setFooterYear();
    renderSessionBanner();
    renderDocuments();
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
    var session = window.Auth && Auth.getSession();
    if (!session) return;
    mount.innerHTML = '';
    mount.appendChild(document.createTextNode('Logged in as '));
    mount.appendChild(el('strong', null, session.name));
    mount.appendChild(document.createTextNode(' '));
    mount.appendChild(el('span', 'badge', session.role));
  }

  // Groups the fetched documents list into categories, preserving
  // first-seen order — the same pattern used to group catalog items
  // elsewhere in this portal (see groupBy in forms.js).
  function groupBy(items, key) {
    var groups = new Map();
    items.forEach(function (item) {
      var k = item[key] || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    });
    return groups;
  }

  function renderDocuments() {
    var mount = document.getElementById('documents-list');
    if (!mount) return;
    mount.textContent = 'Loading documents…';

    Auth.apiCall('getDocuments', {}).then(function (result) {
      mount.innerHTML = '';
      if (!result.ok || !Array.isArray(result.documents)) {
        mount.textContent = 'Could not load the document list. Refresh to try again.';
        return;
      }
      if (!result.documents.length) {
        mount.textContent = 'No documents have been added yet.';
        return;
      }

      var groups = groupBy(result.documents, 'category');
      groups.forEach(function (docs, categoryName) {
        var section = el('section', 'count-section');
        if (categoryName) {
          var head = el('div', 'count-section__head');
          head.appendChild(el('h3', 'count-section__title', categoryName));
          section.appendChild(head);
        }

        var grid = el('div', 'document-grid');
        docs.forEach(function (doc) { grid.appendChild(buildDocumentCard(doc)); });
        section.appendChild(grid);

        mount.appendChild(section);
      });
    });
  }

  function buildDocumentCard(doc) {
    var card = el('div', 'document-card');
    card.appendChild(el('h4', 'document-card__title', doc.title));
    if (doc.description) card.appendChild(el('p', 'document-card__description', doc.description));

    var link = el('a', 'btn btn-outline document-card__link', doc.driveFileId ? 'Open document' : 'View details');
    link.href = '/team/document?id=' + encodeURIComponent(doc.documentId);
    card.appendChild(link);

    return card;
  }
})();

// /team/js/documents.js
// Shibam Coffee Atlanta — company documents, embedded live from Google Drive.
// Loaded after config.js and auth.js.
//
// Adding a document: add one entry to DOCUMENTS below — that's the whole
// change, no other code needs to move. Each Drive file's sharing must be
// set to "Anyone with the link can view" for both the embed and the
// "Open in Drive" link to work.

(function () {
  'use strict';

  var DOCUMENTS = [
    { title: 'Employee Handbook', description: 'Company policies, conduct, and general employment info.', category: 'Handbook', driveFileId: '' },
    { title: 'Guidelines', description: 'Other operating guidelines.', category: 'Other Guidelines', driveFileId: '' }
  ];

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

  // Groups the flat DOCUMENTS list into categories, preserving first-seen
  // order — the same pattern used to group catalog items elsewhere in
  // this portal (see groupBy in forms.js).
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
    mount.innerHTML = '';

    var groups = groupBy(DOCUMENTS, 'category');
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
  }

  function buildDocumentCard(doc) {
    var card = el('div', 'document-card');
    card.appendChild(el('h4', 'document-card__title', doc.title));
    if (doc.description) card.appendChild(el('p', 'document-card__description', doc.description));

    if (doc.driveFileId) {
      var embed = el('div', 'document-embed');
      var iframe = document.createElement('iframe');
      iframe.src = 'https://drive.google.com/file/d/' + doc.driveFileId + '/preview';
      iframe.loading = 'lazy';
      iframe.title = doc.title;
      embed.appendChild(iframe);
      card.appendChild(embed);

      var link = el('a', 'btn btn-outline document-card__link', 'Open in Drive');
      link.href = 'https://drive.google.com/file/d/' + doc.driveFileId + '/view';
      link.target = '_blank';
      link.rel = 'noopener';
      card.appendChild(link);
    } else {
      card.appendChild(el('p', 'document-card__placeholder', 'Link coming soon.'));
    }

    return card;
  }
})();

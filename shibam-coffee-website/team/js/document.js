// /team/js/document.js
// Shibam Coffee Atlanta — single document detail page. Reads ?id= from the
// query string and finds the matching document via getDocuments (there's no
// dedicated single-document fetch action — the list is small, so filtering
// client-side is simplest and keeps the backend surface smaller).

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    setFooterYear();
    renderSessionBanner();
    renderDocument();
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

  function renderDocument() {
    var titleEl = document.getElementById('document-title');
    var descEl = document.getElementById('document-description');
    var body = document.getElementById('document-body');

    var id = new URLSearchParams(window.location.search).get('id');
    if (!id) {
      titleEl.textContent = 'Document not found';
      body.textContent = 'No document was specified.';
      return;
    }

    Auth.apiCall('getDocuments', {}).then(function (result) {
      if (!result.ok || !Array.isArray(result.documents)) {
        titleEl.textContent = 'Could not load this document';
        body.textContent = 'Refresh to try again.';
        return;
      }

      var doc = result.documents.find(function (d) { return d.documentId === id; });
      if (!doc) {
        titleEl.textContent = 'Document not found';
        body.textContent = 'This document may have been removed. Go back to Documents and pick another.';
        return;
      }

      document.title = doc.title + ' — Shibam Coffee Atlanta';
      titleEl.textContent = doc.title;
      descEl.textContent = doc.description || '';

      if (doc.driveFileId) {
        var embed = el('div', 'document-embed');
        var iframe = document.createElement('iframe');
        iframe.src = 'https://drive.google.com/file/d/' + doc.driveFileId + '/preview';
        iframe.loading = 'lazy';
        iframe.title = doc.title;
        embed.appendChild(iframe);
        body.appendChild(embed);

        var link = el('a', 'btn btn-outline document-card__link', 'Open in Drive');
        link.href = 'https://drive.google.com/file/d/' + doc.driveFileId + '/view';
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.marginTop = 'var(--space-3)';
        body.appendChild(link);
      } else {
        body.appendChild(el('p', 'document-card__placeholder', 'This document has no file linked yet.'));
      }
    });
  }
})();

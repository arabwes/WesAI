// /team/js/count-ui.js
// Shared mobile-first building blocks for the three count pages (weekly
// inventory, dessert daily count, local order list): quantity fields with a
// ¼ / ½ / ¾ opened-container picker, a row "⋯" menu that keeps destructive
// actions away from the inputs, bottom sheets for confirmations and
// reasons, and Enter-to-next keyboard flow. Loaded after config.js and
// auth.js; exposes window.CountUI. No dependencies, no build step.

(function () {
  'use strict';

  var FRACTIONS = [['', '–'], ['0.25', '¼'], ['0.5', '½'], ['0.75', '¾']];
  var FRACTION_GLYPHS = { '0.25': '¼', '0.5': '½', '0.75': '¾' };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(className, text, attrs) {
    var node = el('button', className, text);
    node.type = 'button';
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, attrs[key]); });
    return node;
  }

  // 4.75 → "4 ¾", 0.5 → "½", null → "—".
  function formatQty(value) {
    if (value === null || value === undefined || value === '' || isNaN(Number(value))) return '—';
    var number = Number(value);
    var whole = Math.floor(number);
    var glyph = FRACTION_GLYPHS[String(Math.round((number - whole) * 4) / 4)];
    if (!glyph) return String(number);
    return whole ? whole + ' ' + glyph : glyph;
  }

  // A whole-number box (numeric keypad) plus an optional quarter picker.
  // Blank stays blank (null) — zero only exists once someone enters it.
  // opts: { label, ariaName, unit, allowFraction (default true),
  //         dataAttr (adds a synced hidden input for form serialization) }
  function quantityField(opts) {
    var allowFraction = opts.allowFraction !== false;
    var root = el('div', 'qty-field');
    root.appendChild(el('span', 'qty-field__label', opts.label));

    var inputs = el('div', 'qty-field__inputs');
    var whole = el('input', 'qty-field__whole');
    whole.type = 'text';
    whole.inputMode = 'numeric';
    whole.autocomplete = 'off';
    whole.setAttribute('pattern', '[0-9]*');
    whole.setAttribute('enterkeyhint', 'next');
    whole.setAttribute('maxlength', '5');
    whole.placeholder = '–';
    whole.setAttribute('data-qty-whole', '');
    whole.setAttribute('aria-label', opts.label + ' — ' + opts.ariaName + (opts.unit ? ' (' + opts.unit + ')' : ''));
    inputs.appendChild(whole);

    var fraction = null;
    if (allowFraction) {
      fraction = el('select', 'qty-field__fraction');
      fraction.setAttribute('aria-label', 'Opened container, ' + opts.label.toLowerCase() + ' — ' + opts.ariaName);
      FRACTIONS.forEach(function (pair) {
        var option = el('option', null, pair[1]);
        option.value = pair[0];
        fraction.appendChild(option);
      });
      inputs.appendChild(fraction);
    }
    root.appendChild(inputs);

    var hidden = null;
    if (opts.dataAttr) {
      hidden = el('input');
      hidden.type = 'hidden';
      hidden.setAttribute(opts.dataAttr, '');
      hidden.setAttribute('data-qty-hidden', '');
      root.appendChild(hidden);
    }

    function get() {
      var wholeText = whole.value.trim();
      var fractionText = fraction ? fraction.value : '';
      if (wholeText === '' && fractionText === '') return null;
      return (parseInt(wholeText, 10) || 0) + (parseFloat(fractionText) || 0);
    }

    function syncHidden() {
      if (!hidden) return;
      var value = get();
      hidden.value = value === null ? '' : String(value);
    }

    function set(value) {
      if (value === null || value === undefined || value === '' || isNaN(Number(value))) {
        whole.value = '';
        if (fraction) fraction.value = '';
      } else {
        var number = Number(value);
        var wholePart = Math.floor(number);
        var rest = String(Math.round((number - wholePart) * 4) / 4);
        whole.value = String(wholePart);
        if (fraction) fraction.value = FRACTION_GLYPHS[rest] ? rest : '';
      }
      syncHidden();
    }

    whole.addEventListener('input', function () {
      var digits = whole.value.replace(/[^0-9]/g, '');
      if (digits !== whole.value) whole.value = digits;
      syncHidden();
    });
    if (fraction) fraction.addEventListener('change', syncHidden);

    var field = { root: root, whole: whole, fraction: fraction, hidden: hidden, get: get, set: set };
    root.__qtyField = field;
    return field;
  }

  // After form code writes values straight into hidden inputs (draft
  // restore, recall), push them back into the visible controls.
  function refreshFields(container) {
    container.querySelectorAll('.qty-field').forEach(function (root) {
      var field = root.__qtyField;
      if (field && field.hidden) field.set(field.hidden.value);
    });
  }

  // Enter / "Next" on a quantity box moves to the next one on the page,
  // so a count can be keyed in without reaching for the screen.
  function initKeyboardFlow(container) {
    container.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || !e.target.matches('[data-qty-whole]')) return;
      e.preventDefault();
      var all = Array.prototype.slice.call(container.querySelectorAll('[data-qty-whole]'))
        .filter(function (input) { return input.offsetParent !== null; });
      var next = all[all.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); } else { e.target.blur(); }
    });
  }

  // Brings a row into view below the sticky bar and focuses its first empty box.
  function focusRow(row) {
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var empty = Array.prototype.slice.call(row.querySelectorAll('[data-qty-whole]'))
      .filter(function (input) { return input.value === ''; })[0];
    setTimeout(function () { (empty || row.querySelector('[data-qty-whole]') || row).focus({ preventScroll: true }); }, 350);
    row.classList.add('is-highlighted');
    setTimeout(function () { row.classList.remove('is-highlighted'); }, 1600);
  }

  // ---------------------------------------------------------------------
  // Row "⋯" menu — Flag / Discontinue live here instead of beside the
  // count boxes, so a mis-tap mid-count can't retire an item.
  // actions: [{ label, danger, onSelect }]
  // ---------------------------------------------------------------------
  var openMenu = null;
  document.addEventListener('click', function (e) {
    if (openMenu && !openMenu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

  function closeMenu() {
    if (!openMenu) return;
    openMenu.querySelector('.row-menu__list').hidden = true;
    openMenu.querySelector('.row-menu__toggle').setAttribute('aria-expanded', 'false');
    openMenu = null;
  }

  function rowMenu(itemName, actions) {
    var wrap = el('div', 'row-menu');
    var toggle = button('row-menu__toggle', '⋯', { 'aria-label': 'More actions for ' + itemName, 'aria-haspopup': 'true', 'aria-expanded': 'false' });
    var list = el('div', 'row-menu__list');
    list.hidden = true;
    list.setAttribute('role', 'menu');
    actions.forEach(function (action) {
      var item = button('row-menu__item' + (action.danger ? ' row-menu__item--danger' : ''), action.label, { role: 'menuitem' });
      item.addEventListener('click', function () { closeMenu(); action.onSelect(); });
      list.appendChild(item);
    });
    toggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = openMenu === wrap;
      closeMenu();
      if (wasOpen) return;
      list.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      openMenu = wrap;
    });
    wrap.appendChild(toggle);
    wrap.appendChild(list);
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Bottom sheet — slides up from the bottom on phones, centered dialog on
  // wider screens. Resolves with whatever the caller passes to close().
  // ---------------------------------------------------------------------
  function sheet(opts) {
    var previouslyFocused = document.activeElement;
    var overlay = el('div', 'sheet-overlay');
    var panel = el('div', 'sheet');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    var title = el('h2', 'sheet__title', opts.title);
    title.id = 'sheet-title-' + Date.now();
    panel.setAttribute('aria-labelledby', title.id);
    panel.appendChild(title);
    var body = el('div', 'sheet__body');
    if (opts.message) body.appendChild(el('p', 'sheet__message', opts.message));
    if (opts.body) body.appendChild(opts.body);
    panel.appendChild(body);

    var actions = el('div', 'sheet__actions');
    var cancel = button('btn btn-outline', opts.cancelLabel || 'Cancel');
    var confirm = button('btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), opts.confirmLabel || 'OK');
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    panel.appendChild(actions);
    overlay.appendChild(panel);

    var resolveSheet;
    var promise = new Promise(function (resolve) { resolveSheet = resolve; });
    function close(value) {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.classList.remove('has-sheet');
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus({ preventScroll: true });
      resolveSheet(value);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', function () { close(null); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(null); });
    confirm.addEventListener('click', function () {
      if (confirm.getAttribute('aria-disabled') === 'true') return;
      close(opts.onConfirm ? opts.onConfirm() : true);
    });

    document.body.appendChild(overlay);
    document.body.classList.add('has-sheet');
    setTimeout(function () { (panel.querySelector('input, textarea') || confirm).focus(); }, 30);

    return {
      promise: promise,
      close: close,
      setConfirmEnabled: function (enabled) { confirm.setAttribute('aria-disabled', enabled ? 'false' : 'true'); }
    };
  }

  function confirmSheet(opts) {
    return sheet({ title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel, danger: opts.danger }).promise
      .then(function (value) { return value === true; });
  }

  // Asks for a short free-text reason; resolves with the text, or null on cancel.
  function promptSheet(opts) {
    var minLength = opts.minLength || 3;
    var wrap = el('div', 'form-group');
    var label = el('label', null, opts.label || 'Reason');
    var input = el('textarea');
    input.rows = 3;
    input.maxLength = 300;
    input.id = 'sheet-reason-' + Date.now();
    label.setAttribute('for', input.id);
    wrap.appendChild(label);
    wrap.appendChild(input);
    var handle = sheet({
      title: opts.title, message: opts.message, body: wrap, confirmLabel: opts.confirmLabel || 'Save',
      onConfirm: function () { return input.value.trim(); }
    });
    handle.setConfirmEnabled(false);
    input.addEventListener('input', function () { handle.setConfirmEnabled(input.value.trim().length >= minLength); });
    return handle.promise.then(function (value) { return typeof value === 'string' ? value : null; });
  }

  window.CountUI = {
    el: el,
    button: button,
    formatQty: formatQty,
    quantityField: quantityField,
    refreshFields: refreshFields,
    initKeyboardFlow: initKeyboardFlow,
    focusRow: focusRow,
    rowMenu: rowMenu,
    sheet: sheet,
    confirmSheet: confirmSheet,
    promptSheet: promptSheet
  };
})();

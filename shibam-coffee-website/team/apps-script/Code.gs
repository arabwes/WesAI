// Shibam Team Portal — Apps Script backend
// Handles login/sessions, form submissions, the item catalog (add / flag /
// discontinue), and Management's submission-editing + user-management tools.
//
// One-time setup after pasting this file:
//   1. In the function dropdown (next to the Debug button), select "setup"
//      and click Run. Authorize when prompted. This seeds the bootstrap
//      Management account and the item catalog — safe to run more than once,
//      it no-ops if either already has data.
//   2. Deploy → Manage deployments → Edit (pencil icon) → Deploy, to push
//      this code live under the existing /exec URL.
//
// Bootstrap Management login: username "Admin", password "Shibam313!".
// CHANGE THIS PASSWORD immediately after first login (Users tab in the
// Admin dashboard) — it's in plaintext in this file and in chat history.

var SESSION_HOURS = 12;
var ROLE_RANK = { barista: 1, lead: 2, management: 3 };
var LOG_TABS = {
  'inventory': 'Inventory Log',
  'dessert-daily': 'Dessert Daily Log',
  'dessert-order': 'Dessert Order Log',
  'local-order': 'Local Order Log'
};

// ===========================================================================
// Router
// ===========================================================================
function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var action = payload.action || 'submitForm'; // legacy forms without action = plain submit

  var result;
  try {
    switch (action) {
      case 'login': result = handleLogin(payload); break;
      case 'logout': result = handleLogout(payload); break;
      case 'submitForm': result = handleSubmitForm(payload); break;
      case 'getCatalog': result = handleGetCatalog(payload); break;
      case 'getUsers': result = handleGetUsers(payload); break;
      case 'addItem': result = handleAddItem(payload); break;
      case 'flagItem': result = handleFlagItem(payload); break;
      case 'discontinueItem': result = handleDiscontinueItem(payload); break;
      case 'restoreItem': result = handleRestoreItem(payload); break;
      case 'getEntries': result = handleGetEntries(payload); break;
      case 'updateEntry': result = handleUpdateEntry(payload); break;
      case 'updateItem': result = handleUpdateItem(payload); break;
      case 'getChangelog': result = handleGetChangelog(payload); break;
      case 'addUser': result = handleAddUser(payload); break;
      case 'removeUser': result = handleRemoveUser(payload); break;
      case 'resetPassword': result = handleResetPassword(payload); break;
      default: result = { ok: false, error: 'unknown_action' };
    }
  } catch (err) {
    result = { ok: false, error: 'server_error', message: String(err) };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===========================================================================
// Setup (run once from the editor)
// ===========================================================================
function setup() {
  seedAdminIfEmpty();
  seedCatalogIfEmpty();
}

function seedAdminIfEmpty() {
  var sheet = getUsersSheet();
  if (sheet.getLastRow() > 1) return;
  var salt = Utilities.getUuid();
  var hash = hashPassword('Shibam313!', salt);
  sheet.appendRow(['Admin', 'Admin', 'management', hash, salt, true, new Date().toISOString()]);
}

function seedCatalogIfEmpty() {
  var sheet = getCatalogSheet();
  if (sheet.getLastRow() > 1) return;

  var rows = SEED_CATALOG.map(function (item) {
    return [
      Utilities.getUuid(), item.formType, item.group, item.name,
      item.unit, item.threshold, item.location, item.target,
      'active', 'system', new Date().toISOString()
    ];
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

// ===========================================================================
// Sheet helpers
// ===========================================================================
function getSS() { return SpreadsheetApp.getActiveSpreadsheet(); }

function getSheet(name, headers) {
  var ss = getSS();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  return sheet;
}

function getUsersSheet() {
  return getSheet('Users', ['username', 'name', 'role', 'passwordHash', 'passwordSalt', 'active', 'createdAt']);
}

function getSessionsSheet() {
  return getSheet('Sessions', ['token', 'username', 'role', 'name', 'createdAt', 'expiresAt']);
}

function getCatalogSheet() {
  return getSheet('Catalog', ['catalogId', 'formType', 'group', 'name', 'unit', 'threshold', 'location', 'target', 'status', 'addedBy', 'addedAt']);
}

function getChangelogSheet() {
  return getSheet('Changelog', ['timestamp', 'username', 'role', 'action', 'target', 'details']);
}

// Records who did what, for the admin Changelog tab. Login/logout are
// deliberately not logged here — Sessions already tracks those, and they
// aren't data changes, so including them would bury the actual audit signal.
function logChange(session, action, target, details) {
  getChangelogSheet().appendRow([
    new Date().toISOString(), session.username, session.role, action,
    target, typeof details === 'string' ? details : JSON.stringify(details || {})
  ]);
}

// ===========================================================================
// Auth
// ===========================================================================
function hashPassword(password, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function handleLogin(payload) {
  var username = String(payload.username || '').trim();
  var password = String(payload.password || '');
  if (!username || !password) return { ok: false, error: 'missing_credentials' };

  var data = getUsersSheet().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // Usernames are matched case-insensitively; the case originally typed
    // at account creation is preserved for storage/display.
    if (String(row[0]).toLowerCase() === username.toLowerCase() && row[5] === true) {
      if (hashPassword(password, row[4]) === row[3]) {
        var token = Utilities.getUuid();
        var now = new Date();
        var expires = new Date(now.getTime() + SESSION_HOURS * 3600 * 1000);
        getSessionsSheet().appendRow([token, row[0], row[2], row[1], now.toISOString(), expires.toISOString()]);
        return { ok: true, token: token, role: row[2], name: row[1], username: row[0] };
      }
      return { ok: false, error: 'invalid_credentials' };
    }
  }
  return { ok: false, error: 'invalid_credentials' };
}

function handleLogout(payload) {
  var sheet = getSessionsSheet();
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === payload.token) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return { ok: true };
}

function getSession(token) {
  if (!token) return null;
  var data = getSessionsSheet().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      var expires = new Date(data[i][5]);
      if (isNaN(expires.getTime()) || expires.getTime() < Date.now()) return null;
      return { token: token, username: data[i][1], role: data[i][2], name: data[i][3] };
    }
  }
  return null;
}

// Returns the session on success, or an {ok:false,...} object on failure —
// callers do `if (session.ok === false) return session;` to short-circuit.
function requireRole(payload, minRole) {
  var session = getSession(payload.token || payload.sessionToken);
  if (!session) return { ok: false, error: 'session_expired' };
  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) return { ok: false, error: 'forbidden' };
  return session;
}

// ===========================================================================
// Form submissions
// ===========================================================================
function handleSubmitForm(payload) {
  var session = requireRole(payload, 'barista');
  if (session.ok === false) return session;

  var sheetName = LOG_TABS[payload.formType] || 'Other';
  var sheet = getSheet(sheetName, ['submittedAt', 'employeeName', 'date', 'product', 'details', 'entryId', 'lastEditedBy', 'lastEditedAt']);

  var rows = flattenSubmission(payload, session);
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  return { ok: true };
}

// One row per line item — who/when/date repeated on each row so the sheet
// can be filtered or pivoted without a lookup, and each row gets its own
// entryId so Management can edit exactly one item from a submission.
function flattenSubmission(payload, session) {
  var when = payload.submittedAt || new Date().toISOString();
  var who = session.name;
  var date = payload.weekOf || payload.date || payload.orderDate || '';
  var rows = [];

  (payload.items || []).forEach(function (item) {
    rows.push([when, who, date, item.product, JSON.stringify(item), Utilities.getUuid(), '', '']);
  });
  (payload.unlistedItems || []).forEach(function (item) {
    rows.push([when, who, date, item.name + ' (not on list)', JSON.stringify(item), Utilities.getUuid(), '', '']);
  });
  return rows;
}

// ===========================================================================
// Catalog — add / flag / discontinue / restore
// ===========================================================================
function handleGetCatalog(payload) {
  var session = requireRole(payload, 'barista');
  if (session.ok === false) return session;

  // Management browsing the admin Catalog tab needs discontinued items too
  // (to restore them); everyone else only ever sees the active/flagged list.
  var includeAll = payload.includeAll && ROLE_RANK[session.role] >= ROLE_RANK.management;

  var data = getCatalogSheet().getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[1] === payload.formType && (includeAll || row[8] !== 'discontinued')) {
      items.push({
        catalogId: row[0], formType: row[1], group: row[2], name: row[3],
        unit: row[4], threshold: row[5], location: row[6], target: row[7], status: row[8]
      });
    }
  }
  return { ok: true, items: items };
}

// True if another active-or-flagged row already has this name within this
// formType (case-insensitive, trimmed). `excludeCatalogId` lets updateItem
// exclude the row being renamed from colliding with itself.
function catalogNameTaken(data, formType, name, excludeCatalogId) {
  var needle = String(name || '').trim().toLowerCase();
  if (!needle) return false;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[0] === excludeCatalogId) continue;
    if (row[1] === formType && row[8] !== 'discontinued' &&
        String(row[3]).trim().toLowerCase() === needle) {
      return true;
    }
  }
  return false;
}

function handleAddItem(payload) {
  var session = requireRole(payload, 'lead');
  if (session.ok === false) return session;

  var item = payload.item || {};
  if (!item.name) return { ok: false, error: 'missing_name' };

  var sheet = getCatalogSheet();
  var data = sheet.getDataRange().getValues();
  if (catalogNameTaken(data, payload.formType, item.name)) {
    return { ok: false, error: 'duplicate_name' };
  }

  var catalogId = Utilities.getUuid();
  sheet.appendRow([
    catalogId, payload.formType, item.group || '', item.name,
    item.unit || '', item.threshold || '', item.location || '', item.target || '',
    'active', session.username, new Date().toISOString()
  ]);
  logChange(session, 'addItem', catalogId, { formType: payload.formType, name: item.name });
  return { ok: true, catalogId: catalogId };
}

// Accepts either a single catalogId or an array of them (catalogIds) so the
// admin dashboard's multiselect can discontinue/restore/flag a batch in one
// request instead of one round-trip per item.
function setCatalogStatuses(catalogIds, status) {
  var sheet = getCatalogSheet();
  var data = sheet.getDataRange().getValues();
  var remaining = {};
  catalogIds.forEach(function (id) { remaining[id] = true; });
  var updated = [];
  for (var i = 1; i < data.length && Object.keys(remaining).length; i++) {
    if (remaining[data[i][0]]) {
      sheet.getRange(i + 1, 9).setValue(status); // column I = status
      updated.push(data[i][0]);
      delete remaining[data[i][0]];
    }
  }
  return { updated: updated, notFound: Object.keys(remaining) };
}

function idsFromPayload(payload) {
  if (Array.isArray(payload.catalogIds)) return payload.catalogIds;
  return payload.catalogId ? [payload.catalogId] : [];
}

function handleFlagItem(payload) {
  var session = requireRole(payload, 'lead');
  if (session.ok === false) return session;
  var ids = idsFromPayload(payload);
  if (!ids.length) return { ok: false, error: 'not_found' };
  var result = setCatalogStatuses(ids, 'flagged');
  if (result.updated.length) logChange(session, 'flagItem', result.updated.join(','), { count: result.updated.length });
  return { ok: true, updated: result.updated, notFound: result.notFound };
}

function handleDiscontinueItem(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;
  var ids = idsFromPayload(payload);
  if (!ids.length) return { ok: false, error: 'not_found' };
  var result = setCatalogStatuses(ids, 'discontinued');
  if (result.updated.length) logChange(session, 'discontinueItem', result.updated.join(','), { count: result.updated.length });
  return { ok: true, updated: result.updated, notFound: result.notFound };
}

function handleRestoreItem(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;
  var ids = idsFromPayload(payload);
  if (!ids.length) return { ok: false, error: 'not_found' };
  var result = setCatalogStatuses(ids, 'active');
  if (result.updated.length) logChange(session, 'restoreItem', result.updated.join(','), { count: result.updated.length });
  return { ok: true, updated: result.updated, notFound: result.notFound };
}

// Edits an existing catalog item's fields in place (name/unit/group/etc.) —
// separate from the status-only transitions above. Management only, since
// renaming a shared list item affects everyone who fills out that form.
function handleUpdateItem(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var sheet = getCatalogSheet();
  var data = sheet.getDataRange().getValues();
  var changes = payload.changes || {};

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === payload.catalogId) {
      var formType = data[i][1];
      if (changes.name !== undefined && catalogNameTaken(data, formType, changes.name, payload.catalogId)) {
        return { ok: false, error: 'duplicate_name' };
      }
      var COLS = { name: 4, group: 3, unit: 5, threshold: 6, location: 7, target: 8 };
      Object.keys(COLS).forEach(function (key) {
        if (changes[key] !== undefined) sheet.getRange(i + 1, COLS[key]).setValue(changes[key]);
      });
      logChange(session, 'updateItem', payload.catalogId, changes);
      return { ok: true };
    }
  }
  return { ok: false, error: 'not_found' };
}

// ===========================================================================
// Management — view & edit submitted entries
// ===========================================================================
function handleGetEntries(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var sheetName = LOG_TABS[payload.formType];
  if (!sheetName) return { ok: false, error: 'invalid_formType' };

  var sheet = getSS().getSheetByName(sheetName);
  if (!sheet) return { ok: true, entries: [] };

  var data = sheet.getDataRange().getValues();
  var limit = payload.limit || 200;
  var entries = [];
  for (var i = data.length - 1; i >= 1 && entries.length < limit; i--) {
    var row = data[i];
    entries.push({
      submittedAt: row[0], employeeName: row[1], date: row[2], product: row[3],
      details: row[4], entryId: row[5], lastEditedBy: row[6], lastEditedAt: row[7]
    });
  }
  return { ok: true, entries: entries };
}

function handleUpdateEntry(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var sheetName = LOG_TABS[payload.formType];
  var sheet = sheetName && getSS().getSheetByName(sheetName);
  if (!sheet) return { ok: false, error: 'invalid_formType' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][5] === payload.entryId) {
      var changes = payload.changes || {};
      if (changes.date !== undefined) sheet.getRange(i + 1, 3).setValue(changes.date);
      if (changes.product !== undefined) sheet.getRange(i + 1, 4).setValue(changes.product);
      if (changes.details !== undefined) sheet.getRange(i + 1, 5).setValue(changes.details);
      sheet.getRange(i + 1, 7).setValue(session.username);
      sheet.getRange(i + 1, 8).setValue(new Date().toISOString());
      logChange(session, 'updateEntry', payload.entryId, changes);
      return { ok: true };
    }
  }
  return { ok: false, error: 'not_found' };
}

// ===========================================================================
// Management — changelog
// ===========================================================================
function handleGetChangelog(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var data = getChangelogSheet().getDataRange().getValues();
  var limit = payload.limit || 200;
  var entries = [];
  for (var i = data.length - 1; i >= 1 && entries.length < limit; i--) {
    var row = data[i];
    entries.push({ timestamp: row[0], username: row[1], role: row[2], action: row[3], target: row[4], details: row[5] });
  }
  return { ok: true, entries: entries };
}

// ===========================================================================
// Management — users
// ===========================================================================
// Never returns passwordHash/passwordSalt — the admin Users tab lists
// accounts, it doesn't need to (and shouldn't) see credential material.
function handleGetUsers(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var data = getUsersSheet().getDataRange().getValues();
  var users = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    users.push({ username: row[0], name: row[1], role: row[2], active: row[5], createdAt: row[6] });
  }
  return { ok: true, users: users };
}

// Usernames are matched case-insensitively everywhere; whatever case was
// originally entered at account creation is preserved for storage/display.
// Returns the row index into `data` (>=1) or -1 if no match.
function findUserRowIndex(data, username) {
  var needle = String(username || '').trim().toLowerCase();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === needle) return i;
  }
  return -1;
}

function handleAddUser(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var newUser = payload.newUser || {};
  var username = String(newUser.username || '').trim();
  var role = newUser.role;
  if (!username || !newUser.password || ROLE_RANK[role] === undefined) {
    return { ok: false, error: 'invalid_user' };
  }

  var sheet = getUsersSheet();
  var data = sheet.getDataRange().getValues();
  if (findUserRowIndex(data, username) !== -1) return { ok: false, error: 'username_taken' };

  var salt = Utilities.getUuid();
  var hash = hashPassword(newUser.password, salt);
  sheet.appendRow([username, newUser.name || username, role, hash, salt, true, new Date().toISOString()]);
  logChange(session, 'addUser', username, { role: role });
  return { ok: true };
}

function handleRemoveUser(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var username = String(payload.username || '').trim();
  if (username.toLowerCase() === String(session.username).toLowerCase()) {
    return { ok: false, error: 'cannot_remove_self' };
  }

  var sheet = getUsersSheet();
  var data = sheet.getDataRange().getValues();

  var activeManagers = 0;
  for (var i = 1; i < data.length; i++) {
    if (data[i][2] === 'management' && data[i][5] === true) activeManagers++;
  }

  var j = findUserRowIndex(data, username);
  if (j === -1) return { ok: false, error: 'not_found' };
  if (data[j][2] === 'management' && data[j][5] === true && activeManagers <= 1) {
    return { ok: false, error: 'cannot_remove_last_management' };
  }
  sheet.getRange(j + 1, 6).setValue(false);
  logChange(session, 'removeUser', data[j][0], {});
  return { ok: true };
}

function handleResetPassword(payload) {
  var session = requireRole(payload, 'management');
  if (session.ok === false) return session;

  var username = String(payload.username || '').trim();
  var newPassword = String(payload.newPassword || '');
  if (!username || !newPassword) return { ok: false, error: 'invalid_request' };

  var sheet = getUsersSheet();
  var data = sheet.getDataRange().getValues();
  var i = findUserRowIndex(data, username);
  if (i === -1) return { ok: false, error: 'not_found' };

  var salt = Utilities.getUuid();
  var hash = hashPassword(newPassword, salt);
  sheet.getRange(i + 1, 4).setValue(hash); // passwordHash
  sheet.getRange(i + 1, 5).setValue(salt); // passwordSalt
  logChange(session, 'resetPassword', data[i][0], {});
  return { ok: true };
}

var SEED_CATALOG = [
  {formType:"inventory", group:"Coffee Beans", location:"Kitchen", name:"Dark Roast", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee Beans", location:"Kitchen", name:"Medium Roast", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee Beans", location:"Kitchen", name:"Light Roast", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee Beans", location:"Kitchen", name:"Decaf Beans", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Green", location:"Kitchen", name:"Green Coffee Beans", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Green", location:"Kitchen", name:"Matcha", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Professional Roasting", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Adani Tea", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Yemeni Tea", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Drip Coffee Grind", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Turkish", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Saudi", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Jubani", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Moroccan Mint Tea", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Meditative Mind", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Ginger Tea", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Saffron", unit:"box", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Sana'ani", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Rad'ai", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Qishr / Coffee Husks", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Coffee / Tea Mix", location:"Kitchen", name:"Qishr Spices", unit:"lb", threshold:'', target:''},
  // Note: the "Kitchen — Pastries & Food" dessert items (Honeycomb, Dubai
  // Chocolate, Lotus/Pistachio/Caramel cakes, etc.) are deliberately not
  // seeded here — they're already tracked daily under formType:"dessert"
  // below, and Weekly Inventory shouldn't duplicate the Dessert Inventory
  // form's list.
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"1883 Blackberry", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"1883 Blueberry", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Brown Sugar Sauce", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Caramel Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Caramel Sauce", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Chocolate Powder", unit:"Bag", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Chocolate Sauce", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Dragon Fruit Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Frappe Mix Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Freeze Dried Strawberry", unit:"Bag", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"French Vanilla Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Hazelnut", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Honey Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Lotus Spread", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Mango Pulp", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Mango Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Peach Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Pistachio Sauce", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Pumpkin Spice Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Pumpkin Pie Sauce", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Raspberry Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Rose Syrup", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"SF Caramel Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"SF Vanilla Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Strawberry Pieces", unit:"Bag", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Strawberry Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Toot Shami", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Vanilla Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"Vimto", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"White Chocolate Sauce", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"White Chocolate Syrup", unit:"Bottle", threshold:'', target:''},
  {formType:"inventory", group:"Sauce / Syrup", location:"Storage", name:"White Chocolate Powder", unit:"Bag", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"4oz Paper Cup", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"6oz Paper Cup", unit:"Box 1000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"8oz Paper Cup", unit:"Box 500", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"12oz Paper Cup (Double Insulation)", unit:"Box 500", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"16oz Paper Cup (Double Insulation)", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"16oz Non-Branded Hot Cup", unit:"Box 1000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"16oz Non-Branded Paper Cup", unit:"Box 1000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"20oz Paper Cup", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"16oz & 20oz Poly Cup", unit:"Box 1000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"2oz Poly Box", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"12–20oz Paper Cup Hot Lids", unit:"Box 1000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"Clear Cup Lids", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"Clear Sippy Lids", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"Dome Clear Lids", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"Sleeve", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"2 Cups Holder", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Cups & Lids", location:"Storage", name:"4 Cups Holder", unit:"Box 200", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"4.5oz Ceramic Mug", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"6oz Tea Glass Cup", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"12oz Ceramic Mugs (Latte)", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"14oz Ceramic Cup (Dine-in)", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"16oz Glass Mug (Iced Latte)", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"16oz Glass Coke Cup", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"20oz Glass Mug", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"20oz Glass Coke Cup", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"Small Glass Pot Base", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"Medium Glass Pot", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"Large Glass Pot", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"Glass Coffee/Tea Base", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"35oz Metal Coffee Pot", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"5 Liter Tea/Coffee Metal Pot", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"2 Tbsp Metal Spoon", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"Small Wood Plate", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Glass, Ceramic & Metal", location:"Storage", name:"Large Wood Plate", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"1 lb Bags", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"15 lb Bag", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"1oz Tin Box", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"16oz Tin Box", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"6\" Clear Box", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"96oz Travel Box", unit:"Box 50", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Honeycomb Plastic To-Go Box", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Sandwich To-Go Box", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Small Shopping Bags", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Large Shopping Bags", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Shopping Bags 4.5x10.25", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Napkin", unit:"Box 5500", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Jumbo Straws", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Forks", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Knife", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Thermal Paper", unit:"Roll", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Shibam Sticker Roll", unit:"Roll 3333", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Packaging & Paper", location:"Storage", name:"Custom Acrylic Percolator Cover (5 gal)", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Almudhesh Evaporated Milk", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"50 lb Sugar", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Raw Brown Sugar Stick Packets", unit:"Branded Box 2000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Blue Sugar Substitute Stick Packets", unit:"Branded Box 2000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Pink Sugar Substitute Stick Packets", unit:"Branded Box 2000", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Shibam Spices", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Cardamom", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Cinnamon", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Cloves", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Ginger Spice", unit:"lb", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"50g Dragon Fruit Diced", unit:"Bag", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Lotus Spread Bucket 17.6 lb", unit:"Bucket", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — Pantry & Spices", location:"Storage", name:"Sprite Can", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — K-Cups & Merch", location:"Storage", name:"Dark K-Cup 12PC", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — K-Cups & Merch", location:"Storage", name:"Dark K-Cup 24PC", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — K-Cups & Merch", location:"Storage", name:"Medium K-Cup 12PC", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — K-Cups & Merch", location:"Storage", name:"Medium K-Cup 24PC", unit:"Box", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — K-Cups & Merch", location:"Storage", name:"Apron", unit:"Piece", threshold:'', target:''},
  {formType:"inventory", group:"Warehouse — K-Cups & Merch", location:"Storage", name:"Hoodies", unit:"Piece", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Honeycomb", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Sabaya", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Pistachio Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Lotus Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Ras Malai Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Rose Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Oreo Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Caramel Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Mango Milk Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Kunafa Cheesecake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Lotus Cheesecake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Pistachio Cheesecake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Berry Cheesecake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Tiramisu Cheesecake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Tiramisu", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Dubai Chocolate", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Dubai Brownie", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Dark Chocolate", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Matcha Chocolate", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Caramel Chocolate", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Sticky Toffee Date Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Persian Love Cake", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Pistachio Tart", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Mango Tart", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Strawberry Frasier", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Cake Pops", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Simit — Sesame", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Simit — Zaatar", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Zaatar Focaccia", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Olive Focaccia", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Rosemary Focaccia", unit:"", threshold:'', target:''},
  {formType:"dessert", group:"", location:"", name:"Croissants", unit:"", threshold:'', target:''},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Whole Milk", unit:"Jug/Bottle", threshold:6, target:20},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"2% Milk", unit:"Jug/Bottle", threshold:1, target:2},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Half & Half", unit:"Jug/Bottle", threshold:2, target:4},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Heavy Cream", unit:"Jug/Bottle", threshold:3, target:4},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Whipped Cream", unit:"Jug/Bottle", threshold:1, target:3},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Lime", unit:"Bag", threshold:0.1, target:1},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Mint", unit:"Bunch", threshold:0.1, target:1},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Honey", unit:"Jug/Bottle", threshold:2, target:5},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Lemonade", unit:"Jug/Bottle", threshold:2, target:6},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Mascarpone", unit:"Tub", threshold:2, target:''},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Water (Kirkland)", unit:"Case", threshold:0.5, target:1},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Water (Fiji)", unit:"Case", threshold:0.5, target:1},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Sprite", unit:"Case", threshold:0.5, target:3},
  {formType:"local-order", group:"Bar & Front of House", location:"", name:"Parchment Paper (register)", unit:"Box", threshold:1, target:2},
  {formType:"local-order", group:"Cleaning & Supplies", location:"", name:"Large Trash Bags 50+ Gallon", unit:"Roll", threshold:2, target:''},
  {formType:"local-order", group:"Cleaning & Supplies", location:"", name:"Bathroom Trash Bags 13 Gallon", unit:"Roll", threshold:2, target:''},
  {formType:"local-order", group:"Cleaning & Supplies", location:"", name:"Paper Towels", unit:"Roll", threshold:2, target:''},
  {formType:"local-order", group:"Cleaning & Supplies", location:"", name:"Pine Sol", unit:"Jug/Bottle", threshold:2, target:''},
  {formType:"local-order", group:"Cleaning & Supplies", location:"", name:"Hand Towels", unit:"Pack", threshold:1, target:''},
  {formType:"local-order", group:"Check Downstairs Storage First", location:"", name:"Evaporated Milk", unit:"Case", threshold:1, target:4},
  {formType:"local-order", group:"Check Downstairs Storage First", location:"", name:"Condensed Milk", unit:"Case", threshold:1, target:4}
];

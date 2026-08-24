import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const inputDir = resolve(process.argv[2] || 'legacy-export');
const outputFile = resolve(process.argv[3] || 'legacy-import.sql');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map((value) => value.trim());
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function sql(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function csv(name) {
  const path = join(inputDir, `${name}.csv`);
  return existsSync(path) ? parseCsv(await readFile(path, 'utf8')) : [];
}

const lines = ['BEGIN TRANSACTION;'];
const userIds = new Map();
for (const user of await csv('Users')) {
  const id = `usr_${randomUUID()}`;
  userIds.set(user.name, id);
  const role = ['barista', 'lead', 'management'].includes(user.role) ? user.role : 'barista';
  const active = String(user.active).toLowerCase() === 'true' ? 1 : 0;
  const createdAt = user.createdAt || new Date().toISOString();
  lines.push(`INSERT INTO users (id, username, name, email, role, password_hash, password_salt, password_algorithm, active, created_at, updated_at) VALUES (${sql(id)}, ${sql(user.username)}, ${sql(user.name || user.username)}, NULL, ${sql(role)}, ${sql(user.passwordHash)}, ${sql(user.passwordSalt)}, 'legacy-sha256', ${active}, ${sql(createdAt)}, ${sql(createdAt)});`);
  const position = role === 'management' ? 'position-management' : role === 'lead' ? 'position-lead' : 'position-barista';
  lines.push(`INSERT OR IGNORE INTO employee_positions (user_id, position_id) VALUES (${sql(id)}, ${sql(position)});`);
}

for (const item of await csv('Catalog')) {
  lines.push(`INSERT OR IGNORE INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at) VALUES (${sql(item.catalogId || `catalog_${randomUUID()}`)}, ${sql(item.formType)}, ${sql(item.group || '')}, ${sql(item.name)}, ${sql(item.unit || '')}, ${sql(item.threshold || '')}, ${sql(item.location || '')}, ${sql(item.target || '')}, ${sql(item.status || 'active')}, ${sql(item.addedBy || 'legacy-import')}, ${sql(item.addedAt || new Date().toISOString())});`);
}

const logs = [
  ['Inventory Log', 'inventory'], ['Dessert Daily Log', 'dessert-daily'],
  ['Dessert Order Log', 'dessert-order'], ['Local Order Log', 'local-order']
];
for (const [file, formType] of logs) {
  for (const entry of await csv(file)) {
    lines.push(`INSERT OR IGNORE INTO form_entries (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json, last_edited_by, last_edited_at) VALUES (${sql(entry.entryId || `entry_${randomUUID()}`)}, ${sql(formType)}, ${sql(entry.submittedAt)}, ${sql(userIds.get(entry.employeeName) || null)}, ${sql(entry.employeeName)}, ${sql(entry.date || '')}, ${sql(entry.product)}, ${sql(entry.details || '{}')}, ${sql(entry.lastEditedBy || null)}, ${sql(entry.lastEditedAt || null)});`);
  }
}
lines.push('COMMIT;');
await writeFile(outputFile, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${lines.length - 2} import statements to ${outputFile}`);

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourcePath = resolve('team/apps-script/Code.gs');
const outputPath = resolve('migrations/0004_seed_inventory_catalog.sql');
const source = await readFile(sourcePath, 'utf8');
const match = source.match(/var SEED_CATALOG = (\[[\s\S]*?\n\]);/);

if (!match) throw new Error('SEED_CATALOG was not found in team/apps-script/Code.gs');

const catalog = Function(`"use strict"; return (${match[1]});`)();

function sql(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

const lines = [
  '-- Restore the canonical inventory, dessert, and local-order catalogs.',
  '-- Existing items are preserved; matching form-type/name pairs are not duplicated.',
  ''
];

catalog.forEach((item, index) => {
  const sequence = String(index + 1).padStart(4, '0');
  const millis = String(index + 1).padStart(3, '0');
  lines.push(
    'INSERT INTO catalog (id, form_type, group_name, name, unit, threshold, location, target, status, added_by, created_at)',
    `SELECT ${sql(`catalog_seed_${sequence}`)}, ${sql(item.formType)}, ${sql(item.group)}, ${sql(item.name)}, ${sql(item.unit)}, ${sql(item.threshold)}, ${sql(item.location)}, ${sql(item.target)}, 'active', 'system-seed', ${sql(`2026-09-01T00:00:00.${millis}Z`)}`,
    `WHERE NOT EXISTS (SELECT 1 FROM catalog WHERE form_type = ${sql(item.formType)} AND name = ${sql(item.name)} COLLATE NOCASE);`,
    ''
  );
});

await writeFile(outputPath, `${lines.join('\n').trimEnd()}\n`, 'utf8');
console.log(`Wrote ${catalog.length} catalog items to ${outputPath}`);

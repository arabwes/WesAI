// Migration 0016 on a database that is already at 0015, as production was: it must keep
// every existing link working, give old links no stored address, and pull any meeting type
// that was set past 30 days back to 30.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));

test('0016 on a live-shaped database: old links stay valid, no address, windows clamped to 30', () => {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  files.filter((f) => f < '0016').forEach((f) => db.exec(readFileSync(join(dir, f), 'utf8')));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, username, name, role, password_hash, password_salt, password_algorithm, active, created_at, updated_at) VALUES ('u','u','U','lead','x','x','pbkdf2-sha256',1,?,?)").run(now, now);
  db.prepare("INSERT INTO meeting_locations (id,name,address_line1,city,state,postal_code,active,created_at,updated_at) VALUES ('l','L','1 Main','A','GA','30022',1,?,?)").run(now, now);
  const insertType = db.prepare("INSERT INTO event_types (id,owner_id,name,slug,duration_minutes,location_id,max_days_ahead,created_at,updated_at) VALUES (?,'u',?,?,30,'l',?,?,?)");
  insertType.run('e60', 'Sixty', 'sixty', 60, now, now);
  insertType.run('e90', 'Ninety', 'ninety', 90, now, now);
  insertType.run('e14', 'Fourteen', 'fourteen', 14, now, now);
  insertType.run('e30', 'Thirty', 'thirty', 30, now, now);
  db.prepare("INSERT INTO booking_links (id,event_type_id,token_hash,label,created_at) VALUES ('k','e60','abc','Old link',?)").run(now);

  const migration = files.find((f) => f.startsWith('0016'));
  assert.ok(migration, '0016 exists');
  db.exec(readFileSync(join(dir, migration), 'utf8'));

  const days = Object.fromEntries(db.prepare('SELECT id, max_days_ahead AS d FROM event_types').all().map((r) => [r.id, r.d]));
  assert.deepEqual(days, { e60: 30, e90: 30, e14: 14, e30: 30 }, 'only values over 30 change');
  const link = db.prepare('SELECT token_hash, token, revoked_at FROM booking_links').get();
  assert.deepEqual({ ...link }, { token_hash: 'abc', token: null, revoked_at: null }, 'the old link is untouched and has no stored address');
});

// Minimal Cloudflare D1 stand-in backed by node:sqlite, so backend handlers
// run unmodified in `node --test` against the real migration files.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args.map(bindable);
    return this;
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.args) ?? null;
  }

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) return { results: statement.all(...this.args), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(statement.run(...this.args).changes) } };
  }
}

export function createTestDatabase(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    .forEach((name) => db.exec(readFileSync(join(migrationsDir, name), 'utf8')));
  return {
    raw: db,
    prepare(sql) {
      return new Statement(db, sql);
    },
    // D1 batches are transactional: all statements commit or none do.
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

// Creates an active user plus a session, returning a Request-like object
// that carries that session's cookie.
export function addUserWithSession(database, { id, username, name, role }) {
  const now = new Date().toISOString();
  database.raw.prepare(`INSERT INTO users (id, username, name, role, password_hash, password_salt, password_algorithm,
      active, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x', 'pbkdf2-sha256', 1, ?, ?)`)
    .run(id, username, name, role, now, now);
  const token = `token-${id}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  database.raw.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip_hash)
      VALUES (?, ?, ?, ?, '', '')`)
    .run(tokenHash, id, now, new Date(Date.now() + 3600 * 1000).toISOString());
  return new Request('https://portal.test/api/team', { headers: { Cookie: `shibam_team_session=${token}` } });
}

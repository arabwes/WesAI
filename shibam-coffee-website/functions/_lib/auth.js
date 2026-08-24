import { ApiError, getCookie, newId, nowIso, publicUser, sha256Hex } from './http.js';

const ROLE_RANK = { barista: 1, lead: 2, management: 3 };
const COOKIE_NAME = 'shibam_team_session';
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

async function timingSafeTextEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(left))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(right)))
  ]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function randomHex(bytes = 16) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt: encoder.encode(salt),
    iterations: PBKDF2_ITERATIONS
  }, key, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function makePassword(password) {
  if (String(password || '').length < 10) throw new ApiError('password_too_short', 400);
  const salt = randomHex();
  return { hash: await pbkdf2(String(password), salt), salt, algorithm: 'pbkdf2-sha256' };
}

async function verifyPassword(password, user) {
  const algorithm = user.password_algorithm || 'legacy-sha256';
  const actual = algorithm === 'legacy-sha256'
    ? await sha256Hex(String(password) + user.password_salt)
    : await pbkdf2(String(password), user.password_salt);
  return timingSafeTextEqual(actual, user.password_hash);
}

function cookieValue(token, env, maxAge) {
  const secure = env.APP_ENV === 'development' ? '' : '; Secure';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(env) {
  return cookieValue('', env, 0);
}

async function validateTurnstile(payload, request, env) {
  if (!env.TURNSTILE_SECRET) return;
  if (!payload.turnstileToken) throw new ApiError('turnstile_required', 400);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: payload.turnstileToken,
      remoteip: request.headers.get('CF-Connecting-IP') || undefined,
      idempotency_key: crypto.randomUUID()
    })
  });
  const result = await response.json();
  if (!result.success) throw new ApiError('turnstile_failed', 403);
}

async function rateLimitLogin(db, request, username) {
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = await sha256Hex(`${ip}:${String(username).toLowerCase()}:${bucket}`);
  await db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at TEXT NOT NULL
  )`).run();
  const row = await db.prepare('SELECT attempts FROM login_attempts WHERE attempt_key = ?').bind(key).first();
  if (Number(row?.attempts || 0) >= 10) throw new ApiError('too_many_attempts', 429);
  await db.prepare(`INSERT INTO login_attempts (attempt_key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET attempts = attempts + 1`)
    .bind(key, new Date(Date.now() + 20 * 60 * 1000).toISOString()).run();
  return key;
}

export async function login(request, payload, env) {
  await validateTurnstile(payload, request, env);
  const username = String(payload.username || '').trim();
  const password = String(payload.password || '');
  if (!username || !password) throw new ApiError('missing_credentials', 400);
  const attemptKey = await rateLimitLogin(env.TEAM_DB, request, username);
  const user = await env.TEAM_DB.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1')
    .bind(username).first();
  if (!user || !(await verifyPassword(password, user))) throw new ApiError('invalid_credentials', 401);

  if (user.password_algorithm === 'legacy-sha256') {
    const upgraded = await makePassword(password);
    await env.TEAM_DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, password_algorithm = ?, updated_at = ? WHERE id = ?`)
      .bind(upgraded.hash, upgraded.salt, upgraded.algorithm, nowIso(), user.id).run();
  }

  await env.TEAM_DB.prepare('DELETE FROM login_attempts WHERE attempt_key = ?').bind(attemptKey).run();
  const rawToken = `${crypto.randomUUID()}${randomHex(16)}`;
  const tokenHash = await sha256Hex(rawToken);
  const hours = Number(env.SESSION_HOURS || 12);
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') || 'local');
  await env.TEAM_DB.prepare(`INSERT INTO sessions
    (token_hash, user_id, created_at, expires_at, user_agent, ip_hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(tokenHash, user.id, nowIso(), expiresAt, request.headers.get('User-Agent') || '', ipHash).run();
  await audit(env.TEAM_DB, user.id, 'auth.login', 'session', tokenHash.slice(0, 12), {});
  return {
    result: { ok: true, ...publicUser(user), expiresAt },
    cookie: cookieValue(rawToken, env, Math.max(60, Math.round(hours * 3600)))
  };
}

export async function logout(request, payload, env) {
  const rawToken = getCookie(request, COOKIE_NAME) || String(payload.token || '');
  if (rawToken) {
    const tokenHash = await sha256Hex(rawToken);
    await env.TEAM_DB.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?').bind(nowIso(), tokenHash).run();
  }
  return { result: { ok: true }, cookie: clearSessionCookie(env) };
}

export async function getSession(request, payload, env) {
  const rawToken = getCookie(request, COOKIE_NAME) || String(payload?.token || payload?.sessionToken || '');
  if (!rawToken) return null;
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.TEAM_DB.prepare(`SELECT u.*, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.active = 1`)
    .bind(tokenHash, nowIso()).first();
  return row ? { ...publicUser(row), expiresAt: row.session_expires_at } : null;
}

export async function requireRole(request, payload, env, minRole = 'barista') {
  const user = await getSession(request, payload, env);
  if (!user) throw new ApiError('session_expired', 401);
  if ((ROLE_RANK[user.role] || 0) < (ROLE_RANK[minRole] || 999)) throw new ApiError('forbidden', 403);
  return user;
}

export function hasRole(user, minRole) {
  return !!user && (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[minRole] || 999);
}

export async function bootstrap(payload, env) {
  if (!env.BOOTSTRAP_SECRET || !(await timingSafeTextEqual(payload.bootstrapSecret || '', env.BOOTSTRAP_SECRET))) {
    throw new ApiError('forbidden', 403);
  }
  const count = await env.TEAM_DB.prepare('SELECT COUNT(*) AS total FROM users').first();
  if (Number(count.total) > 0) throw new ApiError('already_bootstrapped', 409);
  const username = String(payload.username || '').trim();
  const name = String(payload.name || username).trim();
  const email = String(payload.email || '').trim() || null;
  if (!username || !name) throw new ApiError('invalid_user', 400);
  const password = await makePassword(payload.password);
  const id = newId('usr');
  const now = nowIso();
  await env.TEAM_DB.batch([
    env.TEAM_DB.prepare(`INSERT INTO users
      (id, username, name, email, role, password_hash, password_salt, password_algorithm, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'management', ?, ?, ?, 1, ?, ?)`)
      .bind(id, username, name, email, password.hash, password.salt, password.algorithm, now, now),
    env.TEAM_DB.prepare('INSERT INTO employee_positions (user_id, position_id) VALUES (?, ?)')
      .bind(id, 'position-management')
  ]);
  await audit(env.TEAM_DB, id, 'auth.bootstrap', 'user', id, { username });
  return { ok: true };
}

export async function audit(db, actorUserId, action, entityType, entityId, details) {
  await db.prepare(`INSERT INTO audit_events
    (id, actor_user_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId('audit'), actorUserId || null, action, entityType, entityId || null, JSON.stringify(details || {}), nowIso()).run();
}

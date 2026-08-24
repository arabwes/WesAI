import { bootstrap, getSession, login, logout } from '../../_lib/auth.js';
import { ApiError, json, readJson } from '../../_lib/http.js';
import {
  addItem, addUser, getCatalog, getEntries, getUsers, removeUser,
  setItemStatus, submitForm, updateEntry
} from '../../_lib/legacy.js';
import {
  cancelShift, confirmShift, copySchedule, deleteAvailability, deleteAvailabilityException, getAuditLog,
  getManagerSchedule, getMySchedule, markNotificationsRead, publishSchedule,
  replaceAvailability, requestOpenShift, reviewShiftRequest, reviewTimeOff, saveAvailability,
  saveAvailabilityException,
  saveShift, submitTimeOff
} from '../../_lib/scheduling.js';

const ACTIONS = {
  bootstrap: (request, payload, env) => bootstrap(payload, env),
  getCatalog,
  addItem,
  flagItem: (request, payload, env) => setItemStatus(request, payload, env, 'flagged'),
  discontinueItem: (request, payload, env) => setItemStatus(request, payload, env, 'discontinued'),
  restoreItem: (request, payload, env) => setItemStatus(request, payload, env, 'active'),
  submitForm,
  getEntries,
  updateEntry,
  getUsers,
  addUser,
  removeUser,
  getManagerSchedule,
  getMySchedule,
  saveShift,
  cancelShift,
  copySchedule,
  publishSchedule,
  saveAvailability,
  deleteAvailability,
  replaceAvailability,
  saveAvailabilityException,
  deleteAvailabilityException,
  submitTimeOff,
  reviewTimeOff,
  requestOpenShift,
  reviewShiftRequest,
  confirmShift,
  markNotificationsRead,
  getAuditLog
};

export async function onRequestGet({ request, env }) {
  if (!env.TEAM_DB) return json({ ok: false, error: 'database_not_configured' }, 503);
  const url = new URL(request.url);
  if (url.searchParams.get('health') === '1') {
    try {
      await env.TEAM_DB.prepare('SELECT 1 AS healthy').first();
      return json({ ok: true, service: 'shibam-team-api' });
    } catch {
      return json({ ok: false, error: 'database_unavailable' }, 503);
    }
  }
  const session = await getSession(request, {}, env);
  return session
    ? json({ ok: true, user: session })
    : json({ ok: false, error: 'session_expired' }, 401);
}

export async function onRequestPost({ request, env }) {
  if (!env.TEAM_DB) return json({ ok: false, error: 'database_not_configured' }, 503);
  try {
    const payload = await readJson(request);
    const action = String(payload.action || '');
    if (action === 'login') {
      const response = await login(request, payload, env);
      return json(response.result, 200, { 'Set-Cookie': response.cookie });
    }
    if (action === 'logout') {
      const response = await logout(request, payload, env);
      return json(response.result, 200, { 'Set-Cookie': response.cookie });
    }
    const handler = ACTIONS[action];
    if (!handler) throw new ApiError('unknown_action', 404);
    return json(await handler(request, payload, env));
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ ok: false, error: error.code, ...(error.details || {}) }, error.status);
    }
    console.error('team-api failure', error);
    return json({ ok: false, error: 'server_error' }, 500);
  }
}

// Public booking endpoint (no login). Every request is a POST with a JSON body
// so tokens never appear in API URLs or access logs.
//   getLink / getSlots / book           -> booking link token
//   getBooking / getManageSlots /
//   cancelBooking / rescheduleBooking   -> manage token from the confirmation email
import {
  cancelManagedBooking, createBooking, getAvailableSlots, getManagedBooking, getManagedSlots, linkView,
  rescheduleManagedBooking, resolveLink
} from '../_lib/calendar.js';
import { ApiError, json, readJson } from '../_lib/http.js';
import { rateLimitPublic } from '../_lib/public-rate-limit.js';
import { verifyTurnstile } from '../_lib/turnstile.js';

const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

const ACTIONS = {
  async getLink(request, payload, env) {
    const link = await resolveLink(env, payload.token);
    return { ok: true, event: linkView(link) };
  },
  getSlots: (request, payload, env) => getAvailableSlots(env, payload.token),
  async book(request, payload, env) {
    // Bots fill hidden fields. Answer as if it worked so they do not retry.
    if (String(payload.website || '').trim()) return { ok: true };
    await verifyTurnstile(payload.turnstileToken, request, env);
    return createBooking(env, payload.token, payload);
  },
  getBooking: (request, payload, env) => getManagedBooking(env, payload.manageToken),
  getManageSlots: (request, payload, env) => getManagedSlots(env, payload.manageToken),
  cancelBooking: (request, payload, env) => cancelManagedBooking(env, payload.manageToken, payload.reason),
  async rescheduleBooking(request, payload, env) {
    await verifyTurnstile(payload.turnstileToken, request, env);
    return rescheduleManagedBooking(env, payload.manageToken, payload.start);
  }
};

const SCOPE = {
  getLink: 'view', getSlots: 'view', getBooking: 'view', getManageSlots: 'view',
  book: 'book', rescheduleBooking: 'book', cancelBooking: 'manage'
};

export async function onRequestPost({ request, env }) {
  if (!env.TEAM_DB) return json({ ok: false, error: 'database_not_configured' }, 503, NO_INDEX);
  try {
    const payload = await readJson(request);
    const action = String(payload.action || '');
    if (!Object.hasOwn(ACTIONS, action)) throw new ApiError('unknown_action', 404);
    await rateLimitPublic(env, request, SCOPE[action]);
    const result = await ACTIONS[action](request, payload, env);
    // The raw tokens in a response are for the caller only; never cache them.
    return json(result, 200, NO_INDEX);
  } catch (error) {
    if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status, NO_INDEX);
    console.error('book api failure', error);
    return json({ ok: false, error: 'server_error' }, 500, NO_INDEX);
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method_not_allowed' }, 405, { ...NO_INDEX, Allow: 'POST' });
}

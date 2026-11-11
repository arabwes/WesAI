// Public endpoint for a catering customer's private conversation page (/inquiry/<token>).
// Every request is a POST with a JSON body so the token never appears in API URLs or logs.
import { getInquiryThread, replyToInquiry } from '../_lib/catering-conversation.js';
import { ApiError, json, readJson } from '../_lib/http.js';
import { rateLimitPublic } from '../_lib/public-rate-limit.js';
import { verifyTurnstile } from '../_lib/turnstile.js';

const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

const ACTIONS = {
  getThread: (request, payload, env) => getInquiryThread(env, payload.token),
  async reply(request, payload, env) {
    // Bots fill hidden fields. Answer as if it worked so they do not retry.
    if (String(payload.website || '').trim()) return { ok: true };
    await verifyTurnstile(payload.turnstileToken, request, env);
    return replyToInquiry(env, payload.token, payload.body);
  }
};

const SCOPE = { getThread: 'view', reply: 'manage' };

export async function onRequestPost({ request, env }) {
  if (!env.TEAM_DB) return json({ ok: false, error: 'database_not_configured' }, 503, NO_INDEX);
  try {
    const payload = await readJson(request);
    const action = String(payload.action || '');
    if (!Object.hasOwn(ACTIONS, action)) throw new ApiError('unknown_action', 404);
    await rateLimitPublic(env, request, SCOPE[action]);
    return json(await ACTIONS[action](request, payload, env), 200, NO_INDEX);
  } catch (error) {
    if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status, NO_INDEX);
    console.error('inquiry api failure', error);
    return json({ ok: false, error: 'server_error' }, 500, NO_INDEX);
  }
}

export function onRequest() {
  return json({ ok: false, error: 'method_not_allowed' }, 405, { ...NO_INDEX, Allow: 'POST' });
}

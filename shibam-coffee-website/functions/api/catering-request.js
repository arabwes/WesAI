import { submitCateringRequest } from '../_lib/catering.js';
import { ApiError, json } from '../_lib/http.js';

// Public, unauthenticated endpoint — the catering-events.html quote request
// form on the marketing site posts here directly, no team login involved.
export async function onRequestPost({ request, env }) {
  if (!env.TEAM_DB) return json({ ok: false, error: 'database_not_configured' }, 503);
  try {
    const form = await request.formData();
    const payload = Object.fromEntries(form.entries());
    const result = await submitCateringRequest(request, payload, env);
    return json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ ok: false, error: error.code, ...(error.details || {}) }, error.status);
    }
    console.error('catering-request failure', error);
    return json({ ok: false, error: 'server_error' }, 500);
  }
}

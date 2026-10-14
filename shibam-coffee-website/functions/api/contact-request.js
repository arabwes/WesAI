import { submitContactRequest } from '../_lib/contact.js';
import { ApiError, json } from '../_lib/http.js';

export async function onRequestPost({ request, env }) {
  if (!env.TEAM_DB) return json({ ok: false, error: 'database_not_configured' }, 503);
  try {
    const form = await request.formData();
    const result = await submitContactRequest(request, Object.fromEntries(form.entries()), env);
    return json(result);
  } catch (error) {
    if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status);
    console.error('contact-request failure', error);
    return json({ ok: false, error: 'server_error' }, 500);
  }
}

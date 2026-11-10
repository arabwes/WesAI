import { ApiError } from './http.js';

// Verifies a Cloudflare Turnstile token. When TURNSTILE_SECRET is not set (local
// development, or before keys are created) the check is skipped, matching the
// login form. Fails closed if Cloudflare cannot be reached.
export async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) throw new ApiError('turnstile_required', 400);
  let result;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('CF-Connecting-IP') || undefined,
        idempotency_key: crypto.randomUUID()
      })
    });
    result = await response.json();
  } catch {
    throw new ApiError('turnstile_unavailable', 503);
  }
  if (!result.success) throw new ApiError('turnstile_failed', 403);
}

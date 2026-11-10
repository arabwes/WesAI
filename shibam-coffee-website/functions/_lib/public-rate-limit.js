import { ApiError, sha256Hex } from './http.js';

// Fixed-window per-IP limiter for the public booking endpoints. The key is a
// hash of scope + IP + window, so the raw address is never stored.
export const PUBLIC_LIMITS = {
  view: { limit: 120, windowMinutes: 10 },
  book: { limit: 10, windowMinutes: 60 },
  manage: { limit: 30, windowMinutes: 60 }
};

export async function rateLimitPublic(env, request, scope, now = Date.now()) {
  const { limit, windowMinutes } = PUBLIC_LIMITS[scope];
  const windowMs = windowMinutes * 60_000;
  const bucket = Math.floor(now / windowMs);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = await sha256Hex(`${scope}:${ip}:${bucket}`);
  const expiresAt = new Date((bucket + 2) * windowMs).toISOString();
  await env.TEAM_DB.prepare(`INSERT INTO public_rate_limits (bucket_key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET hits = hits + 1`).bind(key, expiresAt).run();
  const row = await env.TEAM_DB.prepare('SELECT hits FROM public_rate_limits WHERE bucket_key = ?').bind(key).first();
  if (Number(row?.hits || 0) > limit) throw new ApiError('too_many_requests', 429);
  // Housekeeping: old windows are cheap to drop, so do it on a small share of requests.
  if (Math.random() < 0.02) {
    await env.TEAM_DB.prepare('DELETE FROM public_rate_limits WHERE expires_at < ?').bind(new Date(now).toISOString()).run();
  }
}

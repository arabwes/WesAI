function twiml(message) {
  const escaped = String(message || '').replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function validTwilioSignature(request, params, secret) {
  if (!secret) return false;
  const supplied = request.headers.get('X-Twilio-Signature') || '';
  let value = request.url;
  Array.from(params.keys()).sort().forEach((key) => { params.getAll(key).forEach((item) => { value += key + item; }); });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  let binary = '';
  new Uint8Array(signature).forEach((byte) => { binary += String.fromCharCode(byte); });
  const expected = btoa(binary);
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(supplied))
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

export async function onRequestPost({ request, env }) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 16 * 1024) return new Response('Payload too large', { status: 413 });
  const params = new URLSearchParams(await request.text());
  if (!(await validTwilioSignature(request, params, env.TWILIO_AUTH_TOKEN))) {
    return new Response('Forbidden', { status: 403 });
  }
  const phone = String(params.get('From') || '');
  const body = String(params.get('Body') || '').trim().toUpperCase();
  const stopWords = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
  if (stopWords.has(body)) {
    const now = new Date().toISOString();
    await env.TEAM_DB.batch([
      env.TEAM_DB.prepare(`INSERT INTO sms_opt_outs (phone_e164, reason, opted_out_at, opted_in_at)
        VALUES (?, ?, ?, NULL) ON CONFLICT(phone_e164) DO UPDATE SET reason = excluded.reason,
        opted_out_at = excluded.opted_out_at, opted_in_at = NULL`).bind(phone, body, now),
      env.TEAM_DB.prepare(`UPDATE user_notification_preferences SET enabled = 0, updated_at = ?
        WHERE channel = 'sms' AND user_id IN (SELECT id FROM users WHERE phone_e164 = ?)`).bind(now, phone)
    ]);
    return twiml('You will no longer receive Shibam Coffee team schedule texts. Reply START to opt in again.');
  }
  if (body === 'START') {
    const now = new Date().toISOString();
    await env.TEAM_DB.prepare('UPDATE sms_opt_outs SET opted_in_at = ? WHERE phone_e164 = ?').bind(now, phone).run();
    return twiml('Shibam Coffee team schedule texts are available again. Enable SMS categories in your portal settings.');
  }
  return twiml('Shibam Coffee team messages are notification-only. Reply STOP to unsubscribe.');
}

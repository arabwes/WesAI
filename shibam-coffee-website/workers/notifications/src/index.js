import { buildPushHTTPRequest } from '@pushforge/builder';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function notificationCategory(type) {
  if (String(type).includes('request') || String(type).includes('time_off') || String(type).includes('exchange')) return 'requests';
  if (String(type).includes('open_shift')) return 'open_shifts';
  if (String(type).includes('account') || String(type).includes('invite')) return 'account';
  return 'schedule';
}

function timeInZone(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit'
  }).format(new Date());
}

function isQuietNow(preference, timezone) {
  if (!preference?.quiet_start || !preference?.quiet_end || preference.quiet_start === preference.quiet_end) return false;
  const current = timeInZone(timezone);
  return preference.quiet_start < preference.quiet_end
    ? current >= preference.quiet_start && current < preference.quiet_end
    : current >= preference.quiet_start || current < preference.quiet_end;
}

async function responseSnippet(response) {
  const text = await response.text();
  return text.slice(0, 300);
}

async function sendEmail(notification, destination, env) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const link = notification.link ? new URL(notification.link, env.PORTAL_ORIGIN).toString() : `${env.PORTAL_ORIGIN}/team/schedule.html`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ShibamCoffeeTeam/2.0',
      'Idempotency-Key': notification.idempotency_key
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [destination],
      subject: notification.title,
      text: `${notification.message}\n\nOpen the team portal: ${link}`,
      html: `<p>Hi ${escapeHtml(notification.name)},</p><p>${escapeHtml(notification.message)}</p><p><a href="${escapeHtml(link)}">Open the team portal</a></p>`
    })
  });
  const body = await responseSnippet(response);
  if (!response.ok) throw new Error(`Resend ${response.status}: ${body}`);
  try { return JSON.parse(body).id || ''; } catch { return ''; }
}

async function sendSms(notification, destination, env) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || (!env.TWILIO_MESSAGING_SERVICE_SID && !env.TWILIO_FROM_NUMBER)) {
    throw new Error('Twilio SMS secrets are not configured');
  }
  const body = new URLSearchParams({ To: destination, Body: `${notification.title}: ${notification.message}` });
  if (env.TWILIO_MESSAGING_SERVICE_SID) body.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
  else body.set('From', env.TWILIO_FROM_NUMBER);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const result = await responseSnippet(response);
  if (!response.ok) throw new Error(`Twilio ${response.status}: ${result}`);
  try { return JSON.parse(result).sid || ''; } catch { return ''; }
}

async function sendPush(notification, destination, env) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) throw new Error('VAPID secrets are not configured');
  const subscription = await env.TEAM_DB.prepare(`SELECT * FROM push_subscriptions
    WHERE endpoint = ? AND active = 1`).bind(destination).first();
  if (!subscription) return { skipped: true, providerId: '' };
  let privateJWK;
  try { privateJWK = JSON.parse(env.VAPID_PRIVATE_JWK); } catch { throw new Error('VAPID_PRIVATE_JWK is invalid JSON'); }
  const link = notification.link || '/team/schedule.html';
  const pushRequest = await buildPushHTTPRequest({
    privateJWK,
    subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
    message: {
      payload: { title: notification.title, body: notification.message, icon: '/images/team-icon.svg', url: link },
      options: { ttl: 3600, urgency: 'normal', topic: String(notification.notification_type || 'schedule').slice(0, 32) },
      adminContact: env.VAPID_SUBJECT || 'mailto:yemenicoffeeco@gmail.com'
    }
  });
  const response = await fetch(pushRequest.endpoint, { method: 'POST', headers: pushRequest.headers, body: pushRequest.body });
  if (response.status === 404 || response.status === 410) {
    await env.TEAM_DB.prepare(`UPDATE push_subscriptions SET active = 0, last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(`Push endpoint returned ${response.status}`, new Date().toISOString(), subscription.id).run();
    return { skipped: true, providerId: '' };
  }
  if (!response.ok) throw new Error(`Web Push ${response.status}: ${await responseSnippet(response)}`);
  await env.TEAM_DB.prepare('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?')
    .bind(new Date().toISOString(), subscription.id).run();
  return { skipped: false, providerId: response.headers.get('location') || '' };
}

async function processDelivery(notification, delivery, env) {
  if (delivery.status === 'sent' || delivery.status === 'skipped') return { retry: false };
  const preference = await env.TEAM_DB.prepare(`SELECT * FROM user_notification_preferences
    WHERE user_id = ? AND channel = ? AND category = ?`).bind(notification.user_id, delivery.channel,
      notificationCategory(notification.notification_type)).first();
  if (preference && Number(preference.enabled) !== 1) {
    await env.TEAM_DB.prepare("UPDATE notification_deliveries SET status = 'skipped', last_error = 'Disabled by employee' WHERE id = ?")
      .bind(delivery.id).run();
    return { retry: false };
  }
  if (notificationCategory(notification.notification_type) !== 'account' && isQuietNow(preference, env.STORE_TIMEZONE)) {
    return { retry: true, quiet: true };
  }
  try {
    let providerId = '';
    let skipped = false;
    if (delivery.channel === 'email') providerId = await sendEmail(notification, delivery.destination, env);
    else if (delivery.channel === 'sms') providerId = await sendSms(notification, delivery.destination, env);
    else if (delivery.channel === 'push') ({ providerId, skipped } = await sendPush(notification, delivery.destination, env));
    const status = skipped ? 'skipped' : 'sent';
    await env.TEAM_DB.prepare(`UPDATE notification_deliveries SET status = ?, attempts = attempts + 1,
      provider_message_id = ?, last_error = NULL, sent_at = ? WHERE id = ?`)
      .bind(status, providerId || null, skipped ? null : new Date().toISOString(), delivery.id).run();
    return { retry: false };
  } catch (error) {
    await env.TEAM_DB.prepare(`UPDATE notification_deliveries SET status = 'failed', attempts = attempts + 1,
      last_error = ? WHERE id = ?`).bind(String(error).slice(0, 500), delivery.id).run();
    return { retry: true };
  }
}

async function sendNotification(message, env) {
  const notificationId = message.body?.notificationId;
  if (!notificationId) return false;
  const notification = await env.TEAM_DB.prepare(`SELECT n.*, u.email, u.name
    FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = ?`).bind(notificationId).first();
  if (!notification) return false;
  let { results: deliveries } = await env.TEAM_DB.prepare(`SELECT * FROM notification_deliveries
    WHERE notification_id = ? ORDER BY channel, created_at`).bind(notificationId).all();
  if (!deliveries.length && notification.email) {
    const deliveryId = `delivery_${crypto.randomUUID()}`;
    await env.TEAM_DB.prepare(`INSERT INTO notification_deliveries
      (id, notification_id, channel, destination, status, created_at) VALUES (?, ?, 'email', ?, 'pending', ?)`)
      .bind(deliveryId, notification.id, notification.email, new Date().toISOString()).run();
    deliveries = (await env.TEAM_DB.prepare('SELECT * FROM notification_deliveries WHERE id = ?').bind(deliveryId).all()).results;
  }
  let retry = false;
  let quiet = false;
  for (const delivery of deliveries) {
    const outcome = await processDelivery(notification, delivery, env);
    retry ||= outcome.retry;
    quiet ||= outcome.quiet;
  }
  const email = await env.TEAM_DB.prepare(`SELECT status, attempts, last_error, sent_at FROM notification_deliveries
    WHERE notification_id = ? AND channel = 'email' ORDER BY created_at LIMIT 1`).bind(notification.id).first();
  if (email) await env.TEAM_DB.prepare(`UPDATE notifications SET email_status = ?, email_attempts = ?,
    email_last_error = ?, sent_at = COALESCE(?, sent_at) WHERE id = ?`)
    .bind(email.status, email.attempts, email.last_error, email.sent_at, notification.id).run();
  return retry ? (quiet ? 3600 : 60) : false;
}

async function sendInvitation(message, env) {
  const invitation = await env.TEAM_DB.prepare(`SELECT * FROM user_invitations
    WHERE id = ? AND status = 'pending'`).bind(message.body?.invitationId).first();
  if (!invitation) return false;
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const token = String(message.body?.token || '');
  if (!token) throw new Error('Invitation token is missing from the queue message');
  if (String(message.body?.tokenHash || '') !== invitation.token_hash) return false;
  const deliveryKey = String(message.body?.deliveryKey || invitation.id).slice(0, 256);
  const link = `${env.PORTAL_ORIGIN}/team/accept-invitation.html?token=${encodeURIComponent(token)}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ShibamCoffeeTeam/2.0',
      'Idempotency-Key': deliveryKey
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [invitation.email],
      subject: 'You are invited to the Shibam Coffee team portal',
      text: `Hi ${invitation.name},\n\nCreate your team portal account: ${link}\n\nThis link expires in 72 hours.`,
      html: `<p>Hi ${escapeHtml(invitation.name)},</p><p>You have been invited to the Shibam Coffee team portal.</p><p><a href="${escapeHtml(link)}">Create your account</a></p><p>This link expires in 72 hours.</p>`
    })
  });
  const body = await responseSnippet(response);
  if (!response.ok) {
    await env.TEAM_DB.prepare('UPDATE user_invitations SET email_last_error = ? WHERE id = ?')
      .bind(`Resend ${response.status}: ${body}`, invitation.id).run();
    throw new Error(`Resend ${response.status}: ${body}`);
  }
  await env.TEAM_DB.prepare('UPDATE user_invitations SET email_sent_at = ?, email_last_error = NULL WHERE id = ?')
    .bind(new Date().toISOString(), invitation.id).run();
  return false;
}

function dateInTimezone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function addDateDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayForDate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const weekday = date.getUTCDay();
  return addDateDays(dateString, weekday === 0 ? -6 : 1 - weekday);
}

function toastBusinessDate(dateString) {
  return dateString.replaceAll('-', '');
}

async function toastAccessToken(env) {
  const response = await fetch('https://ws-api.toasttab.com/authentication/v1/authentication/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ShibamCoffeeTeam/2.0' },
    body: JSON.stringify({
      clientId: env.TOAST_CLIENT_ID,
      clientSecret: env.TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT'
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Toast authentication returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result?.token?.accessToken) throw new Error('Toast authentication did not return an access token');
  return result.token.accessToken;
}

async function toastOrdersForDay(env, accessToken, dateString) {
  const orders = [];
  for (let page = 1; page <= 50; page += 1) {
    const url = new URL('https://ws-api.toasttab.com/orders/v2/ordersBulk');
    url.searchParams.set('businessDate', toastBusinessDate(dateString));
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('page', String(page));
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Toast-Restaurant-External-ID': env.TOAST_RESTAURANT_GUID,
        'User-Agent': 'ShibamCoffeeTeam/2.0'
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Toast orders returned HTTP ${response.status}`);
    const pageOrders = await response.json();
    if (!Array.isArray(pageOrders)) throw new Error('Toast orders response was not an array');
    orders.push(...pageOrders);
    if (pageOrders.length < 100) break;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  return orders;
}

function hourInTimezone(value, timezone) {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/New_York', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(parsed);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) return hour;
  }
  const fallback = String(value || '').match(/T(\d{2}):/u);
  return fallback ? Number(fallback[1]) : null;
}

export function aggregateToastHourlySales(dateString, orders, timezone = 'America/New_York') {
  const hourly = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (order?.voided === true || order?.deleted === true) continue;
    const hour = hourInTimezone(order?.openedDate, timezone);
    if (hour === null) continue;
    let orderCents = 0;
    for (const check of Array.isArray(order.checks) ? order.checks : []) {
      if (check?.voided === true || check?.deleted === true || !['PAID', 'CLOSED'].includes(check?.paymentStatus)) continue;
      const amount = Number(check.amount);
      if (Number.isFinite(amount)) orderCents += Math.round(amount * 100);
    }
    if (!orderCents) continue;
    const current = hourly.get(hour) || { businessDate: dateString, hour, netSalesCents: 0, orderCount: 0 };
    current.netSalesCents += orderCents;
    current.orderCount += 1;
    hourly.set(hour, current);
  }
  return [...hourly.values()].sort((left, right) => left.hour - right.hour);
}

async function syncToastSales(env, force = false) {
  if (!env.TOAST_CLIENT_ID || !env.TOAST_CLIENT_SECRET || !env.TOAST_RESTAURANT_GUID) {
    console.log(JSON.stringify({ event: 'toast_sales_sync_skipped', reason: 'credentials_not_configured' }));
    return;
  }
  const today = dateInTimezone(new Date(), env.STORE_TIMEZONE);
  const currentMonday = mondayForDate(today);
  const periodStart = addDateDays(currentMonday, -21);
  const periodEnd = addDateDays(currentMonday, -1);
  const existing = await env.TEAM_DB.prepare(`SELECT * FROM toast_sales_sync_state WHERE location_id = 'atlanta'`).first();
  const syncHours = Math.max(1, Number(env.TOAST_SALES_SYNC_HOURS || 12));
  if (!force && existing?.status === 'ready' && existing.period_start === periodStart && existing.period_end === periodEnd &&
      Date.now() - Date.parse(existing.last_synced_at || '') < syncHours * 3600 * 1000) return;

  const startedAt = new Date().toISOString();
  await env.TEAM_DB.prepare(`INSERT INTO toast_sales_sync_state
      (location_id, period_start, period_end, completed_weeks, status, last_synced_at, last_error, updated_at)
    VALUES ('atlanta', ?, ?, 3, 'syncing', NULL, NULL, ?)
    ON CONFLICT(location_id) DO UPDATE SET period_start = excluded.period_start, period_end = excluded.period_end,
      completed_weeks = 3, status = 'syncing', last_error = NULL, updated_at = excluded.updated_at`)
    .bind(periodStart, periodEnd, startedAt).run();
  try {
    const accessToken = await toastAccessToken(env);
    const rows = [];
    for (let offset = 0; offset < 21; offset += 1) {
      const businessDate = addDateDays(periodStart, offset);
      rows.push(...aggregateToastHourlySales(
        businessDate,
        await toastOrdersForDay(env, accessToken, businessDate),
        env.STORE_TIMEZONE
      ));
      if (offset < 20) await new Promise((resolve) => setTimeout(resolve, 125));
    }
    const syncedAt = new Date().toISOString();
    await env.TEAM_DB.prepare('DELETE FROM toast_hourly_sales WHERE business_date BETWEEN ? AND ?')
      .bind(periodStart, periodEnd).run();
    const inserts = rows.map((row) => env.TEAM_DB.prepare(`INSERT INTO toast_hourly_sales
      (business_date, hour, net_sales_cents, order_count, synced_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(row.businessDate, row.hour, row.netSalesCents, row.orderCount, syncedAt));
    for (let index = 0; index < inserts.length; index += 50) await env.TEAM_DB.batch(inserts.slice(index, index + 50));
    await env.TEAM_DB.prepare(`UPDATE toast_sales_sync_state SET status = 'ready', last_synced_at = ?,
      last_error = NULL, updated_at = ? WHERE location_id = 'atlanta'`).bind(syncedAt, syncedAt).run();
    console.log(JSON.stringify({ event: 'toast_sales_sync_complete', periodStart, periodEnd, rows: rows.length }));
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.TEAM_DB.prepare(`UPDATE toast_sales_sync_state SET status = 'error', last_error = ?, updated_at = ?
      WHERE location_id = 'atlanta'`).bind(String(error).slice(0, 350), failedAt).run();
    throw error;
  }
}

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const delay = message.body?.kind === 'invitation'
          ? await sendInvitation(message, env)
          : await sendNotification(message, env);
        if (delay) message.retry({ delaySeconds: delay });
        else message.ack();
      } catch (error) {
        console.error(JSON.stringify({ event: 'notification_delivery_failed', error: String(error), kind: message.body?.kind || 'notification' }));
        message.retry({ delaySeconds: 60 });
      }
    }
  },

  async scheduled(controller, env) {
    const now = new Date().toISOString();
    const localParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: env.STORE_TIMEZONE || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const part = (type) => localParts.find((item) => item.type === type)?.value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    await env.TEAM_DB.batch([
      env.TEAM_DB.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL').bind(now),
      env.TEAM_DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(now),
      env.TEAM_DB.prepare("UPDATE user_invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").bind(now),
      env.TEAM_DB.prepare("UPDATE shift_exchange_requests SET status = 'expired', review_note = 'The offered shift has passed.' WHERE status IN ('open', 'employee_accepted') AND offered_shift_id IN (SELECT id FROM shifts WHERE shift_date < ?)").bind(today),
      env.TEAM_DB.prepare('DELETE FROM phone_verifications WHERE expires_at < ? AND verified_at IS NULL').bind(now)
    ]);
    await syncToastSales(env);
    console.log(JSON.stringify({ event: 'scheduled_cleanup_complete', at: now }));
  }
};

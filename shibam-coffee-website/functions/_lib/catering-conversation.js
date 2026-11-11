// Catering request conversations. Staff (Lead+) reply from the portal; the customer reads and
// answers on a private page (/inquiry/<token>). Nothing is sent or received through personal
// email or phone: the customer's email only ever says "you have a message" plus the link.
//
// Three kinds of message live in catering_messages:
//   staff    a message from the team, shown to the customer
//   customer a reply from the customer
//   note     an internal note for staff only; never shown or sent to the customer
import { audit, requireRole } from './auth.js';
import { ApiError, newId, nowIso, sha256Hex } from './http.js';
import { notifyUser } from './scheduling.js';

const MAX_BODY = 4000;
const MAX_CUSTOMER_MESSAGES_PER_DAY = 20;

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cleanBody(value) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  if (!text) throw new ApiError('message_required', 400);
  if (text.length > MAX_BODY) throw new ApiError('message_too_long', 400);
  return text;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function staffMessageDto(row, wasUnread = false) {
  return {
    id: row.id,
    kind: row.kind,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    unread: wasUnread,
    emailed: !!row.emailed_at
  };
}

// What the customer is allowed to see: no internal notes, no staff surnames or accounts.
function customerMessageDto(row) {
  const mine = row.kind === 'customer';
  return {
    id: row.id,
    from: mine ? 'you' : 'team',
    authorName: mine ? 'You' : (firstName(row.author_name) || 'Shibam Coffee'),
    body: row.body,
    createdAt: row.created_at
  };
}

function linkUrl(request, env, token) {
  const origin = env.PUBLIC_SITE_URL ? String(env.PUBLIC_SITE_URL).replace(/\/+$/, '') : new URL(request.url).origin;
  return `${origin}/inquiry/${token}`;
}

async function loadRequest(env, requestId) {
  const row = await env.TEAM_DB.prepare('SELECT * FROM catering_requests WHERE id = ?').bind(String(requestId || '')).first();
  if (!row) throw new ApiError('not_found', 404);
  return row;
}

function requestSummary(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    eventType: row.event_type,
    eventDate: row.event_date || '',
    guestCount: row.guest_count === null ? null : Number(row.guest_count),
    details: row.details || '',
    status: row.status
  };
}

// ---- staff (Lead+) ----

// Loads a conversation. A person opening it marks the customer's replies as read; the AI
// connector reads with markRead:false so it never clears the team's unread badges.
export async function readCateringThread(env, requestId, { markRead }) {
  const row = await loadRequest(env, requestId);
  const { results } = await env.TEAM_DB.prepare(
    'SELECT * FROM catering_messages WHERE request_id = ? ORDER BY created_at, rowid'
  ).bind(row.id).all();
  if (markRead) {
    await env.TEAM_DB.prepare(`UPDATE catering_messages SET read_at = ?
      WHERE request_id = ? AND kind = 'customer' AND read_at IS NULL`).bind(nowIso(), row.id).run();
  }
  return { row, messages: results.map((message) => staffMessageDto(message, message.kind === 'customer' && !message.read_at)) };
}

// Opens a conversation in the portal.
export async function getCateringThread(request, payload, env) {
  await requireRole(request, payload, env, 'lead');
  const { row, messages } = await readCateringThread(env, payload.requestId, { markRead: true });
  return {
    ok: true,
    request: requestSummary(row),
    messages,
    // The customer's private page, for staff who want to share it by phone or text.
    customerLink: row.thread_token ? linkUrl(request, env, row.thread_token) : null,
    assignedTo: row.assigned_to || null
  };
}

// Sends a reply to the customer, or saves an internal note when `internal` is true.
export async function sendCateringMessage(request, payload, env) {
  const actor = await requireRole(request, payload, env, 'lead');
  const db = env.TEAM_DB;
  const row = await loadRequest(env, payload.requestId);
  const body = cleanBody(payload.body);
  const internal = payload.internal === true;
  const id = newId('cmsg');
  const now = nowIso();

  if (internal) {
    await db.prepare(`INSERT INTO catering_messages (id, request_id, kind, author_user_id, author_name, body, created_at)
      VALUES (?, ?, 'note', ?, ?, ?, ?)`).bind(id, row.id, actor.id, actor.name, body, now).run();
    await audit(db, actor.id, 'catering.note', 'catering_request', row.id, {});
    return { ok: true, message: staffMessageDto({ id, kind: 'note', author_name: actor.name, body, created_at: now }), emailQueued: false };
  }

  // The customer's private link is created the first time we write to them. A second reply
  // racing the first cannot replace it: the update only fills an empty token.
  let token = row.thread_token;
  if (!token) {
    const fresh = randomToken();
    await db.prepare(`UPDATE catering_requests SET thread_token = ?, thread_token_hash = ?
      WHERE id = ? AND thread_token IS NULL`).bind(fresh, await sha256Hex(fresh), row.id).run();
    token = (await db.prepare('SELECT thread_token FROM catering_requests WHERE id = ?').bind(row.id).first()).thread_token;
  }

  await db.batch([
    db.prepare(`INSERT INTO catering_messages (id, request_id, kind, author_user_id, author_name, body, created_at)
      VALUES (?, ?, 'staff', ?, ?, ?, ?)`).bind(id, row.id, actor.id, actor.name, body, now),
    db.prepare(`UPDATE catering_requests SET assigned_to = COALESCE(assigned_to, ?), last_message_at = ?, updated_at = ?,
      status = CASE WHEN status IN ('new', 'closed') THEN 'reviewed' ELSE status END WHERE id = ?`).bind(actor.id, now, now, row.id)
  ]);
  await audit(db, actor.id, 'catering.reply', 'catering_request', row.id, {});

  // The email never includes the message itself, only a notice and the private link.
  let emailQueued = false;
  if (env.NOTIFICATIONS?.send) {
    try {
      await env.NOTIFICATIONS.send({ kind: 'catering_message', messageId: id, deliveryKey: `catering:${id}` });
      emailQueued = true;
    } catch (error) {
      console.error('catering message email enqueue failed', String(error));
    }
  }
  return {
    ok: true,
    message: staffMessageDto({ id, kind: 'staff', author_name: actor.name, body, created_at: now }),
    emailQueued,
    customerLink: linkUrl(request, env, token)
  };
}

// ---- the customer (no login; the private token is the only key) ----

async function loadByToken(env, token) {
  // Wrong, malformed and unknown tokens all answer the same way.
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new ApiError('thread_not_found', 404);
  const row = await env.TEAM_DB.prepare('SELECT * FROM catering_requests WHERE thread_token_hash = ?').bind(await sha256Hex(token)).first();
  if (!row) throw new ApiError('thread_not_found', 404);
  return row;
}

export async function getInquiryThread(env, token) {
  const row = await loadByToken(env, token);
  const { results } = await env.TEAM_DB.prepare(
    "SELECT * FROM catering_messages WHERE request_id = ? AND kind IN ('staff', 'customer') ORDER BY created_at, rowid"
  ).bind(row.id).all();
  return {
    ok: true,
    request: {
      firstName: firstName(row.name),
      eventType: row.event_type,
      eventDate: row.event_date || '',
      guestCount: row.guest_count === null ? null : Number(row.guest_count),
      details: row.details || '',
      submittedAt: row.created_at
    },
    messages: results.map(customerMessageDto)
  };
}

export async function replyToInquiry(env, token, rawBody) {
  const row = await loadByToken(env, token);
  const body = cleanBody(rawBody);
  const db = env.TEAM_DB;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const recent = await db.prepare(`SELECT COUNT(*) AS n FROM catering_messages
    WHERE request_id = ? AND kind = 'customer' AND created_at > ?`).bind(row.id, since).first();
  if (recent.n >= MAX_CUSTOMER_MESSAGES_PER_DAY) throw new ApiError('too_many_messages', 429);

  const id = newId('cmsg');
  const now = nowIso();
  await db.batch([
    db.prepare(`INSERT INTO catering_messages (id, request_id, kind, author_name, body, created_at)
      VALUES (?, ?, 'customer', ?, ?, ?)`).bind(id, row.id, row.name, body, now),
    // A reply brings a closed request back to the team's attention.
    db.prepare(`UPDATE catering_requests SET last_message_at = ?, updated_at = ?,
      status = CASE WHEN status = 'closed' THEN 'reviewed' ELSE status END WHERE id = ?`).bind(now, now, row.id)
  ]);
  await audit(db, null, 'catering.customer_reply', 'catering_request', row.id, {});
  await notifyStaffOfReply(env, row, id);
  return { ok: true, message: customerMessageDto({ id, kind: 'customer', author_name: row.name, body, created_at: now }) };
}

// The staff member who has been handling the request hears first. If nobody has, or they are
// no longer active, every active manager is told, so a reply is never unseen.
async function notifyStaffOfReply(env, row, messageId) {
  try {
    const assigned = row.assigned_to
      ? await env.TEAM_DB.prepare('SELECT id FROM users WHERE id = ? AND active = 1').bind(row.assigned_to).first()
      : null;
    const recipients = assigned
      ? [assigned.id]
      : (await env.TEAM_DB.prepare("SELECT id FROM users WHERE role = 'management' AND active = 1").all()).results.map((user) => user.id);
    for (const userId of recipients) {
      await notifyUser(env, userId, 'catering_request_message', 'New catering reply',
        `A customer replied about their ${row.event_type} request. Open Catering Requests to read it.`,
        '/team/catering-requests', `catering:${messageId}:${userId}`);
    }
  } catch (error) {
    console.error('catering reply notification failed', String(error));
  }
}

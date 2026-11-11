// Catering request conversations: staff reply in the portal, the customer answers on a private
// page, and nothing internal ever reaches the customer. Real handlers, real SQLite, real router.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import { getCateringRequests, submitCateringRequest } from '../functions/_lib/catering.js';
import { getCateringThread, getInquiryThread, replyToInquiry, sendCateringMessage } from '../functions/_lib/catering-conversation.js';
import { onRequestPost as inquiryApi, onRequest as inquiryOther } from '../functions/api/inquiry.js';
import { onRequestPost as teamApi } from '../functions/api/team/index.js';
import { buildCateringMessageEmail } from '../workers/notifications/src/catering-email.js';
import worker from '../workers/notifications/src/index.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const code = (status, error) => (e) => e.status === status && e.code === error;
const SECRET_REPLY = 'Quote is $480 for 40 guests, deposit by Friday.';

async function setup(extraEnv = {}) {
  const db = createTestDatabase(MIGRATIONS);
  const sent = [];
  const env = {
    TEAM_DB: db, STORE_TIMEZONE: 'America/New_York', NOTIFICATIONS: { send: async (m) => { sent.push(m); } },
    RESEND_API_KEY: 're_test', EMAIL_FROM: 'Shibam <schedule@shibamatlanta.com>', PORTAL_ORIGIN: 'https://shibamatlanta.com', ...extraEnv
  };
  const req = {
    barista: addUserWithSession(db, { id: 'u_barista', username: 'bea', name: 'Bea Barista', role: 'barista' }),
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  db.raw.prepare("UPDATE users SET email = 'ana@example.com' WHERE id = 'u_leada'").run();
  const submit = async (extra = {}) => (await submitCateringRequest(new Request('https://x.test'), {
    name: 'Casey Customer', email: 'casey@example.com', phone: '555-0123', eventType: 'Corporate', eventDate: '2026-12-10',
    guestCount: '40', details: 'Coffee and dessert for a team lunch.', ...extra
  }, env)).requestId;
  return { db, env, req, sent, submit };
}

const tokenOf = (db, requestId) => db.raw.prepare('SELECT thread_token FROM catering_requests WHERE id = ?').get(requestId).thread_token;

// ---------------- staff side ----------------

test('only Lead+ can open or send; baristas and signed-out visitors are refused', async () => {
  const { env, req, submit } = await setup();
  const requestId = await submit();
  for (const [handler, payload] of [[getCateringThread, { requestId }], [sendCateringMessage, { requestId, body: 'hi' }]]) {
    await assert.rejects(handler(req.barista, payload, env), code(403, 'forbidden'), handler.name);
    await assert.rejects(handler(new Request('https://portal.test/'), payload, env), code(401, 'session_expired'), handler.name);
  }
});

test('the first reply creates the customer\'s private link, claims the request, and emails a notice (not the message)', async () => {
  const { env, req, db, sent, submit } = await setup();
  const requestId = await submit();
  assert.equal(tokenOf(db, requestId), null, 'no link until we write to them');
  const result = await sendCateringMessage(req.leadA, { requestId, body: SECRET_REPLY }, env);
  assert.equal(result.ok, true);
  assert.equal(result.emailQueued, true);
  const token = tokenOf(db, requestId);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.customerLink, `https://portal.test/inquiry/${token}`);
  const row = db.raw.prepare('SELECT * FROM catering_requests WHERE id = ?').get(requestId);
  assert.equal(row.assigned_to, 'u_leada');
  assert.equal(row.status, 'reviewed', 'a reply moves a new request to reviewed');
  assert.ok(row.last_message_at);
  assert.match(row.thread_token_hash, /^[0-9a-f]{64}$/);
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0], messageId: undefined }, { kind: 'catering_message', messageId: undefined, deliveryKey: `catering:${sent[0].messageId}` });
  assert.ok(!JSON.stringify(sent).includes(SECRET_REPLY), 'the queue message carries no text');
});

test('later replies keep the same link and the same owner; a closed request reopens', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'First' }, env);
  const token = tokenOf(db, requestId);
  db.raw.prepare("UPDATE catering_requests SET status = 'closed'").run();
  await sendCateringMessage(req.leadB, { requestId, body: 'Second, from a different lead' }, env);
  assert.equal(tokenOf(db, requestId), token);
  const row = db.raw.prepare('SELECT assigned_to, status FROM catering_requests').get();
  assert.deepEqual({ ...row }, { assigned_to: 'u_leada', status: 'reviewed' });
});

test('two replies racing to be first create one link and both messages survive', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await Promise.all([
    sendCateringMessage(req.leadA, { requestId, body: 'From Ana' }, env),
    sendCateringMessage(req.leadB, { requestId, body: 'From Ben' }, env)
  ]);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM catering_requests WHERE thread_token IS NOT NULL').get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'staff'").get().n, 2);
  const view = await getInquiryThread(env, tokenOf(db, requestId));
  assert.equal(view.messages.length, 2, 'the one link shows both');
});

test('message validation: empty, too long, control characters, newlines, unknown request', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await assert.rejects(sendCateringMessage(req.leadA, { requestId, body: '   \n ' }, env), /message_required/);
  await assert.rejects(sendCateringMessage(req.leadA, { requestId }, env), /message_required/);
  await assert.rejects(sendCateringMessage(req.leadA, { requestId, body: 'x'.repeat(4001) }, env), /message_too_long/);
  await sendCateringMessage(req.leadA, { requestId, body: 'x'.repeat(4000) }, env);
  await sendCateringMessage(req.leadA, { requestId, body: 'Line one\r\nLine two\u0000\u0007 end' }, env);
  assert.equal(db.raw.prepare("SELECT body FROM catering_messages ORDER BY rowid DESC LIMIT 1").get().body, 'Line one\nLine two end');
  await assert.rejects(sendCateringMessage(req.leadA, { requestId: 'nope', body: 'hi' }, env), code(404, 'not_found'));
  await assert.rejects(getCateringThread(req.leadA, { requestId: 'nope' }, env), code(404, 'not_found'));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM catering_messages').get().n, 2, 'rejected messages are not saved');
});

test('internal notes are team-only: never emailed, never create a link, never shown to the customer', async () => {
  const { env, req, db, sent, submit } = await setup();
  const requestId = await submit();
  const note = await sendCateringMessage(req.leadA, { requestId, body: 'INTERNAL: they were rude on the phone', internal: true }, env);
  assert.equal(note.emailQueued, false);
  assert.equal(sent.length, 0, 'nothing is queued for a note');
  assert.equal(tokenOf(db, requestId), null, 'a note does not create the customer link');
  assert.equal(db.raw.prepare('SELECT status FROM catering_requests').get().status, 'new', 'a note does not change the status');
  await sendCateringMessage(req.leadA, { requestId, body: SECRET_REPLY }, env);
  const publicView = JSON.stringify(await getInquiryThread(env, tokenOf(db, requestId)));
  assert.ok(!publicView.includes('INTERNAL'), 'the customer never sees internal notes');
  assert.ok(publicView.includes('Quote is $480'), 'but does see the reply');
  const staffView = await getCateringThread(req.leadB, { requestId }, env);
  assert.deepEqual(staffView.messages.map((m) => m.kind), ['note', 'staff'], 'every lead sees the note');
});

test('the thread opens for any Lead, in order, with the customer\'s details', async () => {
  const { env, req, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Hello Casey' }, env);
  const thread = await getCateringThread(req.leadB, { requestId }, env);
  assert.equal(thread.request.email, 'casey@example.com');
  assert.deepEqual(thread.messages.map((m) => [m.kind, m.authorName, m.body]), [['staff', 'Ana Lead', 'Hello Casey']]);
  assert.match(thread.customerLink, /^https:\/\/portal\.test\/inquiry\//);
});

// ---------------- the customer's page ----------------

test('the customer sees their request and the conversation, and nothing else about the team or system', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: SECRET_REPLY }, env);
  await sendCateringMessage(req.leadA, { requestId, body: 'INTERNAL budget is tight', internal: true }, env);
  const view = await getInquiryThread(env, tokenOf(db, requestId));
  assert.equal(view.request.firstName, 'Casey');
  assert.equal(view.request.eventType, 'Corporate');
  assert.deepEqual(view.messages.map((m) => [m.from, m.authorName]), [['team', 'Ana']], 'staff appear by first name only');
  const wire = JSON.stringify(view);
  for (const secret of ['ana@example.com', 'u_leada', 'Ana Lead', 'author_user_id', 'thread_token', 'casey@example.com', '555-0123', 'INTERNAL', requestId]) {
    assert.ok(!wire.includes(secret), `leaked ${secret}`);
  }
});

test('wrong, short, malformed and other customers\' links all answer the same way', async () => {
  const { env, req, db, submit } = await setup();
  const first = await submit();
  const second = await submit({ name: 'Dana Other', email: 'dana@example.com', details: 'Second event' });
  await sendCateringMessage(req.leadA, { requestId: first, body: 'For Casey only' }, env);
  await sendCateringMessage(req.leadA, { requestId: second, body: 'For Dana only' }, env);
  const tokenFirst = tokenOf(db, first);
  assert.ok(!JSON.stringify(await getInquiryThread(env, tokenFirst)).includes('Dana'));
  for (const token of ['x'.repeat(43), 'short', '', undefined, null, 42, tokenFirst.toLowerCase() === tokenFirst ? tokenFirst.toUpperCase() : tokenFirst.toLowerCase(), `${tokenFirst}x`, 'a'.repeat(200)]) {
    await assert.rejects(getInquiryThread(env, token), (e) => e.status === 404 && e.code === 'thread_not_found', String(token));
    await assert.rejects(replyToInquiry(env, token, 'hello'), code(404, 'thread_not_found'), String(token));
  }
});

test('a customer reply is saved, shown on both sides, and reopens a closed request', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Can you do Dec 10?' }, env);
  const token = tokenOf(db, requestId);
  db.raw.prepare("UPDATE catering_requests SET status = 'closed'").run();
  const result = await replyToInquiry(env, token, '  Yes, Dec 10 works.\n\nThanks!  ');
  assert.equal(result.message.from, 'you');
  assert.equal(result.message.body, 'Yes, Dec 10 works.\n\nThanks!');
  assert.equal(db.raw.prepare('SELECT status FROM catering_requests').get().status, 'reviewed');
  assert.deepEqual((await getInquiryThread(env, token)).messages.map((m) => m.from), ['team', 'you']);
  assert.deepEqual((await getCateringThread(req.leadA, { requestId }, env)).messages.map((m) => m.kind), ['staff', 'customer']);
  await assert.rejects(replyToInquiry(env, token, '   '), /message_required/);
  await assert.rejects(replyToInquiry(env, token, 'x'.repeat(4001)), /message_too_long/);
});

test('a reply tells the staff member handling it, and no one else', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Hello' }, env);
  await replyToInquiry(env, tokenOf(db, requestId), 'Thanks, here is more detail.');
  const rows = db.raw.prepare("SELECT user_id, message, link FROM notifications WHERE notification_type = 'catering_request_message'").all();
  assert.deepEqual(rows.map((r) => r.user_id), ['u_leada']);
  assert.equal(rows[0].link, '/team/catering-requests');
  assert.ok(!/Casey|casey@|555-0123/.test(rows[0].message), 'the notification holds no personal details');
});

test('if nobody has claimed the request, or they are gone, every manager is told', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Hello' }, env);
  const token = tokenOf(db, requestId);
  db.raw.prepare("UPDATE users SET active = 0 WHERE id = 'u_leada'").run(); // the owner left
  db.raw.prepare("INSERT INTO users (id, username, name, role, password_hash, password_salt, password_algorithm, active, created_at, updated_at) VALUES ('u_admin2','m2','Mia Manager','management','x','x','pbkdf2-sha256',1,'2026-01-01','2026-01-01')").run();
  await replyToInquiry(env, token, 'Anyone there?');
  const recipients = db.raw.prepare("SELECT user_id FROM notifications WHERE notification_type = 'catering_request_message' ORDER BY user_id").all().map((r) => r.user_id);
  assert.deepEqual(recipients, ['u_admin', 'u_admin2']);
});

test('a customer cannot flood the team: 20 messages a day per request', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Hello' }, env);
  const token = tokenOf(db, requestId);
  for (let i = 0; i < 20; i += 1) await replyToInquiry(env, token, `Message ${i}`);
  await assert.rejects(replyToInquiry(env, token, 'One too many'), code(429, 'too_many_messages'));
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'customer'").get().n, 20);
});

// ---------------- unread tracking and the list ----------------

test('unread replies are counted, shown first, and cleared when a lead opens the conversation', async () => {
  const { env, req, db, submit } = await setup();
  const quiet = await submit({ name: 'Quiet Person', email: 'quiet@example.com' });
  const busy = await submit({ name: 'Busy Person', email: 'busy@example.com' });
  await sendCateringMessage(req.leadA, { requestId: busy, body: 'Hello' }, env);
  await replyToInquiry(env, tokenOf(db, busy), 'First reply');
  await replyToInquiry(env, tokenOf(db, busy), 'Second reply');

  let list = await getCateringRequests(req.leadB, {}, env);
  assert.equal(list.unreadReplies, 1, 'one conversation has unread replies');
  assert.deepEqual(list.requests.map((r) => r.id), [busy, quiet], 'unread conversations come first');
  const row = list.requests[0];
  assert.deepEqual([row.unreadCount, row.messageCount, row.assignedToName], [2, 3, 'Ana Lead']);
  assert.deepEqual([list.requests[1].unreadCount, list.requests[1].messageCount], [0, 0]);
  assert.equal((await getCateringRequests(req.leadB, { status: 'new' }, env)).unreadReplies, 1, 'the dashboard count ignores the status filter');

  const opened = await getCateringThread(req.leadB, { requestId: busy }, env);
  assert.deepEqual(opened.messages.map((m) => m.unread), [false, true, true], 'the unread ones are flagged when opened');
  list = await getCateringRequests(req.leadB, {}, env);
  assert.equal(list.unreadReplies, 0);
  assert.equal(list.requests.find((r) => r.id === busy).unreadCount, 0);
  assert.equal((await getCateringThread(req.leadA, { requestId: busy }, env)).messages.every((m) => !m.unread), true, 'and not flagged again');
});

test('the list never carries the customer\'s private link', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Hello' }, env);
  const wire = JSON.stringify(await getCateringRequests(req.leadA, {}, env));
  assert.ok(!wire.includes(tokenOf(db, requestId)));
  assert.ok(!wire.includes('thread_token'));
});

test('requests that existed before conversations were added still list and open', async () => {
  const { env, req, db } = await setup();
  db.raw.prepare(`INSERT INTO catering_requests (id, name, email, phone, event_type, details, status, created_at)
    VALUES ('old1', 'Older Customer', 'old@example.com', '555-0000', 'Wedding', 'Old request', 'reviewed', '2026-01-01T00:00:00.000Z')`).run();
  const list = await getCateringRequests(req.leadA, {}, env);
  assert.deepEqual([list.requests[0].messageCount, list.requests[0].unreadCount, list.requests[0].assignedToName], [0, 0, '']);
  const thread = await getCateringThread(req.leadA, { requestId: 'old1' }, env);
  assert.deepEqual([thread.messages.length, thread.customerLink], [0, null]);
});

// ---------------- through the real router and public endpoint ----------------

test('end to end: staff reply through the router, the customer replies through the public endpoint, staff see it', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  const staff = async (who, action, body) => {
    const headers = new Headers(who.headers); headers.set('Content-Type', 'application/json');
    const r = await teamApi({ request: new Request('https://portal.test/api/team', { method: 'POST', headers, body: JSON.stringify({ action, ...body }) }), env });
    return { status: r.status, body: await r.json() };
  };
  const customer = async (body, ip = '203.0.113.5') => {
    const r = await inquiryApi({ request: new Request('https://shibamatlanta.com/api/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }), env });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  assert.equal((await staff(req.barista, 'sendCateringMessage', { requestId, body: 'hi' })).status, 403);
  assert.equal((await staff(req.leadA, 'sendCateringMessage', { requestId, body: 'Hi Casey, what date works?' })).status, 200);
  const token = tokenOf(db, requestId);

  const view = await customer({ action: 'getThread', token });
  assert.equal(view.status, 200);
  assert.equal(view.body.messages[0].body, 'Hi Casey, what date works?');
  assert.equal(view.headers.get('Cache-Control'), 'no-store');
  assert.match(view.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal(view.headers.get('Referrer-Policy'), 'no-referrer');

  assert.equal((await customer({ action: 'reply', token, body: 'December 10th.' })).status, 200);
  const list = await staff(req.admin, 'getCateringRequests', {});
  assert.equal(list.body.unreadReplies, 1);
  const opened = await staff(req.admin, 'getCateringThread', { requestId });
  assert.deepEqual(opened.body.messages.map((m) => m.body), ['Hi Casey, what date works?', 'December 10th.']);

  assert.deepEqual([(await customer({ action: 'getThread', token: 'z'.repeat(43) })).status, (await customer({ action: 'getThread', token: 'z'.repeat(43) })).body.error], [404, 'thread_not_found']);
  assert.equal((await customer({ action: 'nope', token })).status, 404);
  assert.equal((await customer({ action: 'constructor', token })).status, 404, 'inherited object keys are not actions');
  assert.equal(inquiryOther().status, 405);
});

test('public reply protections: honeypot, Turnstile when configured, and per-visitor rate limits', async () => {
  const { env, req, db, submit } = await setup({ TURNSTILE_SECRET: 'secret' });
  const requestId = await submit();
  await sendCateringMessage(req.leadA, { requestId, body: 'Hello' }, env);
  const token = tokenOf(db, requestId);
  const call = async (body, ip = '203.0.113.9') => {
    const r = await inquiryApi({ request: new Request('https://shibamatlanta.com/api/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body) }), env });
    return { status: r.status, body: await r.json() };
  };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => new Response(JSON.stringify({ success: JSON.parse(init.body).response === 'good' }));
    assert.deepEqual(await call({ action: 'reply', token, body: 'bot', website: 'http://spam.example' }), { status: 200, body: { ok: true } });
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'customer'").get().n, 0, 'the honeypot saves nothing');
    assert.equal((await call({ action: 'reply', token, body: 'hi' })).body.error, 'turnstile_required');
    assert.equal((await call({ action: 'reply', token, body: 'hi', turnstileToken: 'bad' })).body.error, 'turnstile_failed');
    assert.equal((await call({ action: 'reply', token, body: 'hi', turnstileToken: 'good' })).status, 200);
    assert.equal((await call({ action: 'getThread', token })).status, 200, 'reading needs no security check');
  } finally {
    globalThis.fetch = realFetch;
  }
  const open = { ...env }; delete open.TURNSTILE_SECRET;
  // Someone guessing links is slowed down: the made-up tokens answer 404 until the visitor's budget runs out.
  let limited = null;
  let guesses = 0;
  for (; guesses < 60 && !limited; guesses += 1) {
    const r = await inquiryApi({ request: new Request('https://shibamatlanta.com/api/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.77' }, body: JSON.stringify({ action: 'reply', token: `${'g'.repeat(40)}${guesses}`, body: 'x' }) }), env: open });
    if (r.status === 429) limited = (await r.json()).error;
  }
  assert.equal(limited, 'too_many_requests', 'one visitor is slowed down');
  assert.ok(guesses > 5 && guesses <= 35, `after a sensible number of tries (${guesses})`);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'customer'").get().n, 1, 'no guessed link saved anything');
});

// ---------------- the email ----------------

test('the email is a notice with the private link and never contains the message', () => {
  const email = buildCateringMessageEmail({ name: 'Casey <b>Customer</b>', eventType: 'Corporate', eventDate: '2026-12-10', link: 'https://shibamatlanta.com/inquiry/abc' });
  assert.equal(email.subject, 'A message from Shibam Coffee about your catering request');
  assert.match(email.text, /Hi Casey,/);
  assert.match(email.text, /your corporate request for 2026-12-10/);
  assert.match(email.text, /https:\/\/shibamatlanta\.com\/inquiry\/abc/);
  assert.match(email.text, /reply on that page rather than by email/i);
  assert.ok(!email.html.includes('<b>'), 'the name is escaped');
  assert.match(email.html, /href="https:\/\/shibamatlanta\.com\/inquiry\/abc"/);
});

function queueMessage(body) { return { body, retried: null, retry(options) { this.retried = options; }, ack() {} }; }
async function runWorker(env, body, fetchImpl) {
  const realFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl() : new Response('{"id":"em_1"}'); };
  const message = queueMessage(body);
  try { await worker.queue({ messages: [message] }, env); } finally { globalThis.fetch = realFetch; }
  return { message, calls };
}

test('worker: emails the customer the link, marks it sent, and never repeats', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  const { message } = await sendCateringMessage(req.leadA, { requestId, body: SECRET_REPLY }, env);
  const token = tokenOf(db, requestId);
  const first = await runWorker(env, { kind: 'catering_message', messageId: message.id, deliveryKey: `catering:${message.id}` });
  assert.equal(first.calls.length, 1);
  const sentMail = first.calls[0];
  assert.equal(sentMail.url, 'https://api.resend.com/emails');
  assert.deepEqual(sentMail.body.to, ['casey@example.com']);
  assert.equal(sentMail.body.from, 'Shibam <schedule@shibamatlanta.com>');
  assert.equal(sentMail.body.reply_to, undefined, 'replies are steered to the page, not to a person');
  assert.equal(sentMail.init.headers['Idempotency-Key'], `catering:${message.id}`);
  assert.ok(sentMail.body.text.includes(`https://shibamatlanta.com/inquiry/${token}`));
  assert.ok(!JSON.stringify(sentMail.body).includes('Quote is $480'), 'the message text is not in the email');
  assert.ok(db.raw.prepare('SELECT emailed_at FROM catering_messages WHERE id = ?').get(message.id).emailed_at);
  assert.equal((await getCateringThread(req.leadA, { requestId }, env)).messages[0].emailed, true);
  assert.equal((await runWorker(env, { kind: 'catering_message', messageId: message.id })).calls.length, 0, 'a message already emailed is not sent again');
});

test('worker: skips notes and customer messages, retries failures, and retries when the email key is missing', async () => {
  const { env, req, db, submit } = await setup();
  const requestId = await submit();
  const note = await sendCateringMessage(req.leadA, { requestId, body: 'internal', internal: true }, env);
  const sent = await sendCateringMessage(req.leadA, { requestId, body: 'hello' }, env);
  const reply = await replyToInquiry(env, tokenOf(db, requestId), 'thanks');
  for (const id of [note.message.id, reply.message.id, 'missing', undefined]) {
    assert.equal((await runWorker(env, { kind: 'catering_message', messageId: id })).calls.length, 0, `skips ${id}`);
  }
  const failed = await runWorker(env, { kind: 'catering_message', messageId: sent.message.id }, () => new Response('boom', { status: 500 }));
  assert.equal(failed.message.retried.delaySeconds, 60);
  assert.equal(db.raw.prepare('SELECT emailed_at FROM catering_messages WHERE id = ?').get(sent.message.id).emailed_at, null, 'a failed send is not marked sent');
  const noKey = { ...env, RESEND_API_KEY: undefined };
  const retried = await runWorker(noKey, { kind: 'catering_message', messageId: sent.message.id });
  assert.equal(retried.calls.length, 0);
  assert.ok(retried.message.retried);
  assert.equal((await runWorker(env, { kind: 'catering_message', messageId: sent.message.id })).calls.length, 1, 'and goes out once the problem is fixed');
});

test('a failing email queue never loses the reply, and staff are told', async () => {
  const { env, req, db, submit } = await setup({ NOTIFICATIONS: { send: async () => { throw new Error('queue down'); } } });
  const requestId = await submit();
  const result = await sendCateringMessage(req.leadA, { requestId, body: 'Hello' }, env);
  assert.equal(result.ok, true);
  assert.equal(result.emailQueued, false);
  assert.match(result.customerLink, /\/inquiry\//, 'the link is still returned so staff can send it themselves');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'staff'").get().n, 1);
});

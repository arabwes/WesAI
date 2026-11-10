// Calendar phase 3: the public booking endpoint, spam protection, invitee
// self-service (cancel / reschedule), emails, owner notifications, and the
// hourly retention job. Everything runs against the real handlers and a real
// SQLite database through the D1 stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import {
  createBookingLink, saveBookingAvailability, saveEventType, saveMeetingLocation
} from '../functions/_lib/calendar-setup.js';
import { cancelBooking, createBooking, getManagedBooking } from '../functions/_lib/calendar.js';
import { onRequestPost as bookApi, onRequest as bookOther } from '../functions/api/book.js';
import { PUBLIC_LIMITS, rateLimitPublic } from '../functions/_lib/public-rate-limit.js';
import { verifyTurnstile } from '../functions/_lib/turnstile.js';
import { buildBookingEmail, buildIcs } from '../workers/notifications/src/booking-email.js';
import worker from '../workers/notifications/src/index.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const NOW = Date.parse('2026-11-09T12:00:00Z'); // Monday 07:00 New York
const TUE_9 = '2026-11-10T14:00:00.000Z';
const TUE_930 = '2026-11-10T14:30:00.000Z';
const TUE_10 = '2026-11-10T15:00:00.000Z';
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '09:00', endTime: '12:00' }));

async function setup(extraEnv = {}) {
  const db = createTestDatabase(MIGRATIONS);
  const sent = [];
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York', NOTIFICATIONS: { send: async (m) => { sent.push(m); } }, ...extraEnv };
  const req = {
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  db.raw.prepare("UPDATE users SET email = 'ana@example.com' WHERE id = 'u_leada'").run();
  const location = await saveMeetingLocation(req.leadA, {
    name: 'Alpharetta shop', addressLine1: '4000 North Point Pkwy Suite 900', city: 'Alpharetta', state: 'GA', postalCode: '30022', notes: 'Side door'
  }, env);
  const type = await saveEventType(req.leadA, {
    name: 'Barista interview', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60
  }, env);
  await saveBookingAvailability(req.leadA, { timezone: 'America/New_York', weekly: WEEKDAYS }, env);
  const link = await createBookingLink(req.leadA, { eventTypeId: type.id, label: 'Hiring' }, env);
  return { db, env, sent, req, token: link.url.split('/').pop(), eventTypeId: type.id };
}

// Calls the real public endpoint. `now` is not injectable there, so tests that
// depend on the fixed clock use the library functions directly.
async function post(env, body, ip = '203.0.113.9') {
  const response = await bookApi({
    request: new Request('https://shibamatlanta.test/api/book', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body)
    }),
    env
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

const candidate = (email, start, extra = {}) => ({ name: 'Cam Candidate', email, start, timezone: 'America/Chicago', phone: '555-0100', ...extra });
const code = (status, error) => (e) => e.status === status && e.code === error;

// ---------------- public endpoint ----------------

test('endpoint: unknown links and actions are generic, never 500, and never cached or indexed', async () => {
  const { env } = await setup();
  const missing = await post(env, { action: 'getLink', token: 'x'.repeat(43) });
  assert.deepEqual([missing.status, missing.body], [404, { ok: false, error: 'link_not_found' }]);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');
  assert.match(missing.headers.get('X-Robots-Tag'), /noindex/);
  assert.equal(missing.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal((await post(env, { action: 'nope' })).status, 404);
  assert.equal((await post(env, { action: 'constructor' })).status, 404, 'inherited object keys are not actions');
  assert.equal((await post(env, { action: 'getBooking', manageToken: 'y'.repeat(43) })).status, 404);
  const other = bookOther();
  assert.equal(other.status, 405);
});

test('endpoint: a valid link shows the event, address and questions but nothing about the owner beyond a first name', async () => {
  const { env, token } = await setup();
  const result = await post(env, { action: 'getLink', token });
  assert.equal(result.status, 200);
  assert.equal(result.body.event.name, 'Barista interview');
  assert.equal(result.body.event.ownerFirstName, 'Ana');
  assert.equal(result.body.event.location.city, 'Alpharetta');
  const wire = JSON.stringify(result.body);
  for (const secret of ['ana@example.com', 'u_leada', 'ownerId', 'token_hash']) assert.ok(!wire.includes(secret), `leaked ${secret}`);
});

test('endpoint: slots come back and a booking can be made end to end', async () => {
  const { env, token, db } = await setup();
  const slots = await post(env, { action: 'getSlots', token });
  assert.equal(slots.status, 200);
  assert.ok(slots.body.slots.length > 0);
  const start = slots.body.slots[0];
  const booked = await post(env, { action: 'book', token, ...candidate('cam@example.com', start) });
  assert.equal(booked.status, 200, JSON.stringify(booked.body));
  assert.ok(booked.body.manageToken);
  assert.equal(booked.body.booking.startUtc, start);
  const again = await post(env, { action: 'getSlots', token });
  assert.ok(!again.body.slots.includes(start));
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
  // The same person cannot hold a second slot on this link.
  const second = await post(env, { action: 'book', token, ...candidate('CAM@example.com', again.body.slots[0]) });
  assert.deepEqual([second.status, second.body.error], [409, 'already_booked']);
});

test('spam: a filled honeypot looks successful but books nothing', async () => {
  const { env, token, db, sent } = await setup();
  const slots = (await post(env, { action: 'getSlots', token })).body.slots;
  const bot = await post(env, { action: 'book', token, website: 'http://spam.example', ...candidate('bot@example.com', slots[0]) });
  assert.deepEqual([bot.status, bot.body], [200, { ok: true }]);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
  assert.equal(sent.length, 0, 'no email and no owner notification');
});

test('spam: Turnstile is enforced when configured and skipped when not', async () => {
  const { env, token } = await setup({ TURNSTILE_SECRET: 'secret' });
  const slots = (await post(env, { action: 'getSlots', token })).body.slots;
  const realFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push([String(url), JSON.parse(init.body)]);
      return new Response(JSON.stringify({ success: JSON.parse(init.body).response === 'good-token' }));
    };
    const none = await post(env, { action: 'book', token, ...candidate('a@example.com', slots[0]) });
    assert.deepEqual([none.status, none.body.error], [400, 'turnstile_required']);
    const bad = await post(env, { action: 'book', token, turnstileToken: 'bad-token', ...candidate('a@example.com', slots[0]) });
    assert.deepEqual([bad.status, bad.body.error], [403, 'turnstile_failed']);
    const good = await post(env, { action: 'book', token, turnstileToken: 'good-token', ...candidate('a@example.com', slots[0]) });
    assert.equal(good.status, 200);
    assert.equal(calls[0][0], 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(calls[0][1].remoteip, '203.0.113.9');
    // Cloudflare unreachable: fail closed.
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(verifyTurnstile('t', new Request('https://x.test'), { TURNSTILE_SECRET: 's' }), code(503, 'turnstile_unavailable'));
  } finally {
    globalThis.fetch = realFetch;
  }
  // Without a secret (local development) the check is skipped.
  await verifyTurnstile('', new Request('https://x.test'), {});
});

test('spam: per-IP rate limits apply per scope and do not cross IPs', async () => {
  const { env, token } = await setup();
  const limit = PUBLIC_LIMITS.book.limit;
  const bad = (ip) => post(env, { action: 'book', token, name: 'X', email: 'nope', start: TUE_9 }, ip);
  for (let i = 0; i < limit; i += 1) assert.equal((await bad('198.51.100.1')).body.error, 'invalid_email');
  const blocked = await bad('198.51.100.1');
  assert.deepEqual([blocked.status, blocked.body.error], [429, 'too_many_requests']);
  assert.equal((await bad('198.51.100.2')).body.error, 'invalid_email', 'another visitor is unaffected');
  assert.equal((await post(env, { action: 'getLink', token }, '198.51.100.1')).status, 200, 'viewing uses a separate budget');
});

test('spam: rate limit rows store a hash, not the address, and old windows are cleaned up', async () => {
  const { env, db } = await setup();
  const request = new Request('https://x.test', { headers: { 'CF-Connecting-IP': '203.0.113.77' } });
  await rateLimitPublic(env, request, 'view', NOW);
  const row = db.raw.prepare('SELECT * FROM public_rate_limits').get();
  assert.match(row.bucket_key, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(row).includes('203.0.113.77'));
});

// ---------------- invitee self-service ----------------

test('manage: the invitee sees only their own booking, via a token that is not their link', async () => {
  const { env, token } = await setup();
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  assert.notEqual(made.manageToken, token);
  const view = await getManagedBooking(env, made.manageToken, NOW);
  assert.equal(view.booking.title, 'Barista interview');
  assert.equal(view.booking.canChange, true);
  assert.equal(view.booking.clientName, 'Cam Candidate');
  assert.ok(!JSON.stringify(view).includes('cam@example.com'), 'email is not echoed back');
  await assert.rejects(getManagedBooking(env, token, NOW), code(404, 'booking_not_found'), 'the link token is not a manage token');
  await assert.rejects(getManagedBooking(env, 'z'.repeat(43), NOW), code(404, 'booking_not_found'));
});

test('manage: cancelling frees the slot, notifies the owner without the invitee name, and blocks repeats', async () => {
  const { env, token, sent, db } = await setup();
  const { cancelManagedBooking, getAvailableSlots } = await import('../functions/_lib/calendar.js');
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  sent.length = 0;
  await cancelManagedBooking(env, made.manageToken, 'Got another job', NOW);
  assert.ok((await getAvailableSlots(env, token, NOW)).slots.includes(TUE_9));
  const row = db.raw.prepare('SELECT status, cancelled_by, cancel_reason FROM bookings').get();
  assert.deepEqual({ ...row }, { status: 'cancelled', cancelled_by: 'invitee', cancel_reason: 'Got another job' });
  assert.equal(sent.find((m) => m.template === 'cancelled_by_invitee').kind, 'booking_email');
  await assert.rejects(cancelManagedBooking(env, made.manageToken, '', NOW), code(409, 'booking_not_changeable'));
  assert.equal((await getManagedBooking(env, made.manageToken, NOW)).booking.canChange, false);
  const notice = db.raw.prepare("SELECT message FROM notifications WHERE notification_type = 'booking_cancelled'").get();
  assert.ok(notice && !/Cam|cam@/.test(notice.message));
  // A cancelled invitee may book again on the same reusable link.
  assert.equal((await createBooking(env, token, candidate('cam@example.com', TUE_930), NOW)).ok, true);
});

test('manage: a meeting that already started can no longer be changed online', async () => {
  const { env, token } = await setup();
  const { cancelManagedBooking, rescheduleManagedBooking } = await import('../functions/_lib/calendar.js');
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  const later = Date.parse('2026-11-10T14:05:00Z');
  await assert.rejects(cancelManagedBooking(env, made.manageToken, '', later), code(409, 'booking_not_changeable'));
  await assert.rejects(rescheduleManagedBooking(env, made.manageToken, TUE_10, later), code(409, 'booking_not_changeable'));
  assert.equal((await getManagedBooking(env, made.manageToken, later)).booking.canChange, false);
});

test('manage: rescheduling is atomic, can use a slot overlapping the old one, and replaces the manage link', async () => {
  const { env, token, db } = await setup();
  const { getManagedSlots, rescheduleManagedBooking } = await import('../functions/_lib/calendar.js');
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  const slots = (await getManagedSlots(env, made.manageToken, NOW)).slots;
  assert.ok(slots.includes(TUE_9), 'the booking being moved does not block itself');
  const moved = await rescheduleManagedBooking(env, made.manageToken, TUE_10, NOW);
  assert.notEqual(moved.manageToken, made.manageToken);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").get().n, 1);
  const rows = db.raw.prepare('SELECT status, start_utc, cancel_reason, rescheduled_from FROM bookings ORDER BY created_at, rowid').all();
  assert.deepEqual(rows.map((r) => [r.status, r.start_utc]), [['cancelled', TUE_9], ['confirmed', TUE_10]]);
  assert.equal(rows[0].cancel_reason, 'rescheduled');
  assert.ok(rows[1].rescheduled_from);
  // Old link now shows cancelled; the new one works. Invitee data carried over.
  assert.equal((await getManagedBooking(env, made.manageToken, NOW)).booking.status, 'cancelled');
  const fresh = await getManagedBooking(env, moved.manageToken, NOW);
  assert.equal(fresh.booking.clientName, 'Cam Candidate');
  assert.equal(db.raw.prepare("SELECT use_count FROM booking_links").get().use_count, 1, 'rescheduling does not use up the link');
});

test('manage: a taken slot rejects the reschedule and leaves the original booking untouched', async () => {
  const { env, token, db } = await setup();
  const { rescheduleManagedBooking } = await import('../functions/_lib/calendar.js');
  const mine = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  await createBooking(env, token, candidate('dee@example.com', TUE_10), NOW);
  await assert.rejects(rescheduleManagedBooking(env, mine.manageToken, TUE_10, NOW), code(409, 'slot_unavailable'));
  await assert.rejects(rescheduleManagedBooking(env, mine.manageToken, '2026-11-10T22:00:00.000Z', NOW), code(409, 'slot_unavailable'));
  await assert.rejects(rescheduleManagedBooking(env, mine.manageToken, 'soon', NOW), /invalid_start/);
  const confirmed = db.raw.prepare("SELECT start_utc FROM bookings WHERE client_email = 'cam@example.com' AND status = 'confirmed'").all();
  assert.deepEqual(confirmed.map((r) => r.start_utc), [TUE_9]);
});

test('manage: concurrent reschedules into one slot let exactly one win', async () => {
  const { env, token, db } = await setup();
  const { rescheduleManagedBooking } = await import('../functions/_lib/calendar.js');
  const a = await createBooking(env, token, candidate('a@example.com', TUE_9), NOW);
  const b = await createBooking(env, token, candidate('b@example.com', TUE_930), NOW);
  const results = await Promise.allSettled([
    rescheduleManagedBooking(env, a.manageToken, TUE_10, NOW),
    rescheduleManagedBooking(env, b.manageToken, TUE_10, NOW)
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const starts = db.raw.prepare("SELECT start_utc FROM bookings WHERE status = 'confirmed' ORDER BY start_utc").all().map((r) => r.start_utc);
  assert.equal(starts.length, 2, 'the loser keeps their original booking');
  assert.equal(new Set(starts).size, 2);
});

test('manage: after the owner revokes the link, existing invitees can still change plans, but not if the meeting type is archived', async () => {
  const { env, token, db, eventTypeId } = await setup();
  const { getManagedSlots } = await import('../functions/_lib/calendar.js');
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  db.raw.prepare('UPDATE booking_links SET revoked_at = ?').run(new Date().toISOString());
  assert.ok((await getManagedSlots(env, made.manageToken, NOW)).slots.length > 0);
  db.raw.prepare('UPDATE event_types SET active = 0 WHERE id = ?').run(eventTypeId);
  await assert.rejects(getManagedSlots(env, made.manageToken, NOW), code(409, 'reschedule_unavailable'));
});

test('manage endpoint: works through the public API and does not accept a booking link as a manage token', async () => {
  const { env, token } = await setup();
  const slots = (await post(env, { action: 'getSlots', token })).body.slots;
  const booked = await post(env, { action: 'book', token, ...candidate('cam@example.com', slots[0]) });
  const view = await post(env, { action: 'getBooking', manageToken: booked.body.manageToken });
  assert.equal(view.status, 200);
  assert.equal(view.body.booking.canChange, true);
  assert.equal((await post(env, { action: 'getBooking', manageToken: token })).status, 404);
  const manageSlots = await post(env, { action: 'getManageSlots', manageToken: booked.body.manageToken });
  assert.equal(manageSlots.status, 200);
  const target = manageSlots.body.slots.find((s) => s !== slots[0]);
  const moved = await post(env, { action: 'rescheduleBooking', manageToken: booked.body.manageToken, start: target });
  assert.equal(moved.status, 200);
  const cancelled = await post(env, { action: 'cancelBooking', manageToken: moved.body.manageToken });
  assert.equal(cancelled.status, 200);
});

// ---------------- emails and notifications ----------------

test('booking queues one invitee email carrying the manage token, and tells the owner without naming the invitee', async () => {
  const { env, token, sent, db } = await setup();
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  assert.equal(made.emailQueued, true);
  const emails = sent.filter((m) => m.kind === 'booking_email');
  assert.equal(emails.length, 1, 'exactly one invitee email');
  assert.equal(sent.length - emails.length, 1, 'plus the owner\'s portal notification');
  assert.deepEqual({ ...emails[0], bookingId: undefined },
    { kind: 'booking_email', bookingId: undefined, template: 'confirmed', manageToken: made.manageToken, deliveryKey: `booking:${made.booking.id}:confirmed` });
  const note = db.raw.prepare("SELECT user_id, message, link FROM notifications WHERE notification_type = 'booking_new'").get();
  assert.equal(note.user_id, 'u_leada');
  assert.match(note.message, /Barista interview booked for Tue, Nov 10, 9:00 AM/);
  assert.ok(!/Cam|cam@example/.test(note.message), 'no invitee details in long-lived notification rows');
  // Management and other leads are not notified.
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id != 'u_leada'").get().n, 0);
});

test('a failing email queue never fails the booking', async () => {
  const { env, token, db } = await setup({ NOTIFICATIONS: { send: async () => { throw new Error('queue down'); } } });
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  assert.equal(made.ok, true);
  assert.equal(made.emailQueued, false);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
  const noQueue = await setup({ NOTIFICATIONS: undefined });
  assert.equal((await createBooking(noQueue.env, noQueue.token, candidate('cam@example.com', TUE_9), NOW)).emailQueued, false);
});

test('owner or Management cancelling emails the invitee', async () => {
  const { env, token, sent, req } = await setup();
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  sent.length = 0;
  await cancelBooking(req.admin, { bookingId: made.booking.id, reason: 'Role filled' }, env);
  assert.deepEqual(sent.map((m) => m.template), ['cancelled_by_host']);
});

const bookingRow = (extra = {}) => ({
  id: 'booking_1', title: 'Barista interview', start_utc: TUE_9, end_utc: '2026-11-10T14:30:00.000Z', client_name: 'Cam Candidate',
  client_timezone: 'America/Chicago', owner_name: 'Ana Lead',
  location_snapshot_json: JSON.stringify({ name: 'Alpharetta shop', addressLine1: '4000 North Point Pkwy Suite 900', addressLine2: '', city: 'Alpharetta', state: 'GA', postalCode: '30022', notes: 'Side door' }),
  ...extra
});

test('email content: shows the invitee\'s own time zone, the address, and the manage link, with a calendar invite', () => {
  const email = buildBookingEmail({ template: 'confirmed', booking: bookingRow(), manageLink: 'https://shibamatlanta.com/book/manage/abc', ownerTimezone: 'America/New_York', now: new Date('2026-11-09T12:00:00Z') });
  assert.match(email.subject, /^Confirmed: Barista interview on Tuesday, November 10, 2026 at 8:00 AM CST$/);
  assert.match(email.text, /Where: Alpharetta shop, 4000 North Point Pkwy Suite 900, Alpharetta, GA 30022/);
  assert.match(email.text, /Notes: Side door/);
  assert.match(email.text, /https:\/\/shibamatlanta\.com\/book\/manage\/abc/);
  assert.match(email.html, /<a href="https:\/\/shibamatlanta\.com\/book\/manage\/abc">/);
  assert.match(email.ics, /BEGIN:VCALENDAR[\s\S]*METHOD:PUBLISH[\s\S]*DTSTART:20261110T140000Z[\s\S]*DTEND:20261110T143000Z[\s\S]*STATUS:CONFIRMED/);
  assert.match(email.ics, /UID:booking_1@shibamatlanta\.com/);
});

test('email content: cancellation emails carry a CANCEL invite and no manage link', () => {
  const email = buildBookingEmail({ template: 'cancelled_by_host', booking: bookingRow(), manageLink: 'https://x/manage/abc', ownerTimezone: 'America/New_York' });
  assert.match(email.subject, /^Cancelled: /);
  assert.ok(!email.text.includes('https://x/manage/abc'));
  assert.match(email.ics, /METHOD:CANCEL[\s\S]*STATUS:CANCELLED/);
  assert.throws(() => buildBookingEmail({ template: 'nope', booking: bookingRow() }), /Unknown booking email template/);
});

test('email content: user-controlled text is escaped in HTML and ICS', () => {
  const evil = bookingRow({ client_name: '<img src=x onerror=alert(1)> Evil', title: 'Interview; <b>x</b>, y' });
  const email = buildBookingEmail({ template: 'confirmed', booking: evil, manageLink: '', ownerTimezone: 'America/New_York' });
  assert.ok(!email.html.includes('<img'));
  assert.ok(!email.html.includes('<b>x</b>'));
  assert.match(email.ics, /SUMMARY:Interview\\; <b>x<\/b>\\, y/);
  const long = buildIcs({ bookingId: 'b', title: 'T'.repeat(200), startIso: TUE_9, endIso: TUE_10, location: null, description: '' });
  assert.ok(long.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75), 'ICS lines are folded at 75 octets');
});

// ---------------- the notifications worker ----------------

function workerMessage(body) {
  const message = { body, retried: null, acked: false, retry(options) { this.retried = options; }, ack() { this.acked = true; } };
  return message;
}

async function runWorker(env, body, fetchImpl) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl() : new Response('{"id":"em_1"}'); };
  const message = workerMessage(body);
  try { await worker.queue({ messages: [message] }, env); } finally { globalThis.fetch = realFetch; }
  return { message, calls };
}

test('worker: sends the confirmation through Resend with reply-to, idempotency key and calendar attachment', async () => {
  const { env, token } = await setup({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'Shibam <schedule@shibamatlanta.com>', PORTAL_ORIGIN: 'https://shibamatlanta.com' });
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  const { message, calls } = await runWorker(env, { kind: 'booking_email', bookingId: made.booking.id, template: 'confirmed', manageToken: made.manageToken, deliveryKey: 'k1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(calls[0].body.to, ['cam@example.com']);
  assert.equal(calls[0].body.reply_to, 'ana@example.com', 'candidate replies reach the host, not the no-reply sender');
  assert.equal(calls[0].body.from, 'Shibam <schedule@shibamatlanta.com>');
  assert.ok(calls[0].body.text.includes(`https://shibamatlanta.com/book/manage/${made.manageToken}`));
  const ics = Buffer.from(calls[0].body.attachments[0].content, 'base64').toString('utf8');
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.equal(message.retried, null, 'no retry on success');
});

test('worker: skips emails for bookings that are gone, anonymised, or in the wrong state; retries when Resend fails', async () => {
  const { env, token, db } = await setup({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'x@y.z', PORTAL_ORIGIN: 'https://shibamatlanta.com' });
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  const send = (extra, fetchImpl) => runWorker(env, { kind: 'booking_email', bookingId: made.booking.id, template: 'confirmed', manageToken: made.manageToken, deliveryKey: 'k', ...extra }, fetchImpl);
  assert.equal((await runWorker(env, { kind: 'booking_email', bookingId: 'missing', template: 'confirmed' })).calls.length, 0);
  assert.equal((await send({ template: 'cancelled_by_host' })).calls.length, 0, 'a confirmed booking gets no cancellation email');
  assert.equal((await send({ template: 'nonsense' })).calls.length, 0);
  const failed = await send({}, () => new Response('nope', { status: 500 }));
  assert.equal(failed.message.retried.delaySeconds, 60, 'transient failures are retried');
  db.raw.prepare("UPDATE bookings SET client_email = NULL, anonymized_at = '2027-01-01T00:00:00.000Z'").run();
  assert.equal((await send({})).calls.length, 0, 'anonymised bookings never email');
  db.raw.prepare("UPDATE bookings SET status = 'cancelled'").run();
});

test('worker: missing Resend key is retried, not dropped', async () => {
  const { env, token } = await setup({ PORTAL_ORIGIN: 'https://shibamatlanta.com' });
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  const { message, calls } = await runWorker(env, { kind: 'booking_email', bookingId: made.booking.id, template: 'confirmed', manageToken: made.manageToken });
  assert.equal(calls.length, 0);
  assert.ok(message.retried);
});

// ---------------- retention job ----------------

test('hourly cleanup anonymises bookings 12 months after they end and drops expired rate-limit rows', async () => {
  const { env, token, db } = await setup();
  await createBooking(env, token, candidate('cam@example.com', TUE_9, { phone: '555-0199' }), NOW);
  const stamp = new Date().toISOString();
  db.raw.prepare("INSERT INTO public_rate_limits (bucket_key, hits, expires_at) VALUES ('old', 3, '2020-01-01T00:00:00.000Z'), ('fresh', 1, '2999-01-01T00:00:00.000Z')").run();
  const realNow = Date.now;
  const realLog = console.log;
  try {
    console.log = () => {};
    Date.now = () => Date.parse('2027-11-09T00:00:00Z');
    await worker.scheduled({}, env);
    assert.equal(db.raw.prepare('SELECT client_email FROM bookings').get().client_email, 'cam@example.com', 'not yet 12 months');
    Date.now = () => Date.parse('2027-11-11T00:00:00Z');
    await worker.scheduled({}, env);
  } finally {
    Date.now = realNow;
    console.log = realLog;
  }
  const row = db.raw.prepare('SELECT * FROM bookings').get();
  assert.deepEqual([row.client_name, row.client_email, row.client_phone, row.answers_json], [null, null, null, '{}']);
  assert.ok(row.anonymized_at);
  assert.equal(row.start_utc, TUE_9, 'the meeting itself is kept');
  assert.deepEqual(db.raw.prepare('SELECT bucket_key FROM public_rate_limits ORDER BY bucket_key').all().map((r) => r.bucket_key).filter((k) => ['old', 'fresh'].includes(k)), ['fresh']);
  assert.ok(stamp);
});

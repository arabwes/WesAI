// Calendar phase 5: 24-hour reminders, erase-on-request, and the complete
// lifecycle of a booking across the API, the worker and the database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import { createBookingLink, saveBookingAvailability, saveEventType, saveMeetingLocation } from '../functions/_lib/calendar-setup.js';
import { createBooking, eraseBookingData, getAvailableSlots, getManagedBooking, rescheduleManagedBooking, cancelManagedBooking } from '../functions/_lib/calendar.js';
import { buildBookingEmail } from '../workers/notifications/src/booking-email.js';
import worker from '../workers/notifications/src/index.js';
import { onRequestPost } from '../functions/api/team/index.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const NOW = Date.parse('2026-11-09T12:00:00Z'); // Monday 07:00 New York
const TUE_9 = '2026-11-10T14:00:00.000Z'; // Tuesday 09:00 New York
const TUE_930 = '2026-11-10T14:30:00.000Z';
const TUE_10 = '2026-11-10T15:00:00.000Z';
const code = (status, error) => (e) => e.status === status && e.code === error;

async function setup(extra = {}) {
  const db = createTestDatabase(MIGRATIONS);
  const env = {
    TEAM_DB: db, STORE_TIMEZONE: 'America/New_York', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Shibam <schedule@shibamatlanta.com>',
    PORTAL_ORIGIN: 'https://shibamatlanta.com', NOTIFICATIONS: { send: async () => {} }, ...extra
  };
  const req = {
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  db.raw.prepare("UPDATE users SET email = 'ana@example.com' WHERE id = 'u_leada'").run();
  const location = await saveMeetingLocation(req.leadA, { name: 'Shop', addressLine1: '1 Main St', city: 'Alpharetta', state: 'GA', postalCode: '30022' }, env);
  const type = await saveEventType(req.leadA, { name: 'Barista interview', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60 }, env);
  await saveBookingAvailability(req.leadA, { timezone: 'America/New_York', weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '09:00', endTime: '12:00' })) }, env);
  const link = await createBookingLink(req.leadA, { eventTypeId: type.id }, env);
  return { db, env, req, token: link.url.split('/').pop() };
}

const candidate = (email, start, extra = {}) => ({ name: 'Cam Candidate', email, start, timezone: 'America/Chicago', ...extra });

// Runs the hourly job with a controlled clock and a fake Resend.
async function runCron(env, nowMs, { failWith } = {}) {
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const calls = [];
  try {
    Date.now = () => nowMs;
    console.log = () => {};
    console.error = () => {};
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return failWith ? new Response('boom', { status: failWith }) : new Response('{"id":"em_1"}');
    };
    await worker.scheduled({}, env);
  } finally {
    Date.now = realNow; globalThis.fetch = realFetch; console.log = realLog; console.error = realError;
  }
  return calls;
}

// Make a booking look as though it was made well in advance, so a reminder is due.
const madeEarly = (db, id) => db.raw.prepare("UPDATE bookings SET created_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(id);
const HOURS = 3_600_000;
const T = Date.parse(TUE_9);

test('reminder: sent once, within 24 hours of the meeting, with reply-to and no manage link', async () => {
  const { env, db, token } = await setup();
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  madeEarly(db, made.booking.id);
  assert.equal((await runCron(env, T - 30 * HOURS)).filter((c) => c.url.includes('resend')).length, 0, 'too early');
  const calls = await runCron(env, T - 23.5 * HOURS);
  assert.equal(calls.length, 1);
  const body = calls[0].body;
  assert.deepEqual(body.to, ['cam@example.com']);
  assert.equal(body.reply_to, 'ana@example.com');
  assert.match(body.subject, /^Reminder: Barista interview on Tuesday, November 10, 2026 at 8:00 AM CST$/, 'in the invitee\'s time zone');
  assert.match(body.text, /Use the link in your confirmation email/);
  assert.ok(!body.text.includes('/book/manage/'), 'the raw manage token is not available after booking');
  assert.equal(body.attachments, undefined);
  assert.equal(calls[0].headers['Idempotency-Key'], `booking:${made.booking.id}:reminder`);
  assert.ok(db.raw.prepare('SELECT reminder_sent_at FROM bookings').get().reminder_sent_at);
  assert.equal((await runCron(env, T - 22 * HOURS)).length, 0, 'never a second reminder');
});

test('reminder: skipped for last-minute bookings, cancelled, erased, past and already-started meetings', async () => {
  const { env, db, token } = await setup();
  const lastMinute = await createBooking(env, token, candidate('a@example.com', TUE_9), NOW);
  db.raw.prepare("UPDATE bookings SET created_at = '2026-11-10T00:00:00.000Z' WHERE id = ?").run(lastMinute.booking.id); // booked 14h ahead
  const cancelled = await createBooking(env, token, candidate('b@example.com', TUE_930), NOW);
  madeEarly(db, cancelled.booking.id);
  await cancelManagedBooking(env, cancelled.manageToken, '', NOW);
  const erased = await createBooking(env, token, candidate('c@example.com', TUE_10), NOW);
  madeEarly(db, erased.booking.id);
  db.raw.prepare("UPDATE bookings SET client_email = NULL, anonymized_at = '2026-11-09T00:00:00.000Z' WHERE id = ?").run(erased.booking.id);
  assert.equal((await runCron(env, T - 2 * HOURS)).length, 0, 'none of these are due');
  const ok = await createBooking(env, token, candidate('d@example.com', '2026-11-10T16:00:00.000Z'), NOW);
  madeEarly(db, ok.booking.id);
  assert.equal((await runCron(env, Date.parse('2026-11-10T17:00:00Z'))).length, 0, 'meeting already started');
  assert.equal((await runCron(env, Date.parse('2026-11-10T15:00:00Z'))).length, 1, 'only the eligible booking is reminded');
});

test('reminder: a failing email is retried by the next hourly run and does not stop other work', async () => {
  const { env, db, token } = await setup();
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  madeEarly(db, made.booking.id);
  db.raw.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('old', 'u_admin', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z')").run();
  await runCron(env, T - 10 * HOURS, { failWith: 500 });
  assert.equal(db.raw.prepare('SELECT reminder_sent_at FROM bookings').get().reminder_sent_at, null, 'not marked as sent');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'old'").get().n, 0, 'the rest of the cleanup still ran');
  assert.equal((await runCron(env, T - 9 * HOURS)).length, 1, 'retried the next hour');
  assert.ok(db.raw.prepare('SELECT reminder_sent_at FROM bookings').get().reminder_sent_at);
});

test('reminder: without a Resend key nothing is sent and the job still completes', async () => {
  const { env, db, token } = await setup({ RESEND_API_KEY: undefined });
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  madeEarly(db, made.booking.id);
  assert.equal((await runCron(env, T - 10 * HOURS)).length, 0);
  assert.equal(db.raw.prepare('SELECT reminder_sent_at FROM bookings').get().reminder_sent_at, null);
});

test('reminder: moves with a reschedule (the new booking is reminded, the old one is not)', async () => {
  const { env, db, token } = await setup();
  const first = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  madeEarly(db, first.booking.id);
  const moved = await rescheduleManagedBooking(env, first.manageToken, TUE_10, NOW);
  madeEarly(db, moved.booking.id);
  const calls = await runCron(env, Date.parse(TUE_10) - 5 * HOURS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.subject, /9:00 AM CST/, 'reminds for the new 10:00 New York time (9:00 Central)');
});

test('reminder email: shows the address and notes, and escapes user text', () => {
  const email = buildBookingEmail({
    template: 'reminder', ownerTimezone: 'America/New_York',
    booking: {
      id: 'b1', title: 'Interview', start_utc: TUE_9, end_utc: TUE_930, client_name: '<b>Cam</b>', client_timezone: null, owner_name: 'Ana Lead',
      location_snapshot_json: JSON.stringify({ name: 'Shop', addressLine1: '1 Main St', city: 'Alpharetta', state: 'GA', postalCode: '30022', notes: 'Side door' })
    }
  });
  assert.match(email.text, /Where: Shop, 1 Main St, Alpharetta, GA 30022/);
  assert.match(email.text, /Notes: Side door/);
  assert.ok(!email.html.includes('<b>Cam</b>'));
  assert.equal(email.ics, undefined);
});

// ---------------- erase on request ----------------

test('erase: Management only; wipes every row for that person, cancels upcoming meetings, keeps the times', async () => {
  const { env, db, token, req } = await setup();
  // Erase decides "upcoming" by the real clock, so use real upcoming slots rather than fixed dates.
  const slots = (await getAvailableSlots(env, token)).slots;
  const [s0, s1, s2] = [slots[0], slots[1], slots[2]];
  const first = await createBooking(env, token, candidate('Cam@Example.com', s0, { phone: '555-0100' }));
  const moved = await rescheduleManagedBooking(env, first.manageToken, s2);
  const other = await createBooking(env, token, candidate('dee@example.com', s1, { name: 'Dee Other' }));
  await assert.rejects(eraseBookingData(req.leadA, { bookingId: moved.booking.id }, env), code(403, 'forbidden'));
  await assert.rejects(eraseBookingData(req.leadB, { bookingId: moved.booking.id }, env), code(403, 'forbidden'));
  await assert.rejects(eraseBookingData(req.admin, { bookingId: 'missing' }, env), code(404, 'booking_not_found'));
  const result = await eraseBookingData(req.admin, { bookingId: moved.booking.id }, env);
  assert.equal(result.erased, 2, 'the old rescheduled copy is erased too');
  const rows = db.raw.prepare("SELECT * FROM bookings WHERE id != ? ORDER BY start_utc").all(other.booking.id);
  for (const row of rows) {
    assert.deepEqual([row.client_name, row.client_email, row.client_phone, row.client_timezone, row.answers_json], [null, null, null, null, '{}']);
    assert.ok(row.anonymized_at);
    assert.equal(row.status, 'cancelled', 'no ghost meeting is left');
  }
  assert.deepEqual(rows.map((r) => r.start_utc), [s0, s2].sort(), 'meeting times are kept');
  const untouched = db.raw.prepare('SELECT client_name, client_email, status FROM bookings WHERE id = ?').get(other.booking.id);
  assert.deepEqual({ ...untouched }, { client_name: 'Dee Other', client_email: 'dee@example.com', status: 'confirmed' });
  const wire = JSON.stringify(db.raw.prepare('SELECT * FROM audit_events').all());
  assert.ok(!/cam@example|Cam Candidate|555-0100/i.test(wire), 'the audit log holds no personal data');
  const notices = JSON.stringify(db.raw.prepare('SELECT message, title FROM notifications').all());
  assert.ok(!/cam@example|Cam Candidate/i.test(notices), 'notification rows hold no personal data');
  // The old manage link now shows only a cancelled meeting with no name.
  const view = await getManagedBooking(env, first.manageToken);
  assert.equal(view.booking.clientName, null);
  assert.equal(view.booking.status, 'cancelled');
});

test('erase: a past meeting stays as it was, only the person\'s details go', async () => {
  const { env, db, token, req } = await setup();
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9), NOW);
  // Make it an old meeting (well before the real clock) that really happened.
  db.raw.prepare(`UPDATE bookings SET start_utc = '2020-01-07T14:00:00.000Z', end_utc = '2020-01-07T14:30:00.000Z',
    blocks_start_utc = '2020-01-07T14:00:00.000Z', blocks_end_utc = '2020-01-07T14:30:00.000Z' WHERE id = ?`).run(made.booking.id);
  await eraseBookingData(req.admin, { bookingId: made.booking.id }, env);
  const row = db.raw.prepare('SELECT status, client_email, start_utc FROM bookings').get();
  assert.deepEqual({ ...row }, { status: 'confirmed', client_email: null, start_utc: '2020-01-07T14:00:00.000Z' });
});

// ---------------- the whole life of a booking ----------------

test('lifecycle: set up, book, remind, reschedule, cancel, retain and erase - privacy holds throughout', async () => {
  const { env, db, token, req } = await setup();
  const sent = [];
  env.NOTIFICATIONS = { send: async (m) => { sent.push(m); } };
  const api = async (who, action, body) => {
    const headers = new Headers(who.headers); headers.set('Content-Type', 'application/json');
    const r = await onRequestPost({ request: new Request('https://portal.test/api/team', { method: 'POST', headers, body: JSON.stringify({ action, ...body }) }), env });
    return { status: r.status, body: await r.json() };
  };
  // Book.
  const made = await createBooking(env, token, candidate('cam@example.com', TUE_9, { phone: '555-0100' }), NOW);
  assert.equal(sent.filter((m) => m.kind === 'booking_email' && m.template === 'confirmed').length, 1);
  madeEarly(db, made.booking.id);
  // The host and Management see it; another lead does not.
  const range = { from: '2026-11-01', to: '2026-11-30' };
  assert.equal((await api(req.leadA, 'getCalendar', range)).body.bookings[0].clientName, 'Cam Candidate');
  assert.equal((await api(req.leadB, 'getCalendar', range)).body.bookings[0].redacted, true);
  // Reminder goes out.
  assert.equal((await runCron(env, T - 20 * HOURS)).length, 1);
  // Candidate reschedules; host is told without a name.
  const moved = await rescheduleManagedBooking(env, made.manageToken, TUE_10, NOW);
  assert.ok(db.raw.prepare("SELECT message FROM notifications WHERE notification_type = 'booking_rescheduled'").get());
  // Host cancels; candidate is emailed.
  await api(req.leadA, 'cancelBooking', { bookingId: moved.booking.id });
  assert.equal(sent.filter((m) => m.template === 'cancelled_by_host').length, 1);
  assert.equal((await api(req.leadB, 'getCalendar', range)).body.bookings.length, 0, 'cancelled meetings leave the shared calendar');
  // 12 months later the details are gone without anyone doing anything.
  const real = Date.now;
  try { Date.now = () => Date.parse('2027-11-12T00:00:00Z'); await runCron(env, Date.parse('2027-11-12T00:00:00Z')); } finally { Date.now = real; }
  const rows = db.raw.prepare('SELECT client_name, client_email, client_phone, anonymized_at FROM bookings').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.client_name === null && r.client_email === null && r.client_phone === null && r.anonymized_at));
});

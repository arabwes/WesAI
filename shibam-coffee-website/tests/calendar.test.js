// Calendar phase 1: timezone/slot rules, atomic booking, the one-active-booking
// rule, link states, privacy (owner + Management only), and 12-month retention.
// Handlers run unmodified against every migration via the D1 stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import {
  expandAvailability, generateSlots, mergeIntervals, redactBooking, subtractIntervals, timeOffToIntervals, wallToUtc
} from '../functions/_lib/calendar-rules.js';
import {
  anonymizeExpiredBookings, cancelBooking, createBooking, createLinkRecord, getAvailableSlots, getBooking,
  getCalendar, getMyBookings, resolveLink
} from '../functions/_lib/calendar.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const NY = 'America/New_York';
const HOUR = 3_600_000;
// Monday 2026-11-09 12:00 UTC = 07:00 in New York (EST).
const NOW = Date.parse('2026-11-09T12:00:00Z');

test('wallToUtc handles standard time, daylight saving gaps and repeated hours', () => {
  assert.equal(new Date(wallToUtc('2026-11-09', 9 * 60, NY)).toISOString(), '2026-11-09T14:00:00.000Z');
  assert.equal(new Date(wallToUtc('2026-07-09', 9 * 60, NY)).toISOString(), '2026-07-09T13:00:00.000Z');
  assert.equal(wallToUtc('2026-03-08', 2 * 60 + 30, NY), null, '02:30 does not exist on spring-forward day');
  assert.equal(new Date(wallToUtc('2026-11-01', 60 + 30, NY)).toISOString(), '2026-11-01T05:30:00.000Z', 'repeated hour uses the first one');
  assert.equal(new Date(wallToUtc('2026-11-09', 1440, NY)).toISOString(), '2026-11-10T05:00:00.000Z', '24:00 is next midnight');
});

test('interval helpers merge and subtract', () => {
  assert.deepEqual(mergeIntervals([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 3, end: 6 }]), [{ start: 1, end: 8 }]);
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 8, end: 12 }]),
    [{ start: 0, end: 2 }, { start: 4, end: 8 }]);
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: -5, end: 20 }]), []);
});

test('expandAvailability: overrides replace the weekday rules and can block a whole day', () => {
  const rules = [{ weekday: 1, start_time: '09:00', end_time: '12:00' }];
  const base = { rules, fromDate: '2026-11-09', toDate: '2026-11-16', timezone: NY };
  assert.equal(expandAvailability({ ...base, overrides: [] }).length, 2, 'two Mondays');
  const blocked = expandAvailability({ ...base, overrides: [{ override_date: '2026-11-09', start_time: null, end_time: null }] });
  assert.equal(blocked.length, 1);
  const replaced = expandAvailability({ ...base, overrides: [{ override_date: '2026-11-09', start_time: '13:00', end_time: '14:00' }] });
  assert.equal(new Date(replaced[0].start).toISOString(), '2026-11-09T18:00:00.000Z');
});

test('generateSlots applies buffers, notice, and max days', () => {
  const windows = [{ start: 10 * HOUR, end: 14 * HOUR }];
  const common = { windows, durationMinutes: 60, intervalMinutes: 60, now: 0, minNoticeMinutes: 0, maxDaysAhead: 30 };
  assert.deepEqual(generateSlots({ ...common, busy: [] }).map((s) => s / HOUR), [10, 11, 12, 13]);
  // A booking 12:00-13:00 with no buffers removes only the 12:00 slot.
  assert.deepEqual(generateSlots({ ...common, busy: [{ start: 12 * HOUR, end: 13 * HOUR }] }).map((s) => s / HOUR), [10, 11, 13]);
  // 30-minute buffer on both sides also removes the neighbours' overlap.
  assert.deepEqual(generateSlots({ ...common, bufferBeforeMinutes: 30, bufferAfterMinutes: 30,
    busy: [{ start: 12 * HOUR, end: 13 * HOUR }] }).map((s) => s / HOUR), [10]);
  assert.deepEqual(generateSlots({ ...common, busy: [], minNoticeMinutes: 11 * 60 }).map((s) => s / HOUR), [11, 12, 13]);
  assert.deepEqual(generateSlots({ ...common, busy: [], now: -40 * 24 * HOUR, maxDaysAhead: 30 }), []);
});

test('time off blocks whole days or the stated hours', () => {
  const whole = timeOffToIntervals([{ start_date: '2026-11-09', end_date: '2026-11-09', start_time: null, end_time: null }], NY);
  assert.equal(whole[0].end - whole[0].start, 24 * HOUR);
  const part = timeOffToIntervals([{ start_date: '2026-11-09', end_date: '2026-11-10', start_time: '13:00', end_time: '15:00' }], NY);
  assert.equal(part.length, 2);
});

// ---- database-backed behaviour ----

function setup() {
  const db = createTestDatabase(MIGRATIONS);
  const env = { TEAM_DB: db, STORE_TIMEZONE: NY };
  const req = {
    barista: addUserWithSession(db, { id: 'u_barista', username: 'bea', name: 'Bea Barista', role: 'barista' }),
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  const stamp = new Date().toISOString();
  db.raw.prepare(`INSERT INTO meeting_locations (id, name, address_line1, city, state, postal_code, active, created_at, updated_at)
    VALUES ('loc_1', 'Alpharetta shop', '4000 North Point Pkwy Suite 900', 'Alpharetta', 'GA', '30022', 1, ?, ?)`).run(stamp, stamp);
  const makeType = (id, owner, extra = {}) => db.raw.prepare(`INSERT INTO event_types (id, owner_id, name, slug, duration_minutes,
      buffer_before_minutes, buffer_after_minutes, location_id, min_notice_minutes, max_days_ahead, slot_interval_minutes,
      questions_json, created_at, updated_at) VALUES (?, ?, 'Interview', ?, 30, ?, ?, 'loc_1', 60, 30, 30, ?, ?, ?)`)
    .run(id, owner, `interview-${id}`, extra.before ?? 0, extra.after ?? 0, extra.questions ?? '[]', stamp, stamp);
  makeType('et_a', 'u_leada');
  makeType('et_b', 'u_leadb', { before: 15, after: 15 });
  for (const owner of ['u_leada', 'u_leadb']) {
    // Monday-Friday 09:00-12:00 New York.
    for (let weekday = 1; weekday <= 5; weekday += 1) {
      db.raw.prepare('INSERT INTO booking_availability (id, owner_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
        .run(`av_${owner}_${weekday}`, owner, weekday, '09:00', '12:00');
    }
  }
  return { db, env, req };
}

// First bookable slot on the Tuesday after NOW, so tests are deterministic.
const TUESDAY_9AM = '2026-11-10T14:00:00.000Z';
const TUESDAY_930 = '2026-11-10T14:30:00.000Z';
const TUESDAY_10AM = '2026-11-10T15:00:00.000Z';

async function linkFor(db, eventTypeId, options = {}) {
  return createLinkRecord(db, { eventTypeId, ...options });
}

const candidate = (email, start, extra = {}) => ({ name: 'Cam Candidate', email, start, timezone: 'America/Chicago', ...extra });

test('slots are listed for a valid link and use the owner timezone', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  const result = await getAvailableSlots(env, token, NOW);
  assert.equal(result.ownerTimezone, NY);
  assert.equal(result.event.location.city, 'Alpharetta');
  assert.ok(result.slots.includes(TUESDAY_9AM));
  assert.ok(result.slots.includes('2026-11-09T14:00:00.000Z'), 'today 09:00 NY is past the 60 minute notice at 07:00 NY');
  assert.ok(!result.slots.includes('2026-11-09T13:00:00.000Z'), '08:00 NY is before opening');
  assert.ok(!result.slots.includes('2026-11-10T17:00:00.000Z'), '12:00 NY is after the window closes');
  const weekdays = new Set(result.slots.map((slot) => new Date(Date.parse(slot) - 5 * 3_600_000).getUTCDay()));
  assert.ok(!weekdays.has(0) && !weekdays.has(6), 'no weekend slots');
});

test('booking works, hides the slot, and rejects a second booking of it', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  const first = await createBooking(env, token, candidate('one@example.com', TUESDAY_9AM), NOW);
  assert.equal(first.ok, true);
  assert.ok(first.manageToken.length > 20);
  assert.ok(!(await getAvailableSlots(env, token, NOW)).slots.includes(TUESDAY_9AM));
  await assert.rejects(createBooking(env, token, candidate('two@example.com', TUESDAY_9AM), NOW), /slot_unavailable/);
  const next = await createBooking(env, token, candidate('two@example.com', TUESDAY_930), NOW);
  assert.equal(next.ok, true);
});

test('concurrent bookings of one slot: exactly one wins and the link is not over-counted', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  const results = await Promise.allSettled([
    createBooking(env, token, candidate('a@example.com', TUESDAY_9AM), NOW),
    createBooking(env, token, candidate('b@example.com', TUESDAY_9AM), NOW),
    createBooking(env, token, candidate('c@example.com', TUESDAY_9AM), NOW)
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && /slot_unavailable/.test(r.reason.message)).length, 2);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").get().n, 1);
  assert.equal(db.raw.prepare('SELECT use_count FROM booking_links').get().use_count, 1);
});

test('buffers stop neighbouring bookings from overlapping', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_b'); // 15-minute buffers either side
  await createBooking(env, token, candidate('a@example.com', TUESDAY_10AM), NOW);
  const slots = (await getAvailableSlots(env, token, NOW)).slots;
  assert.ok(!slots.includes(TUESDAY_930), '09:30-10:00 would touch the buffer before 10:00');
  assert.ok(!slots.includes('2026-11-10T15:30:00.000Z'), '10:30 sits inside the buffer after 10:30');
  assert.ok(slots.includes(TUESDAY_9AM), '09:00-09:30 plus 15 minute buffer ends at 09:45, before 09:45 block starts');
});

test('each invitee may hold only one active booking per link', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  const first = await createBooking(env, token, candidate('Repeat@Example.com', TUESDAY_9AM), NOW);
  await assert.rejects(createBooking(env, token, candidate('repeat@example.com', TUESDAY_930), NOW), /already_booked/);
  assert.equal(db.raw.prepare('SELECT use_count FROM booking_links').get().use_count, 1, 'a rejected attempt does not use up the link');
  // Different person is fine on the same reusable link.
  await createBooking(env, token, candidate('other@example.com', TUESDAY_930), NOW);
  // After the owner cancels, the invitee can book again.
  await cancelBooking(req(env).leadA, { bookingId: first.booking.id }, env);
  const again = await createBooking(env, token, candidate('repeat@example.com', TUESDAY_9AM), NOW);
  assert.equal(again.ok, true);
});

function req(env) {
  // Requests are created in setup(); this helper re-reads them by user id.
  const db = env.TEAM_DB;
  const make = (id) => new Request('https://portal.test/api/team', { headers: { Cookie: `shibam_team_session=token-${id}` } });
  return { barista: make('u_barista'), leadA: make('u_leada'), leadB: make('u_leadb'), admin: make('u_admin'), db };
}

test('a past booking no longer counts as active, so the invitee can book again', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  await createBooking(env, token, candidate('past@example.com', TUESDAY_9AM), NOW);
  const later = Date.parse('2026-11-12T12:00:00Z'); // after the first meeting ended
  const result = await createBooking(env, token, candidate('past@example.com', '2026-11-12T14:00:00.000Z'), later);
  assert.equal(result.ok, true);
});

test('invalid input and unavailable times are rejected', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  await assert.rejects(createBooking(env, token, candidate('not-an-email', TUESDAY_9AM), NOW), /invalid_email/);
  await assert.rejects(createBooking(env, token, { email: 'a@example.com', start: TUESDAY_9AM }, NOW), /name_required/);
  await assert.rejects(createBooking(env, token, candidate('a@example.com', 'soon'), NOW), /invalid_start/);
  await assert.rejects(createBooking(env, token, candidate('a@example.com', '2026-11-10T14:07:00.000Z'), NOW), /slot_unavailable/, 'off-grid time');
  await assert.rejects(createBooking(env, token, candidate('a@example.com', '2026-11-10T22:00:00.000Z'), NOW), /slot_unavailable/, 'outside hours');
  await assert.rejects(createBooking(env, token, candidate('a@example.com', '2026-11-08T14:00:00.000Z'), NOW), /slot_unavailable/, 'in the past');
  assert.equal(db.raw.prepare('SELECT use_count FROM booking_links').get().use_count, 0);
});

test('required custom questions are enforced', async () => {
  const { db, env } = setup();
  db.raw.prepare("UPDATE event_types SET questions_json = ? WHERE id = 'et_a'")
    .run(JSON.stringify([{ id: 'position', label: 'Position', required: true }]));
  const { token } = await linkFor(db, 'et_a');
  await assert.rejects(createBooking(env, token, candidate('a@example.com', TUESDAY_9AM), NOW), /answer_required/);
  const ok = await createBooking(env, token, candidate('a@example.com', TUESDAY_9AM, { answers: { position: 'Barista', extra: 'ignored' } }), NOW);
  assert.equal(ok.ok, true);
  assert.deepEqual(JSON.parse(db.raw.prepare('SELECT answers_json FROM bookings').get().answers_json), { position: 'Barista' });
});

test('links: unknown, revoked, expired, exhausted, and archived all look the same', async () => {
  const { db, env } = setup();
  const reusable = await linkFor(db, 'et_a');
  const revoked = await linkFor(db, 'et_a');
  const expired = await linkFor(db, 'et_a', { expiresAt: '2026-11-01T00:00:00.000Z' });
  const single = await linkFor(db, 'et_a', { maxUses: 1 });
  db.raw.prepare('UPDATE booking_links SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), revoked.id);
  for (const token of ['x'.repeat(43), revoked.token, expired.token, 'short']) {
    await assert.rejects(resolveLink(env, token, NOW), (error) => error.code === 'link_not_found' && error.status === 404);
  }
  await resolveLink(env, reusable.token, NOW);
  await createBooking(env, single.token, candidate('a@example.com', TUESDAY_9AM), NOW);
  await assert.rejects(createBooking(env, single.token, candidate('b@example.com', TUESDAY_930), NOW), /link_not_found/);
  // Reusable link keeps working for many candidates.
  await createBooking(env, reusable.token, candidate('c@example.com', TUESDAY_930), NOW);
  await createBooking(env, reusable.token, candidate('d@example.com', TUESDAY_10AM), NOW);
  // Archiving the address or event type takes the link offline without deleting bookings.
  db.raw.prepare("UPDATE meeting_locations SET active = 0 WHERE id = 'loc_1'").run();
  await assert.rejects(resolveLink(env, reusable.token, NOW), /link_not_found/);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 3);
});

test('the raw token is never stored', async () => {
  const { db } = setup();
  const { token } = await linkFor(db, 'et_a');
  const stored = db.raw.prepare('SELECT token_hash FROM booking_links').get().token_hash;
  assert.notEqual(stored, token);
  assert.match(stored, /^[0-9a-f]{64}$/);
});

test('approved time off and blocking team events remove slots; pending time off does not', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  const stamp = new Date().toISOString();
  db.raw.prepare(`INSERT INTO time_off_requests (id, employee_id, start_date, end_date, status, submitted_at)
    VALUES ('to_1', 'u_leada', '2026-11-10', '2026-11-10', 'approved', ?)`).run(stamp);
  db.raw.prepare(`INSERT INTO time_off_requests (id, employee_id, start_date, end_date, status, submitted_at)
    VALUES ('to_2', 'u_leada', '2026-11-11', '2026-11-11', 'pending', ?)`).run(stamp);
  db.raw.prepare(`INSERT INTO team_events (id, created_by, title, start_utc, end_utc, blocks_availability, created_at, updated_at)
    VALUES ('ev_1', 'u_leada', 'Supplier visit', '2026-11-12T14:00:00.000Z', '2026-11-12T15:00:00.000Z', 1, ?, ?)`).run(stamp, stamp);
  db.raw.prepare(`INSERT INTO team_events (id, created_by, title, start_utc, end_utc, blocks_availability, created_at, updated_at)
    VALUES ('ev_2', 'u_leadb', 'Someone elses block', '2026-11-12T15:00:00.000Z', '2026-11-12T16:00:00.000Z', 1, ?, ?)`).run(stamp, stamp);
  const slots = (await getAvailableSlots(env, token, NOW)).slots;
  assert.ok(!slots.some((s) => s.startsWith('2026-11-10')), 'approved time off');
  assert.ok(slots.some((s) => s.startsWith('2026-11-11')), 'pending time off is ignored');
  assert.ok(!slots.includes('2026-11-12T14:00:00.000Z') && !slots.includes('2026-11-12T14:30:00.000Z'), 'own blocking event');
  assert.ok(slots.includes('2026-11-12T15:00:00.000Z'), "another person's event does not block this owner");
});

test('the database itself refuses two confirmed bookings with the same start for one owner', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  const booked = await createBooking(env, token, candidate('a@example.com', TUESDAY_9AM), NOW);
  assert.ok(booked.ok);
  assert.throws(() => db.raw.prepare(`INSERT INTO bookings (id, event_type_id, owner_id, link_id, location_id, location_snapshot_json, title,
      start_utc, end_utc, blocks_start_utc, blocks_end_utc, manage_token_hash, created_at)
    SELECT 'dup', event_type_id, owner_id, link_id, location_id, location_snapshot_json, title, start_utc, end_utc,
      blocks_start_utc, blocks_end_utc, 'hash-dup', created_at FROM bookings`).run(), /UNIQUE/);
});

// ---- privacy ----

async function seedBookings() {
  const ctx = setup();
  const a = await linkFor(ctx.db, 'et_a');
  const b = await linkFor(ctx.db, 'et_b');
  const bookingA = await createBooking(ctx.env, a.token, candidate('secret-a@example.com', TUESDAY_9AM, { name: 'Alice Applicant', phone: '555-0101' }), NOW);
  const bookingB = await createBooking(ctx.env, b.token, candidate('secret-b@example.com', TUESDAY_9AM, { name: 'Bob Applicant', phone: '555-0102' }), NOW);
  return { ...ctx, bookingA: bookingA.booking, bookingB: bookingB.booking };
}

const range = { from: '2026-11-09', to: '2026-11-15' };

test('team calendar: non-owners only see that a time is booked', async () => {
  const { env, req, bookingA } = await seedBookings();
  const asBarista = await getCalendar(req.barista, range, env);
  assert.equal(asBarista.bookings.length, 2);
  for (const booking of asBarista.bookings) {
    assert.deepEqual(Object.keys(booking).sort(), ['endUtc', 'redacted', 'startUtc', 'title']);
    assert.equal(booking.title, 'Booked');
  }
  const wire = JSON.stringify(asBarista);
  for (const secret of ['secret-a', 'secret-b', 'Alice', 'Bob', '555-01', 'Interview', 'Alpharetta', bookingA.id, 'u_leada', 'Ana Lead']) {
    assert.ok(!wire.includes(secret), `leaked ${secret}`);
  }
});

test('team calendar: the owner sees their own in full but not other leads', async () => {
  const { env, req } = await seedBookings();
  const asLeadA = await getCalendar(req.leadA, range, env);
  const full = asLeadA.bookings.filter((b) => !b.redacted);
  const hidden = asLeadA.bookings.filter((b) => b.redacted);
  assert.equal(full.length, 1);
  assert.equal(full[0].clientEmail, 'secret-a@example.com');
  assert.equal(hidden.length, 1);
  assert.ok(!JSON.stringify(hidden).includes('secret-b'));
});

test('team calendar: Management sees everything', async () => {
  const { env, req } = await seedBookings();
  const asAdmin = await getCalendar(req.admin, range, env);
  assert.equal(asAdmin.bookings.filter((b) => !b.redacted).length, 2);
});

test('team calendar still shows shared team events to every employee', async () => {
  const { db, env, req } = await seedBookings();
  const stamp = new Date().toISOString();
  db.raw.prepare(`INSERT INTO team_events (id, created_by, title, start_utc, end_utc, created_at, updated_at)
    VALUES ('ev_all', 'u_leada', 'Team meeting', '2026-11-11T15:00:00.000Z', '2026-11-11T16:00:00.000Z', ?, ?)`).run(stamp, stamp);
  const asBarista = await getCalendar(req.barista, range, env);
  assert.equal(asBarista.events[0].title, 'Team meeting');
});

test('getBooking: only the owner and Management; everyone else gets the same 403', async () => {
  const { env, req, bookingA } = await seedBookings();
  assert.equal((await getBooking(req.leadA, { bookingId: bookingA.id }, env)).booking.clientName, 'Alice Applicant');
  assert.equal((await getBooking(req.admin, { bookingId: bookingA.id }, env)).booking.clientEmail, 'secret-a@example.com');
  for (const who of [req.leadB, req.barista]) {
    await assert.rejects(getBooking(who, { bookingId: bookingA.id }, env), (e) => e.status === 403 && e.code === 'forbidden');
    await assert.rejects(getBooking(who, { bookingId: 'booking_missing' }, env), (e) => e.status === 403 && e.code === 'forbidden');
  }
  await assert.rejects(getBooking(new Request('https://portal.test/'), { bookingId: bookingA.id }, env), (e) => e.status === 401);
});

test('getMyBookings: leads see their own, baristas are refused, Management can list all', async () => {
  const { env, req } = await seedBookings();
  const mine = await getMyBookings(req.leadA, {}, env);
  assert.equal(mine.bookings.length, 1);
  assert.equal(mine.bookings[0].clientName, 'Alice Applicant');
  // A lead cannot widen the list with all:true.
  assert.equal((await getMyBookings(req.leadA, { all: true }, env)).bookings.length, 1);
  assert.equal((await getMyBookings(req.admin, { all: true }, env)).bookings.length, 2);
  await assert.rejects(getMyBookings(req.barista, {}, env), (e) => e.status === 403);
});

test('cancelBooking: owner or Management only, and it frees the slot', async () => {
  const { db, env, req, bookingA } = await seedBookings();
  await assert.rejects(cancelBooking(req.leadB, { bookingId: bookingA.id }, env), (e) => e.status === 403);
  await assert.rejects(cancelBooking(req.barista, { bookingId: bookingA.id }, env), (e) => e.status === 403);
  await cancelBooking(req.admin, { bookingId: bookingA.id, reason: 'Role filled' }, env);
  await assert.rejects(cancelBooking(req.leadA, { bookingId: bookingA.id }, env), /booking_not_cancellable/);
  const { token } = await linkFor(db, 'et_a');
  assert.ok((await getAvailableSlots(env, token, NOW)).slots.includes(TUESDAY_9AM));
  const asBarista = await getCalendar(req.barista, range, env);
  assert.equal(asBarista.bookings.length, 1, 'cancelled bookings disappear from the shared calendar');
});

test('redactBooking never exposes fields to a stranger even for odd actors', () => {
  const row = { id: 'b1', owner_id: 'u1', title: 'Interview', start_utc: 's', end_utc: 'e', client_email: 'x@y.z', status: 'confirmed' };
  for (const actor of [null, undefined, { id: 'u2', role: 'lead' }, { id: 'u2', role: 'barista' }, { id: 'u2', role: 'MANAGEMENT' }]) {
    assert.deepEqual(redactBooking(actor, row), { startUtc: 's', endUtc: 'e', title: 'Booked', redacted: true });
  }
  assert.equal(redactBooking({ id: 'u1', role: 'lead' }, row).clientEmail, 'x@y.z');
  assert.equal(redactBooking({ id: 'u9', role: 'management' }, row).clientEmail, 'x@y.z');
});

// ---- retention ----

test('retention: invitee data is blanked 12 months after the meeting, the meeting row stays', async () => {
  const { db, env } = setup();
  const { token } = await linkFor(db, 'et_a');
  await createBooking(env, token, candidate('old@example.com', TUESDAY_9AM, { phone: '555-0199', answers: {} }), NOW);
  const early = await anonymizeExpiredBookings(env, Date.parse('2027-11-09T00:00:00Z'));
  assert.equal(early.anonymized, 0, 'not yet 12 months after 2026-11-10');
  const done = await anonymizeExpiredBookings(env, Date.parse('2027-11-11T00:00:00Z'));
  assert.equal(done.anonymized, 1);
  const row = db.raw.prepare('SELECT * FROM bookings').get();
  assert.equal(row.client_name, null);
  assert.equal(row.client_email, null);
  assert.equal(row.client_phone, null);
  assert.equal(row.answers_json, '{}');
  assert.ok(row.anonymized_at);
  assert.equal(row.start_utc, TUESDAY_9AM);
  assert.equal((await anonymizeExpiredBookings(env, Date.parse('2027-12-01T00:00:00Z'))).anonymized, 0, 'idempotent');
});

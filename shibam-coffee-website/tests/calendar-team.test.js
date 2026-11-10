// Calendar phase 4: team events and the shared calendar. Covers who can create
// or change events, timezone handling, the redacted view, and the owner list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import { createBookingLink, saveBookingAvailability, saveEventType, saveMeetingLocation } from '../functions/_lib/calendar-setup.js';
import { deleteTeamEvent, saveTeamEvent } from '../functions/_lib/calendar-team.js';
import { cancelBooking, createBooking, getAvailableSlots, getBooking, getCalendar, getMyBookings } from '../functions/_lib/calendar.js';
import { onRequestPost } from '../functions/api/team/index.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const NOW = Date.parse('2026-11-09T12:00:00Z');
const code = (status, error) => (e) => e.status === status && e.code === error;

async function setup() {
  const db = createTestDatabase(MIGRATIONS);
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York' };
  const req = {
    barista: addUserWithSession(db, { id: 'u_barista', username: 'bea', name: 'Bea Barista', role: 'barista' }),
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  const location = await saveMeetingLocation(req.leadA, { name: 'Shop', addressLine1: '1 Main St', city: 'Alpharetta', state: 'GA', postalCode: '30022' }, env);
  const type = await saveEventType(req.leadA, { name: 'Interview', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60 }, env);
  await saveBookingAvailability(req.leadA, { timezone: 'America/New_York', weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '09:00', endTime: '12:00' })) }, env);
  const link = await createBookingLink(req.leadA, { eventTypeId: type.id }, env);
  return { db, env, req, token: link.url.split('/').pop() };
}

const range = { from: '2026-11-01', to: '2026-12-12' };

test('team events: Lead+ create, baristas cannot, everyone sees them', async () => {
  const { env, req } = await setup();
  const made = await saveTeamEvent(req.leadA, { title: 'Supplier tasting', date: '2026-11-12', startTime: '14:00', endTime: '15:30', location: 'Back room' }, env);
  assert.ok(made.id);
  await assert.rejects(saveTeamEvent(req.barista, { title: 'x', date: '2026-11-12', startTime: '09:00', endTime: '10:00' }, env), code(403, 'forbidden'));
  for (const who of [req.barista, req.leadB, req.admin]) {
    const calendar = await getCalendar(who, range, env);
    assert.equal(calendar.events.length, 1);
    assert.equal(calendar.events[0].title, 'Supplier tasting');
    assert.equal(calendar.events[0].creatorName, 'Ana Lead');
    assert.equal(calendar.timezone, 'America/New_York');
  }
});

test('team events: times are entered in the store timezone and stored as UTC, across a daylight saving change', async () => {
  const { env, req, db } = await setup();
  await saveTeamEvent(req.leadA, { title: 'Before', date: '2026-10-30', startTime: '09:00', endTime: '10:00' }, env); // EDT
  await saveTeamEvent(req.leadA, { title: 'After', date: '2026-11-02', startTime: '09:00', endTime: '10:00' }, env); // EST
  const rows = db.raw.prepare('SELECT title, start_utc FROM team_events ORDER BY start_utc').all();
  assert.deepEqual(rows.map((r) => [r.title, r.start_utc]), [['Before', '2026-10-30T13:00:00.000Z'], ['After', '2026-11-02T14:00:00.000Z']]);
});

test('team events: all-day and multi-day events cover whole store-timezone days', async () => {
  const { env, req, db } = await setup();
  await saveTeamEvent(req.leadA, { title: 'Closed', date: '2026-11-26', endDate: '2026-11-27', allDay: true }, env);
  const row = db.raw.prepare('SELECT * FROM team_events').get();
  assert.equal(row.all_day, 1);
  assert.equal(row.start_utc, '2026-11-26T05:00:00.000Z');
  assert.equal(row.end_utc, '2026-11-28T05:00:00.000Z', 'ends at the start of the day after the last day');
  const calendar = await getCalendar(req.barista, { from: '2026-11-27', to: '2026-11-27' }, env);
  assert.equal(calendar.events.length, 1, 'the second day still shows it');
  assert.equal((await getCalendar(req.barista, { from: '2026-11-28', to: '2026-11-28' }, env)).events.length, 0);
});

test('team events: validation', async () => {
  const { env, req } = await setup();
  const ok = { title: 'T', date: '2026-11-12', startTime: '09:00', endTime: '10:00' };
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, title: ' ' }, env), /title_required/);
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, title: 'x'.repeat(121) }, env), /title_too_long/);
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, endTime: '09:00' }, env), /invalid_range/);
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, endTime: '08:00' }, env), /invalid_range/);
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, date: '2026-02-30' }, env), /invalid_date/);
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, startTime: '25:00' }, env), /invalid_start_time/);
  await assert.rejects(saveTeamEvent(req.leadA, { title: 'T', date: '2026-11-12', allDay: true, endDate: '2026-11-10' }, env), /invalid_range/);
  await assert.rejects(saveTeamEvent(req.leadA, { ...ok, date: '2026-03-08', startTime: '02:30', endTime: '03:30' }, env), /invalid_range/, 'a time that does not exist on spring-forward day');
});

test('team events: leads change only their own, Management any', async () => {
  const { env, req } = await setup();
  const { id } = await saveTeamEvent(req.leadA, { title: 'Mine', date: '2026-11-12', startTime: '09:00', endTime: '10:00' }, env);
  const edit = { id, title: 'Renamed', date: '2026-11-12', startTime: '09:00', endTime: '11:00' };
  await assert.rejects(saveTeamEvent(req.leadB, edit, env), code(403, 'forbidden'));
  await assert.rejects(deleteTeamEvent(req.leadB, { id }, env), code(403, 'forbidden'));
  await assert.rejects(deleteTeamEvent(req.barista, { id }, env), code(403, 'forbidden'));
  await saveTeamEvent(req.leadA, edit, env);
  await saveTeamEvent(req.admin, { ...edit, title: 'By admin' }, env);
  const asLeadA = (await getCalendar(req.leadA, range, env)).events[0];
  const asLeadB = (await getCalendar(req.leadB, range, env)).events[0];
  const asBarista = (await getCalendar(req.barista, range, env)).events[0];
  assert.equal(asLeadA.title, 'By admin');
  assert.deepEqual([asLeadA.canEdit, asLeadB.canEdit, asBarista.canEdit], [true, false, false]);
  await assert.rejects(saveTeamEvent(req.leadA, { ...edit, id: 'missing' }, env), code(404, 'event_not_found'));
  await deleteTeamEvent(req.admin, { id }, env);
  assert.equal((await getCalendar(req.barista, range, env)).events.length, 0);
  await assert.rejects(deleteTeamEvent(req.admin, { id }, env), code(404, 'event_not_found'));
});

test('team events: "blocks my availability" is private to the creator and affects only their slots', async () => {
  const { env, req, token } = await setup();
  await saveTeamEvent(req.leadA, { title: 'Supplier', date: '2026-11-10', startTime: '09:00', endTime: '10:00', blocksAvailability: true }, env);
  const slots = (await getAvailableSlots(env, token, NOW)).slots;
  assert.ok(!slots.includes('2026-11-10T14:00:00.000Z') && !slots.includes('2026-11-10T14:30:00.000Z'));
  assert.ok(slots.includes('2026-11-10T15:00:00.000Z'));
  assert.equal((await getCalendar(req.leadA, range, env)).events[0].blocksAvailability, true);
  assert.equal((await getCalendar(req.leadB, range, env)).events[0].blocksAvailability, false, 'others cannot see the setting');
});

test('calendar view: ranges are validated and bounded', async () => {
  const { env, req } = await setup();
  await assert.rejects(getCalendar(req.barista, { from: '2026-11-10', to: '2026-11-01' }, env), /invalid_range/);
  await assert.rejects(getCalendar(req.barista, { from: '2026-01-01', to: '2026-12-31' }, env), /range_too_large/);
  await assert.rejects(getCalendar(req.barista, { from: 'nope', to: '2026-12-31' }, env), /invalid_from/);
  await assert.rejects(getCalendar(new Request('https://x.test'), range, env), code(401, 'session_expired'));
});

test('calendar view: late-evening store-time bookings land on the right day', async () => {
  const { env, req, db } = await setup();
  // 23:30 New York on Nov 10 is 04:30Z on Nov 11; a UTC-day range would put it on the wrong day.
  db.raw.prepare(`INSERT INTO bookings (id, event_type_id, owner_id, link_id, location_id, location_snapshot_json, title, start_utc, end_utc,
      blocks_start_utc, blocks_end_utc, manage_token_hash, created_at)
    SELECT 'late', e.id, e.owner_id, l.id, e.location_id, '{}', 'Late', '2026-11-11T04:30:00.000Z', '2026-11-11T05:00:00.000Z',
      '2026-11-11T04:30:00.000Z', '2026-11-11T05:00:00.000Z', 'h-late', '2026-11-01T00:00:00.000Z' FROM event_types e JOIN booking_links l ON l.event_type_id = e.id`).run();
  assert.equal((await getCalendar(req.barista, { from: '2026-11-10', to: '2026-11-10' }, env)).bookings.length, 1);
  assert.equal((await getCalendar(req.barista, { from: '2026-11-11', to: '2026-11-11' }, env)).bookings.length, 0);
});

test('shared calendar, end to end through the router: redaction, owner list, admin list and cancelling', async () => {
  const { env, req, token } = await setup();
  const call = async (who, action, body) => {
    const headers = new Headers(who.headers);
    headers.set('Content-Type', 'application/json');
    const response = await onRequestPost({
      request: new Request('https://portal.test/api/team', { method: 'POST', headers, body: JSON.stringify({ action, ...body }) }), env
    });
    return { status: response.status, body: await response.json() };
  };
  const booked = await createBooking(env, token, { name: 'Cam Candidate', email: 'cam@example.com', phone: '555-0100', start: '2026-11-10T14:00:00.000Z' }, NOW);

  const asBarista = await call(req.barista, 'getCalendar', range);
  assert.equal(asBarista.status, 200);
  assert.deepEqual(Object.keys(asBarista.body.bookings[0]).sort(), ['endUtc', 'redacted', 'startUtc', 'title']);
  assert.ok(!JSON.stringify(asBarista.body).includes('Cam'));
  const asOwner = await call(req.leadA, 'getCalendar', range);
  assert.equal(asOwner.body.bookings[0].clientName, 'Cam Candidate');
  assert.equal((await call(req.leadB, 'getCalendar', range)).body.bookings[0].redacted, true);

  assert.equal((await call(req.leadA, 'getMyBookings', {})).body.bookings.length, 1);
  assert.equal((await call(req.leadB, 'getMyBookings', {})).body.bookings.length, 0);
  assert.equal((await call(req.leadB, 'getMyBookings', { all: true })).body.bookings.length, 0);
  assert.equal((await call(req.admin, 'getMyBookings', { all: true })).body.bookings[0].clientEmail, 'cam@example.com');
  assert.equal((await call(req.barista, 'getMyBookings', {})).status, 403);

  assert.equal((await call(req.leadB, 'getBooking', { bookingId: booked.booking.id })).status, 403);
  assert.equal((await call(req.admin, 'getBooking', { bookingId: booked.booking.id })).status, 200);
  assert.equal((await call(req.leadB, 'cancelBooking', { bookingId: booked.booking.id })).status, 403);
  assert.equal((await call(req.leadA, 'cancelBooking', { bookingId: booked.booking.id, reason: 'Role filled' })).status, 200);
  assert.equal((await call(req.barista, 'getCalendar', range)).body.bookings.length, 0);
});

test('every calendar action is registered on the real router', async () => {
  const { env, req } = await setup();
  for (const action of ['getCalendar', 'saveTeamEvent', 'deleteTeamEvent', 'getMyBookings', 'getBooking', 'cancelBooking']) {
    const headers = new Headers(req.barista.headers);
    headers.set('Content-Type', 'application/json');
    const response = await onRequestPost({ request: new Request('https://portal.test/api/team', { method: 'POST', headers, body: JSON.stringify({ action }) }), env });
    assert.notEqual(response.status, 404, `${action} is routed`);
  }
});

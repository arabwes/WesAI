// Calendar phase 2: Lead+ setup handlers (addresses, event types, hours,
// overrides, links), ownership rules, and the end-to-end path
// setup -> link -> slots -> booking, including through the real router.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import {
  archiveEventType, archiveMeetingLocation, createBookingLink, deleteDateOverride, getBookingAvailability, listBookingLinks,
  listEventTypes, listMeetingLocations, revokeBookingLink, saveBookingAvailability, saveDateOverride, saveEventType,
  saveMeetingLocation
} from '../functions/_lib/calendar-setup.js';
import { createBooking, getAvailableSlots, resolveLink } from '../functions/_lib/calendar.js';
import { onRequestPost } from '../functions/api/team/index.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const NOW = Date.parse('2026-11-09T12:00:00Z'); // Monday 07:00 New York
const ADDRESS = { name: 'Alpharetta shop', addressLine1: '4000 North Point Pkwy Suite 900', city: 'Alpharetta', state: 'ga', postalCode: '30022' };
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '09:00', endTime: '12:00' }));

function setup() {
  const db = createTestDatabase(MIGRATIONS);
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York' };
  const req = {
    barista: addUserWithSession(db, { id: 'u_barista', username: 'bea', name: 'Bea Barista', role: 'barista' }),
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  return { db, env, req };
}

async function seed(ctx) {
  const location = await saveMeetingLocation(ctx.req.leadA, ADDRESS, ctx.env);
  const type = await saveEventType(ctx.req.leadA, {
    name: 'Interview', description: 'Chat with us', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60
  }, ctx.env);
  await saveBookingAvailability(ctx.req.leadA, { timezone: 'America/New_York', weekly: WEEKDAYS }, ctx.env);
  return { locationId: location.id, eventTypeId: type.id };
}

const code = (status, error) => (e) => e.status === status && e.code === error;

test('every setup action is Lead+ and baristas and signed-out users are refused', async () => {
  const { req, env } = setup();
  const calls = [
    [listMeetingLocations, {}], [saveMeetingLocation, ADDRESS], [archiveMeetingLocation, { id: 'x' }], [listEventTypes, {}],
    [saveEventType, {}], [archiveEventType, { id: 'x' }], [getBookingAvailability, {}], [saveBookingAvailability, {}],
    [saveDateOverride, {}], [deleteDateOverride, {}], [createBookingLink, {}], [listBookingLinks, {}], [revokeBookingLink, {}]
  ];
  for (const [handler, payload] of calls) {
    await assert.rejects(handler(req.barista, payload, env), code(403, 'forbidden'), handler.name);
    await assert.rejects(handler(new Request('https://portal.test/'), payload, env), code(401, 'session_expired'), handler.name);
  }
});

test('meeting addresses: validated, shared across leads, and normalised', async () => {
  const ctx = setup();
  const { id } = await saveMeetingLocation(ctx.req.leadA, ADDRESS, ctx.env);
  const asLeadB = await listMeetingLocations(ctx.req.leadB, {}, ctx.env);
  assert.equal(asLeadB.locations[0].state, 'GA', 'state is upper-cased');
  await saveMeetingLocation(ctx.req.leadB, { ...ADDRESS, id, notes: 'Use side door' }, ctx.env);
  assert.equal((await listMeetingLocations(ctx.req.leadA, {}, ctx.env)).locations[0].notes, 'Use side door');
  await assert.rejects(saveMeetingLocation(ctx.req.leadA, { ...ADDRESS, state: 'Georgia' }, ctx.env), /state_too_long|invalid_state/);
  await assert.rejects(saveMeetingLocation(ctx.req.leadA, { ...ADDRESS, postalCode: 'ABCDE' }, ctx.env), /invalid_postal_code/);
  await assert.rejects(saveMeetingLocation(ctx.req.leadA, { ...ADDRESS, city: '' }, ctx.env), /city_required/);
  await assert.rejects(saveMeetingLocation(ctx.req.leadA, { ...ADDRESS, id: 'nope' }, ctx.env), code(404, 'location_not_found'));
});

test('an address cannot be archived while an active event type uses it, and archived ones leave the drop-down', async () => {
  const ctx = setup();
  const { locationId, eventTypeId } = await seed(ctx);
  await assert.rejects(archiveMeetingLocation(ctx.req.leadB, { id: locationId }, ctx.env), code(409, 'location_in_use'));
  await archiveEventType(ctx.req.leadA, { id: eventTypeId }, ctx.env);
  await archiveMeetingLocation(ctx.req.leadB, { id: locationId }, ctx.env);
  assert.equal((await listMeetingLocations(ctx.req.leadA, {}, ctx.env)).locations.length, 0);
  assert.equal((await listMeetingLocations(ctx.req.leadA, { includeArchived: true }, ctx.env)).locations.length, 1);
  await assert.rejects(saveEventType(ctx.req.leadA, { name: 'X', durationMinutes: 30, locationId }, ctx.env), /location_required/);
});

test('event types require an in-person address and valid settings', async () => {
  const ctx = setup();
  const { locationId } = await seed(ctx);
  const base = { name: 'Tasting', durationMinutes: 45, locationId };
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, locationId: '' }, ctx.env), /location_required/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, locationId: 'missing' }, ctx.env), /location_required/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, durationMinutes: 2 }, ctx.env), /invalid_duration/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, slotIntervalMinutes: 25 }, ctx.env), /invalid_slot_interval/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, maxDaysAhead: 9999 }, ctx.env), /invalid_max_days_ahead/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, name: '  ' }, ctx.env), /name_required/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, questions: Array.from({ length: 6 }, (_, i) => ({ label: `Q${i}` })) }, ctx.env), /too_many_questions/);
  await assert.rejects(saveEventType(ctx.req.leadA, { ...base, questions: [{ label: 'A', id: 'dup' }, { label: 'B', id: 'dup' }] }, ctx.env), /invalid_question_id/);
  const ok = await saveEventType(ctx.req.leadA, { ...base, questions: [{ label: 'Which position?', required: true }] }, ctx.env);
  const [saved] = (await listEventTypes(ctx.req.leadA, {}, ctx.env)).eventTypes.filter((t) => t.id === ok.id);
  assert.deepEqual(saved.questions, [{ id: 'which_position', label: 'Which position?', required: true }]);
  const long = await saveEventType(ctx.req.leadA, { ...base, name: 'Long', questions: [
    { label: 'Which position are you applying for at our Alpharetta location?' }, { label: '2nd choice?' }
  ] }, ctx.env);
  const [saved2] = (await listEventTypes(ctx.req.leadA, {}, ctx.env)).eventTypes.filter((t) => t.id === long.id);
  assert.ok(saved2.questions.every((q) => /^[a-z][a-z0-9_]{0,29}$/.test(q.id)), 'long and digit-leading labels still get valid ids');
  assert.equal(new Set(saved2.questions.map((q) => q.id)).size, 2);
  assert.equal(saved.locationName, 'Alpharetta shop');
});

test('event type slugs stay unique per owner', async () => {
  const ctx = setup();
  const { locationId } = await seed(ctx);
  const second = await saveEventType(ctx.req.leadA, { name: 'Interview', durationMinutes: 30, locationId }, ctx.env);
  const third = await saveEventType(ctx.req.leadA, { name: 'Interview', durationMinutes: 30, locationId }, ctx.env);
  assert.equal(second.slug, 'interview-2');
  assert.equal(third.slug, 'interview-3');
});

test('leads only see and edit their own event types; Management can see all', async () => {
  const ctx = setup();
  const { locationId, eventTypeId } = await seed(ctx);
  assert.equal((await listEventTypes(ctx.req.leadB, {}, ctx.env)).eventTypes.length, 0);
  assert.equal((await listEventTypes(ctx.req.leadB, { all: true }, ctx.env)).eventTypes.length, 0, 'a lead cannot widen the list');
  assert.equal((await listEventTypes(ctx.req.admin, { all: true }, ctx.env)).eventTypes.length, 1);
  const edit = { id: eventTypeId, name: 'Renamed', durationMinutes: 20, locationId };
  await assert.rejects(saveEventType(ctx.req.leadB, edit, ctx.env), code(404, 'event_type_not_found'));
  await assert.rejects(archiveEventType(ctx.req.leadB, { id: eventTypeId }, ctx.env), code(404, 'event_type_not_found'));
  await assert.rejects(createBookingLink(ctx.req.leadB, { eventTypeId }, ctx.env), code(404, 'event_type_not_found'));
  await assert.rejects(listBookingLinks(ctx.req.leadB, { eventTypeId }, ctx.env), code(404, 'event_type_not_found'));
  await saveEventType(ctx.req.admin, edit, ctx.env);
  assert.equal((await listEventTypes(ctx.req.leadA, {}, ctx.env)).eventTypes[0].name, 'Renamed');
});

test('weekly hours: saved atomically, validated, and scoped to the caller', async () => {
  const ctx = setup();
  const save = (payload, who = ctx.req.leadA) => saveBookingAvailability(who, { timezone: 'America/New_York', ...payload }, ctx.env);
  await save({ weekly: WEEKDAYS });
  let mine = await getBookingAvailability(ctx.req.leadA, {}, ctx.env);
  assert.equal(mine.weekly.length, 5);
  assert.equal((await getBookingAvailability(ctx.req.leadB, {}, ctx.env)).weekly.length, 0, 'other leads have their own hours');
  await save({ weekly: [{ weekday: 6, startTime: '10:00', endTime: '14:00' }, { weekday: 6, startTime: '15:00', endTime: '00:00' }] });
  mine = await getBookingAvailability(ctx.req.leadA, {}, ctx.env);
  assert.deepEqual(mine.weekly.map((w) => w.weekday), [6, 6], 'a save replaces the old hours');
  await assert.rejects(save({ weekly: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }, { weekday: 1, startTime: '11:00', endTime: '13:00' }] }), /overlapping_hours/);
  await assert.rejects(save({ weekly: [{ weekday: 1, startTime: '09:10', endTime: '12:00' }] }), /invalid_hours/);
  await assert.rejects(save({ weekly: [{ weekday: 1, startTime: '12:00', endTime: '09:00' }] }), /invalid_hours/);
  await assert.rejects(save({ weekly: [{ weekday: 9, startTime: '09:00', endTime: '12:00' }] }), /invalid_weekday/);
  await assert.rejects(save({ timezone: 'Mars/Base', weekly: [] }), /invalid_timezone/);
  assert.equal((await getBookingAvailability(ctx.req.leadA, {}, ctx.env)).weekly.length, 2, 'a rejected save changes nothing');
});

test('date overrides replace the weekly hours for that date and can be removed', async () => {
  const ctx = setup();
  const { eventTypeId } = await seed(ctx);
  const { url } = await createBookingLink(ctx.req.leadA, { eventTypeId }, ctx.env);
  const token = url.split('/').pop();
  const hasDay = async (day) => (await getAvailableSlots(ctx.env, token, NOW)).slots.some((s) => s.startsWith(day));
  const tuesday = '2026-11-10';
  // saveDateOverride validates against the real clock, so use a date well in the future.
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await saveDateOverride(ctx.req.leadA, { date: future, blocked: true }, ctx.env);
  await saveDateOverride(ctx.req.leadA, { date: future, windows: [{ startTime: '13:00', endTime: '15:00' }] }, ctx.env);
  const listed = await getBookingAvailability(ctx.req.leadA, {}, ctx.env);
  assert.deepEqual(listed.overrides, [{ date: future, blocked: false, windows: [{ startTime: '13:00', endTime: '15:00' }] }]);
  await saveDateOverride(ctx.req.leadA, { date: future, blocked: true }, ctx.env);
  assert.deepEqual((await getBookingAvailability(ctx.req.leadA, {}, ctx.env)).overrides, [{ date: future, blocked: true, windows: [] }]);
  await deleteDateOverride(ctx.req.leadA, { date: future }, ctx.env);
  assert.deepEqual((await getBookingAvailability(ctx.req.leadA, {}, ctx.env)).overrides, []);
  await assert.rejects(saveDateOverride(ctx.req.leadA, { date: '2020-01-01', blocked: true }, ctx.env), /invalid_date/);
  await assert.rejects(saveDateOverride(ctx.req.leadA, { date: future }, ctx.env), /hours_required/);
  assert.ok(await hasDay(tuesday), 'unrelated days are unaffected');
});

test('a blocked override removes that day from public slots', async () => {
  const ctx = setup();
  const { eventTypeId } = await seed(ctx);
  const token = (await createBookingLink(ctx.req.leadA, { eventTypeId }, ctx.env)).url.split('/').pop();
  const target = new Date(Date.now() + 5 * 86_400_000);
  // Aim at a weekday so the weekly rule would otherwise offer slots.
  while ([0, 6].includes(target.getUTCDay())) target.setUTCDate(target.getUTCDate() + 1);
  const day = target.toISOString().slice(0, 10);
  const now = Date.now();
  const before = (await getAvailableSlots(ctx.env, token, now)).slots.some((s) => s.startsWith(day) || s.startsWith(new Date(target.getTime() + 86_400_000).toISOString().slice(0, 10)));
  assert.ok(before);
  await saveDateOverride(ctx.req.leadA, { date: day, blocked: true }, ctx.env);
  const slots = (await getAvailableSlots(ctx.env, token, now)).slots;
  // 09:00-12:00 New York on `day` is 13:00-17:00Z (EST) or 14:00-16:00Z at most; none may remain.
  assert.ok(!slots.some((s) => s.startsWith(day) && s >= `${day}T08:00` && s < `${day}T20:00`));
});

test('optional avoid-shifts hides slots that overlap the owner\'s published shifts only', async () => {
  const ctx = setup();
  const { eventTypeId } = await seed(ctx);
  const token = (await createBookingLink(ctx.req.leadA, { eventTypeId }, ctx.env)).url.split('/').pop();
  const stamp = new Date().toISOString();
  const locationId = ctx.db.raw.prepare('SELECT id FROM locations LIMIT 1').get().id;
  const makeSchedule = (id, week, status) => ctx.db.raw.prepare(`INSERT INTO schedules (id, location_id, week_start, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'u_admin', ?, ?)`).run(id, locationId, week, status, stamp, stamp);
  makeSchedule('sch_pub', '2026-11-09', 'published');
  makeSchedule('sch_draft', '2026-11-16', 'draft');
  const makeShift = (id, schedule, employee, date, start, end, status = 'active') => ctx.db.raw.prepare(`INSERT INTO shifts
    (id, schedule_id, employee_id, shift_date, start_time, end_time, status, created_by, created_at, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'u_admin', ?, 'u_admin', ?)`).run(id, schedule, employee, date, start, end, status, stamp, stamp);
  makeShift('s1', 'sch_pub', 'u_leada', '2026-11-10', '09:00', '10:30'); // published, mine
  makeShift('s2', 'sch_pub', 'u_leadb', '2026-11-11', '09:00', '12:00'); // someone else's
  makeShift('s3', 'sch_draft', 'u_leada', '2026-11-17', '09:00', '12:00'); // draft schedule
  makeShift('s4', 'sch_pub', 'u_leada', '2026-11-12', '09:00', '12:00', 'cancelled'); // cancelled
  const slotsOn = async (day) => (await getAvailableSlots(ctx.env, token, NOW)).slots.filter((s) => s.startsWith(day));

  assert.ok((await slotsOn('2026-11-10')).includes('2026-11-10T14:00:00.000Z'), 'off by default: shifts are ignored');
  await saveBookingAvailability(ctx.req.leadA, { timezone: 'America/New_York', weekly: WEEKDAYS, avoidShifts: true }, ctx.env);
  const tuesday = await slotsOn('2026-11-10');
  assert.ok(!tuesday.includes('2026-11-10T14:00:00.000Z') && !tuesday.includes('2026-11-10T15:00:00.000Z'), '09:00-10:30 is blocked');
  assert.ok(tuesday.includes('2026-11-10T15:30:00.000Z'), '10:30 is free again');
  assert.ok((await slotsOn('2026-11-11')).includes('2026-11-11T14:00:00.000Z'), "another person's shift does not block");
  assert.ok((await slotsOn('2026-11-17')).includes('2026-11-17T14:00:00.000Z'), 'draft schedules do not block');
  assert.ok((await slotsOn('2026-11-12')).includes('2026-11-12T14:00:00.000Z'), 'cancelled shifts do not block');
});

test('links: created once, never listed with their token, revocable by owner or Management only', async () => {
  const ctx = setup();
  const { eventTypeId } = await seed(ctx);
  const created = await createBookingLink(ctx.req.leadA, { eventTypeId, label: 'Spring hiring', maxUses: '' }, ctx.env);
  assert.match(created.url, /^https:\/\/portal\.test\/book\/[A-Za-z0-9_-]{43}$/);
  const token = created.url.split('/').pop();
  await resolveLink(ctx.env, token, NOW);
  const listed = await listBookingLinks(ctx.req.leadA, { eventTypeId }, ctx.env);
  assert.equal(listed.links[0].status, 'active');
  assert.equal(listed.links[0].label, 'Spring hiring');
  assert.equal(listed.links[0].maxUses, null, 'reusable by default');
  assert.ok(!JSON.stringify(listed).includes(token));
  assert.ok(!JSON.stringify(listed).includes('token_hash'));
  await assert.rejects(revokeBookingLink(ctx.req.leadB, { linkId: created.id }, ctx.env), code(404, 'link_not_found'));
  await assert.rejects(revokeBookingLink(ctx.req.barista, { linkId: created.id }, ctx.env), code(403, 'forbidden'));
  await revokeBookingLink(ctx.req.admin, { linkId: created.id }, ctx.env);
  await assert.rejects(resolveLink(ctx.env, token, NOW), /link_not_found/);
  assert.equal((await listBookingLinks(ctx.req.leadA, { eventTypeId }, ctx.env)).links[0].status, 'revoked');
});

test('link options: expiry and use caps are validated and reported', async () => {
  const ctx = setup();
  const { eventTypeId } = await seed(ctx);
  await assert.rejects(createBookingLink(ctx.req.leadA, { eventTypeId, expiresOn: '2020-01-01' }, ctx.env), /invalid_expiry/);
  await assert.rejects(createBookingLink(ctx.req.leadA, { eventTypeId, maxUses: 0 }, ctx.env), /invalid_max_uses/);
  await assert.rejects(createBookingLink(ctx.req.leadA, { eventTypeId, maxUses: 1.5 }, ctx.env), /invalid_max_uses/);
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await createBookingLink(ctx.req.leadA, { eventTypeId, expiresOn: future, maxUses: 3 }, ctx.env);
  const [link] = (await listBookingLinks(ctx.req.leadA, { eventTypeId }, ctx.env)).links;
  assert.equal(link.maxUses, 3);
  assert.ok(link.expiresAt.startsWith(future));
  await archiveEventType(ctx.req.leadA, { id: eventTypeId }, ctx.env);
  await assert.rejects(createBookingLink(ctx.req.leadA, { eventTypeId }, ctx.env), code(409, 'event_type_archived'));
});

test('archiving an event type takes its links offline but keeps bookings', async () => {
  const ctx = setup();
  const { eventTypeId } = await seed(ctx);
  const token = (await createBookingLink(ctx.req.leadA, { eventTypeId }, ctx.env)).url.split('/').pop();
  await createBooking(ctx.env, token, { name: 'Cam', email: 'cam@example.com', start: '2026-11-10T14:00:00.000Z' }, NOW);
  await archiveEventType(ctx.req.leadA, { id: eventTypeId }, ctx.env);
  await assert.rejects(resolveLink(ctx.env, token, NOW), /link_not_found/);
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
  await archiveEventType(ctx.req.leadA, { id: eventTypeId, archived: false }, ctx.env);
  await resolveLink(ctx.env, token, NOW);
});

test('end to end through the real router: set up, create a link, then candidates book it', async () => {
  const ctx = setup();
  const call = async (who, action, body) => {
    const headers = new Headers(who.headers);
    headers.set('Content-Type', 'application/json');
    const response = await onRequestPost({
      request: new Request('https://portal.test/api/team', { method: 'POST', headers, body: JSON.stringify({ action, ...body }) }),
      env: ctx.env
    });
    return { status: response.status, body: await response.json() };
  };
  const location = await call(ctx.req.leadA, 'saveMeetingLocation', ADDRESS);
  assert.equal(location.status, 200);
  const type = await call(ctx.req.leadA, 'saveEventType', { name: 'Interview', durationMinutes: 30, locationId: location.body.id, minNoticeMinutes: 60 });
  assert.equal(type.status, 200);
  assert.equal((await call(ctx.req.leadA, 'saveBookingAvailability', { timezone: 'America/New_York', weekly: WEEKDAYS })).status, 200);
  const link = await call(ctx.req.leadA, 'createBookingLink', { eventTypeId: type.body.id, label: 'Candidates' });
  assert.equal(link.status, 200);
  const token = link.body.url.split('/').pop();
  const first = await createBooking(ctx.env, token, { name: 'Cam', email: 'cam@example.com', start: '2026-11-10T14:00:00.000Z' }, NOW);
  const second = await createBooking(ctx.env, token, { name: 'Dee', email: 'dee@example.com', start: '2026-11-10T14:30:00.000Z' }, NOW);
  assert.ok(first.ok && second.ok, 'one reusable link serves many candidates');
  // Errors surface as clean API responses, not 500s.
  const denied = await call(ctx.req.barista, 'listEventTypes', {});
  assert.deepEqual([denied.status, denied.body.error], [403, 'forbidden']);
  const bad = await call(ctx.req.leadA, 'saveEventType', { name: 'No address', durationMinutes: 30 });
  assert.deepEqual([bad.status, bad.body.error], [400, 'location_required']);
  const lockedOut = await call(ctx.req.leadB, 'createBookingLink', { eventTypeId: type.body.id });
  assert.deepEqual([lockedOut.status, lockedOut.body.error], [404, 'event_type_not_found']);
});

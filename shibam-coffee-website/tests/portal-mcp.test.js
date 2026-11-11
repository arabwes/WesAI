// Portal MCP connector tools: they run the portal's own code as the connected person, and only
// allow-listed fields ever leave. Real portal handlers, real SQLite database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { addUserWithSession, createTestDatabase } from './helpers/d1-sqlite.js';
import { actAs, getSession } from '../functions/_lib/auth.js';
import { createBookingLink, saveBookingAvailability, saveEventType, saveMeetingLocation } from '../functions/_lib/calendar-setup.js';
import { createBooking, getAvailableSlots } from '../functions/_lib/calendar.js';
import { saveTeamEvent } from '../functions/_lib/calendar-team.js';
import { getCateringRequests, submitCateringRequest } from '../functions/_lib/catering.js';
import { replyToInquiry, sendCateringMessage } from '../functions/_lib/catering-conversation.js';
import { enforceRateLimit, loadConnectedUser, runTool, TOOLS } from '../workers/portal-mcp/src/tools.js';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const code = (c) => (e) => e.code === c;

async function setup() {
  const db = createTestDatabase(MIGRATIONS);
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York', PUBLIC_ORIGIN: 'https://shibamatlanta.com', NOTIFICATIONS: { send: async () => {} } };
  const req = {
    barista: addUserWithSession(db, { id: 'u_barista', username: 'bea', name: 'Bea Barista', role: 'barista' }),
    leadA: addUserWithSession(db, { id: 'u_leada', username: 'ana', name: 'Ana Lead', role: 'lead' }),
    leadB: addUserWithSession(db, { id: 'u_leadb', username: 'ben', name: 'Ben Lead', role: 'lead' }),
    admin: addUserWithSession(db, { id: 'u_admin', username: 'max', name: 'Max Admin', role: 'management' })
  };
  db.raw.prepare("UPDATE users SET email = id || '@staff.example', password_hash = 'HASH-SECRET', password_salt = 'SALT-SECRET'").run();
  return { db, env, req };
}

const as = (userId, clientName = 'Claude') => ({ userId, clientName });

// A realistic store: an inventory count, a published schedule, calendar events and a booking,
// catering requests with a conversation, and meeting types with links.
async function seedEverything(ctx) {
  const { db, env, req } = ctx;
  const now = new Date().toISOString();
  // Inventory: two sections, three items (one with no order-below level), one count, one draft.
  db.raw.prepare("INSERT INTO inventory_sections (id, name, sort_order, status, created_at) VALUES ('sec_walk', 'Walk-in cooler', 1, 'active', ?), ('sec_dry', 'Dry storage', 2, 'active', ?)").run(now, now);
  db.raw.prepare("UPDATE catalog SET section_id = 'sec_walk', threshold = '4', unit = 'gal', name = 'Whole milk' WHERE id = 'catalog_seed_0001'").run();
  db.raw.prepare("UPDATE catalog SET section_id = 'sec_walk', threshold = '2', unit = 'gal', name = 'Oat milk' WHERE id = 'catalog_seed_0002'").run();
  db.raw.prepare("UPDATE catalog SET section_id = 'sec_dry', threshold = '', unit = 'lb', name = 'Cardamom' WHERE id = 'catalog_seed_0003'").run();
  db.raw.prepare("INSERT INTO inventory_counts (id, status, count_date, contributors_json, started_at, updated_at, submitted_by, submitted_at) VALUES ('count1', 'submitted', '2026-11-08', '[\"Ana Lead\"]', ?, ?, 'u_leada', '2026-11-08T15:00:00.000Z')").run(now, now);
  const entry = db.raw.prepare("INSERT INTO form_entries (id, form_type, submitted_at, employee_id, employee_name, entry_date, product, details_json, submission_id, catalog_id) VALUES (?, 'inventory', ?, 'u_leada', 'Ana Lead', '2026-11-08', ?, ?, 'count1', ?)");
  entry.run('e1', now, 'Whole milk', JSON.stringify({ product: 'Whole milk', qtyKitchen: 1, qtyStorage: 2, notes: 'one case expires Friday' }), 'catalog_seed_0001');
  entry.run('e2', now, 'Oat milk', JSON.stringify({ product: 'Oat milk', qtyKitchen: 3, qtyStorage: 1 }), 'catalog_seed_0002');
  entry.run('e3', now, 'Cardamom', JSON.stringify({ product: 'Cardamom', qtyKitchen: 0.5, qtyStorage: 0 }), 'catalog_seed_0003');
  entry.run('e4', now, 'Removed thing', '{"removed":true}', 'catalog_seed_0004');
  db.raw.prepare("INSERT INTO inventory_counts (id, status, count_date, draft_json, started_by_name, started_at, updated_at) VALUES ('draft1', 'draft', '2026-11-15', ?, 'Ben Lead', ?, ?)").run(JSON.stringify({ items: { a: {}, b: {} } }), now, now);

  // Schedule: a published week with an assigned shift, an open shift, a cancelled shift and time off.
  db.raw.prepare("INSERT INTO schedules (id, location_id, week_start, status, published_at, created_by, created_at, updated_at) VALUES ('sch1', 'atlanta', '2026-11-09', 'published', ?, 'u_admin', ?, ?)").run(now, now, now);
  const shift = db.raw.prepare("INSERT INTO shifts (id, schedule_id, employee_id, position_id, shift_date, start_time, end_time, status, notes, created_by, created_at, updated_by, updated_at) VALUES (?, 'sch1', ?, 'position-barista', ?, ?, ?, ?, ?, 'u_admin', ?, 'u_admin', ?)");
  shift.run('s1', 'u_barista', '2026-11-10', '07:00', '15:00', 'active', 'Open the store', now, now);
  shift.run('s2', null, '2026-11-11', '12:00', '20:00', 'active', '', now, now);
  shift.run('s3', 'u_leada', '2026-11-12', '07:00', '15:00', 'cancelled', '', now, now);
  db.raw.prepare("INSERT INTO time_off_requests (id, employee_id, start_date, end_date, request_type, reason, status, submitted_at) VALUES ('to1', 'u_leadb', '2026-11-13', '2026-11-13', 'sick', 'MEDICAL-REASON-PRIVATE', 'approved', ?)").run(now);

  // Calendar + booking (Ana's interview link, booked by a candidate).
  const location = await saveMeetingLocation(req.leadA, { name: 'Shop', addressLine1: '1 Main St', city: 'Alpharetta', state: 'GA', postalCode: '30022' }, env);
  const type = await saveEventType(req.leadA, { name: 'Barista interview', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60 }, env);
  await saveBookingAvailability(req.leadA, { timezone: 'America/New_York', weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00' })) }, env);
  const link = await createBookingLink(req.leadA, { eventTypeId: type.id, label: 'Spring hiring' }, env);
  const linkToken = link.url.split('/').pop();
  const slot = (await getAvailableSlots(env, linkToken)).slots[0];
  const booking = await createBooking(env, linkToken, { name: 'Cam Candidate', email: 'cam@candidate.example', phone: '555-0199', start: slot });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(slot));
  await saveTeamEvent(req.leadA, { title: 'Supplier tasting', date: day, startTime: '17:30', endTime: '18:30', location: 'Back room' }, env);

  // Catering: a request with a reply, an internal note and an unread customer reply.
  const requestId = (await submitCateringRequest(new Request('https://x.test'), {
    name: 'Casey Customer', email: 'casey@customer.example', phone: '555-0123', eventType: 'Corporate', eventDate: '2026-12-10', guestCount: '40', details: 'Team lunch'
  }, env)).requestId;
  await sendCateringMessage(req.leadA, { requestId, body: 'We can do Dec 10.' }, env);
  await sendCateringMessage(req.leadA, { requestId, body: 'Internal: offer 10% off', internal: true }, env);
  const threadToken = db.raw.prepare('SELECT thread_token FROM catering_requests').get().thread_token;
  await replyToInquiry(env, threadToken, 'Great, see you then.');
  return { day, slot, linkToken, manageToken: booking.manageToken, threadToken, requestId };
}

// ---------------- who may use it ----------------

test('only active Leads and Management can use the connector; changes take effect immediately', async () => {
  const { env, db } = await setup();
  await assert.rejects(loadConnectedUser(env, 'u_barista'), code('role_not_allowed'));
  await assert.rejects(loadConnectedUser(env, 'nobody'), code('account_inactive'));
  await assert.rejects(loadConnectedUser(env, ''), code('account_inactive'));
  assert.equal((await loadConnectedUser(env, 'u_leada')).role, 'lead');
  assert.equal((await runTool(env, as('u_leada'), 'portal_whoami')).name, 'Ana Lead');
  db.raw.prepare("UPDATE users SET active = 0 WHERE id = 'u_leada'").run(); // someone leaves
  await assert.rejects(runTool(env, as('u_leada'), 'portal_whoami'), code('account_inactive'));
  db.raw.prepare("UPDATE users SET active = 1, role = 'barista' WHERE id = 'u_leada'").run(); // or is demoted
  await assert.rejects(runTool(env, as('u_leada'), 'portal_whoami'), code('role_not_allowed'));
});

test('unknown tools, inherited names and a flood of calls are refused', async () => {
  const { env } = await setup();
  for (const name of ['nope', 'constructor', 'toString', '__proto__']) {
    await assert.rejects(runTool(env, as('u_admin'), name), code('unknown_tool'), name);
  }
  const now = Date.parse('2026-11-11T10:00:30Z');
  for (let i = 0; i < 120; i += 1) await enforceRateLimit(env, 'u_admin', now);
  await assert.rejects(enforceRateLimit(env, 'u_admin', now), code('rate_limited'));
  await enforceRateLimit(env, 'u_leada', now); // other people are unaffected
  await enforceRateLimit(env, 'u_admin', now + 60_000); // and the next minute starts fresh
});

test('every call is recorded in the audit log with the app\'s name', async () => {
  const { env, db } = await setup();
  await runTool(env, as('u_leada', 'Claude'), 'portal_whoami');
  const row = db.raw.prepare("SELECT actor_user_id, action, details_json FROM audit_events WHERE action LIKE 'mcp.%'").get();
  assert.deepEqual({ ...row }, { actor_user_id: 'u_leada', action: 'mcp.portal_whoami', details_json: '{"client":"Claude"}' });
});

test('the trusted identity cannot be claimed from outside', async () => {
  const { env } = await setup();
  // A request the connector did not register carries no identity, whatever its body says.
  assert.equal(await getSession(new Request('https://x.test/api/team'), { token: 'u_admin', sessionToken: 'u_admin' }, env), null);
  assert.throws(() => actAs({ headers: new Headers() }, { id: 'u_admin', role: 'management' }), /needs a Request/);
  assert.throws(() => actAs(new Request('https://x.test'), { id: 'u_admin', role: 'owner' }), /needs a Request/);
  const trusted = actAs(new Request('https://x.test'), { id: 'u_admin', role: 'management', name: 'Max Admin' });
  assert.equal((await getSession(trusted, {}, env)).id, 'u_admin');
  assert.equal(await getSession(new Request(trusted), {}, env), null, 'a copy of a trusted request is not trusted');
});

// ---------------- each tool ----------------

test('inventory: latest count with totals, order-below flags, sections and the count in progress', async () => {
  const ctx = await setup();
  await seedEverything(ctx);
  const all = await runTool(ctx.env, as('u_leada'), 'inventory_latest_count');
  assert.equal(all.count.count_date, '2026-11-08');
  assert.equal(all.count.submitted_by, 'Ana Lead');
  assert.deepEqual(all.items.map((i) => [i.item, i.section, i.total, i.order_below, i.below_threshold]), [
    ['Whole milk', 'Walk-in cooler', 3, 4, true],
    ['Oat milk', 'Walk-in cooler', 4, 2, false],
    ['Cardamom', 'Dry storage', 0.5, null, null]
  ]);
  assert.equal(all.items[0].note, 'one case expires Friday');
  assert.equal(all.items_without_order_below_level, 1);
  assert.deepEqual(all.in_progress, { count_date: '2026-11-15', started_by: 'Ben Lead', last_saved: all.in_progress.last_saved, items_entered: 2 });
  assert.deepEqual((await runTool(ctx.env, as('u_leada'), 'inventory_latest_count', { only_below_threshold: true })).items.map((i) => i.item), ['Whole milk']);
  assert.deepEqual((await runTool(ctx.env, as('u_leada'), 'inventory_latest_count', { section: 'dry' })).items.map((i) => i.item), ['Cardamom']);
});

test('inventory: a store with no submitted count says so', async () => {
  const { env } = await setup();
  const result = await runTool(env, as('u_admin'), 'inventory_latest_count');
  assert.equal(result.count, null);
  assert.match(result.message, /No inventory count/);
});

test('schedule: shifts, open shifts and who is off, never why; cancelled shifts left out', async () => {
  const ctx = await setup();
  await seedEverything(ctx);
  const week = await runTool(ctx.env, as('u_leada'), 'schedule_week', { week_start: '2026-11-12' });
  assert.equal(week.week_start, '2026-11-09', 'any date in the week works');
  assert.equal(week.status, 'published');
  assert.deepEqual(week.shifts.map((s) => [s.date, s.start, s.employee, s.open_shift, s.position]), [
    ['2026-11-10', '07:00', 'Bea Barista', false, 'Barista'],
    ['2026-11-11', '12:00', null, true, 'Barista']
  ]);
  assert.equal(week.open_shifts, 1);
  assert.deepEqual(week.time_off.map((t) => [t.employee, t.from, t.status]), [['Ben Lead', '2026-11-13', 'approved']]);
  assert.ok(!JSON.stringify(week).includes('MEDICAL-REASON-PRIVATE'));
  assert.ok(!JSON.stringify(await runTool(ctx.env, as('u_admin'), 'schedule_week', { week_start: '2026-11-12' })).includes('MEDICAL'), 'not even for Management');
  const empty = await runTool(ctx.env, as('u_leada'), 'schedule_week', { week_start: '2027-02-01' });
  assert.equal(empty.status, 'not created');
});

test('calendar: events, and meetings without any invitee details, even for the host', async () => {
  const ctx = await setup();
  const seeded = await seedEverything(ctx);
  const range = { from: seeded.day, to: seeded.day };
  const host = await runTool(ctx.env, as('u_leada'), 'team_calendar', range);
  assert.deepEqual(host.meetings.map((m) => [m.title, m.yours]), [['Barista interview', true]]);
  assert.equal(host.events[0].title, 'Supplier tasting');
  const other = await runTool(ctx.env, as('u_leadb'), 'team_calendar', range);
  assert.deepEqual(other.meetings.map((m) => [m.title, m.yours]), [['Booked', false]]);
  for (const view of [host, other, await runTool(ctx.env, as('u_admin'), 'team_calendar', range)]) {
    const wire = JSON.stringify(view);
    for (const secret of ['Cam', 'cam@candidate', '555-0199']) assert.ok(!wire.includes(secret), `leaked ${secret}`);
  }
  await assert.rejects(runTool(ctx.env, as('u_admin'), 'team_calendar', { from: '2026-01-01', to: '2026-12-31' }), code('range_too_large'));
});

test('catering: requests and conversations without customer details, and reading does not mark replies read', async () => {
  const ctx = await setup();
  const seeded = await seedEverything(ctx);
  const list = await runTool(ctx.env, as('u_leadb'), 'catering_requests');
  assert.equal(list.unread_conversations, 1);
  assert.deepEqual(list.requests.map((r) => [r.event_type, r.guest_count, r.messages, r.unread_replies, r.handled_by]), [['Corporate', 40, 2, 1, 'Ana Lead']]);
  const thread = await runTool(ctx.env, as('u_leadb'), 'catering_conversation', { request_id: seeded.requestId });
  assert.deepEqual(thread.messages.map((m) => [m.from, m.author, m.text]), [
    ['team', 'Ana Lead', 'We can do Dec 10.'],
    ['internal note', 'Ana Lead', 'Internal: offer 10% off'],
    ['customer', 'Customer', 'Great, see you then.']
  ]);
  // The portal still shows the reply as unread: the AI reading it did not clear the badge.
  assert.equal((await getCateringRequests(ctx.req.leadA, {}, ctx.env)).unreadReplies, 1);
  for (const view of [list, thread]) {
    const wire = JSON.stringify(view);
    for (const secret of ['Casey', 'casey@customer', '555-0123', seeded.threadToken, '/inquiry/']) assert.ok(!wire.includes(secret), `leaked ${secret}`);
  }
  await assert.rejects(runTool(ctx.env, as('u_admin'), 'catering_conversation', { request_id: 'missing' }), code('not_found'));
});

test('meeting types: status and counts, never the private link addresses', async () => {
  const ctx = await setup();
  const seeded = await seedEverything(ctx);
  const mine = await runTool(ctx.env, as('u_leada'), 'meeting_types');
  assert.deepEqual(mine.meeting_types.map((t) => [t.name, t.owner, t.length_minutes, t.links.map((l) => [l.label, l.status, l.booked])]),
    [['Barista interview', 'Ana Lead', 30, [['Spring hiring', 'active', 1]]]]);
  assert.equal((await runTool(ctx.env, as('u_leadb'), 'meeting_types')).meeting_types.length, 0, 'a lead sees only their own');
  assert.equal((await runTool(ctx.env, as('u_admin'), 'meeting_types')).meeting_types.length, 1, 'Management sees everyone\'s');
  assert.ok(!JSON.stringify(mine).includes(seeded.linkToken));
  assert.ok(!JSON.stringify(mine).includes('/book/'));
});

test('nothing private leaves through any tool, for any role', async () => {
  const ctx = await setup();
  const seeded = await seedEverything(ctx);
  const secrets = [
    'casey@customer.example', '555-0123', 'Casey', 'cam@candidate.example', '555-0199', 'Cam Candidate',
    seeded.linkToken, seeded.manageToken, seeded.threadToken, '/book/', '/inquiry/', 'MEDICAL-REASON-PRIVATE',
    '@staff.example', 'HASH-SECRET', 'SALT-SECRET', 'token-u_', 'password', 'thread_token', 'token_hash'
  ];
  const args = {
    portal_whoami: {}, inventory_latest_count: {}, schedule_week: { week_start: '2026-11-10' },
    team_calendar: { from: seeded.day, to: seeded.day }, catering_requests: {}, catering_conversation: { request_id: seeded.requestId }, meeting_types: {}
  };
  assert.deepEqual(Object.keys(args).sort(), Object.keys(TOOLS).sort(), 'every tool is covered');
  for (const userId of ['u_leada', 'u_leadb', 'u_admin']) {
    for (const [name, input] of Object.entries(args)) {
      const wire = JSON.stringify(await runTool(ctx.env, as(userId), name, input)).replace(/"cannot":\[[^\]]*\]|"can_see":\[[^\]]*\]/g, '');
      for (const secret of secrets) assert.ok(!wire.includes(secret), `${name} as ${userId} leaked ${secret}`);
    }
  }
});

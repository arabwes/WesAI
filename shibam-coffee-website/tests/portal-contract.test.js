import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('portal configuration uses the same-origin Cloudflare API', async () => {
  const config = await source('team/js/config.js');
  assert.match(config, /API_URL:\s*["']\/api\/team["']/);
  assert.doesNotMatch(config, /script\.google\.com/);
});

test('employee and manager pages are protected and load their controllers', async () => {
  const employee = await source('team/schedule.html');
  const manager = await source('team/manage-schedule.html');
  assert.match(employee, /data-require-role="barista"/);
  assert.match(employee, /\/team\/js\/schedule\.js/);
  assert.match(manager, /data-require-role="lead"/);
  assert.match(manager, /\/team\/js\/manage-schedule\.js/);
});

test('backend router exposes the scheduling MVP actions', async () => {
  const router = await source('functions/api/team/index.js');
  for (const action of [
    'getManagerSchedule', 'getMySchedule', 'saveShift', 'publishSchedule',
    'saveAvailability', 'replaceAvailability', 'saveAvailabilityException',
    'deleteAvailabilityException', 'submitTimeOff', 'reviewTimeOff', 'requestOpenShift',
    'reviewShiftRequest', 'confirmShift'
  ]) assert.match(router, new RegExp(`\\b${action}\\b`));
});

test('availability UI exposes a weekly editor and date-exception calendar', async () => {
  const page = await source('team/schedule.html');
  const controller = await source('team/js/schedule.js');
  assert.match(page, /id="weekly-availability-editor"/);
  assert.match(page, /id="availability-calendar-grid"/);
  assert.match(page, /id="availability-exception-dialog"/);
  assert.match(controller, /saveAvailabilitySet/);
  assert.match(controller, /saveAvailabilityException/);
});

test('high and medium scheduling actions are routed', async () => {
  const router = await source('functions/api/team/index.js');
  for (const action of [
    'cancelTimeOffRequest', 'cancelOpenShiftRequest', 'createExchangeRequest',
    'reviewExchangeRequest', 'createTemplateFromSchedule', 'applyScheduleTemplate',
    'generateScheduleRotation', 'getTeamCoverage', 'restoreScheduleVersion',
    'createCalendarToken', 'saveAvailabilitySet', 'saveRepeatingAvailabilityException',
    'createInvitation', 'acceptInvitation', 'registerPushSubscription', 'verifyPhone'
  ]) assert.match(router, new RegExp(`\\b${action}\\b`));
});

test('expanded scheduling UI exposes employee and manager workflows', async () => {
  const employee = await source('team/schedule.html');
  const manager = await source('team/manage-schedule.html');
  const profile = await source('team/profile.html');
  assert.match(employee, /id="exchange-list"/);
  assert.match(employee, /id="availability-set-select"/);
  assert.match(manager, /id="manager-exchanges"/);
  assert.match(manager, /id="template-list"/);
  assert.match(manager, /id="coverage-heatmap"/);
  assert.match(manager, /id="schedule-history"/);
  assert.match(profile, /id="notification-preferences-form"/);
  assert.match(profile, /id="create-calendar"/);
  assert.match(profile, /id="enable-push"/);
  assert.match(profile, /id="notification-quiet-start"/);
  const auth = await source('team/js/auth.js');
  assert.match(auth, /serviceWorker\.register\('\/team\/sw\.js'\)/);
});

test('employee administration supports positions, weekly limits, and safe management changes', async () => {
  const page = await source('team/admin.html');
  const controller = await source('team/js/admin.js');
  const server = await source('functions/_lib/scheduling-extended.js');
  assert.match(page, /id="invitation-positions"/);
  assert.match(page, /id="new-user-positions"/);
  assert.match(controller, /positionIds: selectedPositions/);
  assert.match(controller, /updateManagedUser/);
  assert.match(server, /cannot_remove_last_management/);
  assert.match(server, /email_taken/);
});

test('template override reasons are resubmitted and SMS requests are size-limited', async () => {
  const workforce = await source('team/js/workforce.js');
  const sms = await source('functions/api/team/sms.js');
  assert.match(workforce, /overrideReason: overrideReason/);
  assert.match(workforce, /applyTemplate\(template, replace, reason\.trim\(\)\)/);
  assert.match(sms, /16 \* 1024/);
  assert.match(sms, /status: 413/);
});

test('private calendar, SMS webhook, and multichannel Worker exist', async () => {
  const calendar = await source('functions/api/team/calendar/[token].js');
  const sms = await source('functions/api/team/sms.js');
  const worker = await source('workers/notifications/src/index.js');
  assert.match(calendar, /text\/calendar/);
  assert.match(calendar, /token_hash/);
  assert.match(sms, /X-Twilio-Signature/);
  assert.match(worker, /buildPushHTTPRequest/);
  assert.match(worker, /TWILIO_AUTH_TOKEN/);
  assert.match(worker, /RESEND_API_KEY/);
});

test('migration adds exchange, template, history, profile, and delivery tables', async () => {
  const migration = await source('migrations/0002_scheduling_high_medium.sql');
  for (const table of [
    'shift_exchange_requests', 'schedule_templates', 'schedule_rotations',
    'availability_rule_sets', 'schedule_versions', 'calendar_tokens',
    'user_invitations', 'push_subscriptions', 'notification_deliveries', 'sms_opt_outs'
  ]) assert.match(migration, new RegExp(`CREATE TABLE ${table}\\b`));
});

test('browser session token is kept in an HttpOnly cookie', async () => {
  const browserAuth = await source('team/js/auth.js');
  const serverAuth = await source('functions/_lib/auth.js');
  assert.doesNotMatch(browserAuth, /result\.token/);
  assert.match(serverAuth, /HttpOnly; SameSite=Strict/);
  assert.match(serverAuth, /PBKDF2_ITERATIONS = 100_000/);
});

test('login only resets a Turnstile widget after one was rendered', async () => {
  const browserAuth = await source('team/js/auth.js');
  assert.match(browserAuth, /turnstileWidgetId !== null/);
  assert.match(browserAuth, /turnstile\.reset\(turnstileWidgetId\)/);
  assert.match(browserAuth, /turnstileWidgetId = window\.turnstile\.render/);
});

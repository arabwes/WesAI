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
    'saveAvailability', 'submitTimeOff', 'reviewTimeOff', 'requestOpenShift',
    'reviewShiftRequest', 'confirmShift'
  ]) assert.match(router, new RegExp(`\\b${action}\\b`));
});

test('browser session token is kept in an HttpOnly cookie', async () => {
  const browserAuth = await source('team/js/auth.js');
  const serverAuth = await source('functions/_lib/auth.js');
  assert.doesNotMatch(browserAuth, /result\.token/);
  assert.match(serverAuth, /HttpOnly; SameSite=Strict/);
});

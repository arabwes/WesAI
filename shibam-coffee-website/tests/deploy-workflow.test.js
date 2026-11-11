// Guards the automatic Cloudflare deploy workflow. It can change the live database on its own,
// so the safety properties below must not be edited away by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const text = readFileSync(new URL('../../.github/workflows/deploy-cloudflare.yml', import.meta.url), 'utf8');
const at = (needle) => {
  const index = text.indexOf(needle);
  assert.ok(index >= 0, `workflow contains: ${needle}`);
  return index;
};

test('runs on its own for pushes to main that change the database or the Worker, and can still be run by hand', () => {
  assert.match(text, /on:\n  push:\n    branches: \[main\]\n    paths:/);
  for (const path of ['shibam-coffee-website/migrations/**', 'shibam-coffee-website/workers/notifications/**', 'shibam-coffee-website/functions/_lib/**']) {
    assert.ok(text.includes(`"${path}"`), `push trigger covers ${path}`);
  }
  assert.match(text, /workflow_dispatch:[\s\S]*default: check/, 'manual runs default to the harmless check');
  assert.doesNotMatch(text, /pull_request/, 'never runs for pull requests, which could expose the Cloudflare secrets');
});

test('pushes deploy, manual runs use the chosen mode, and every change step is gated on deploy mode', () => {
  assert.match(text, /MODE: \$\{\{ inputs\.mode \|\| 'deploy' \}\}/);
  const steps = text.split(/\n      - /).slice(1);
  const changing = steps.filter((step) => /\(deploy only\)|\(automatic runs only\)/.test(step.split('\n')[0]) || /Save a database restore point/.test(step.split('\n')[0]));
  assert.ok(changing.length >= 6, 'the tests, pause, restore point, migrate, deploy, confirm and live-check steps are all marked');
  for (const step of changing) {
    assert.match(step, /if: env\.MODE == 'deploy'/, `gated: ${step.split('\n')[0]}`);
  }
});

test('an automatic run waits exactly 30 seconds, only for pushes, after the tests and before anything changes', () => {
  const pause = text.slice(at('name: Pause 30 seconds'), at('name: Save a database restore point'));
  assert.match(pause, /github\.event_name == 'push'/, 'the pause is skipped when a person clicks Run workflow');
  const waits = [...pause.matchAll(/for left in ([\d ]+); do/g)];
  assert.equal(waits.length, 1);
  const counts = waits[0][1].trim().split(/\s+/).length;
  const sleepEach = Number(pause.match(/sleep (\d+)/)[1]);
  assert.equal(counts * sleepEach, 30, 'countdown adds up to 30 seconds');
  assert.match(pause, /cancel/i, 'tells people how to stop it');
  assert.ok(at('name: Tests (deploy only)') < at('name: Pause 30 seconds'), 'tests run before the pause');
});

test('order: restore point, then migrations, then the Worker, then the live check', () => {
  const order = ['name: Pause 30 seconds', 'name: Save a database restore point', 'name: Apply database migrations', 'name: Deploy the notification Worker', 'name: Confirm no migrations are left', 'name: Check the live booking page and API'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('a deploy that is already running is never cancelled halfway, and a failed run explains how to restore', () => {
  assert.match(text, /concurrency:\n  group: cloudflare-production\n  cancel-in-progress: false/);
  assert.match(text, /time-travel restore shibam-team --bookmark=/);
  assert.match(text, /if: failure\(\) && env\.MODE == 'deploy'/);
});

test('a failed restore-point step never blocks the deploy, and the bookmark is read from Wrangler\'s own message', () => {
  const step = text.slice(at('name: Save a database restore point'), at('name: Apply database migrations'));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /current bookmark is/);
});

test('the portal AI connector deploys only when switched on, and with any change to the portal code it bundles', () => {
  for (const path of ['shibam-coffee-website/functions/_lib/**', 'shibam-coffee-website/workers/portal-mcp/**']) {
    assert.ok(text.includes(`"${path}"`), `push trigger covers ${path}`);
  }
  const step = text.slice(at('name: Deploy the portal AI connector'), at('name: Confirm no migrations are left'));
  assert.match(step, /if: env\.MODE == 'deploy' && env\.PORTAL_MCP_ENABLED == 'true'/);
  assert.match(step, /working-directory: shibam-coffee-website\/workers\/portal-mcp/);
  assert.ok(at('name: Apply database migrations') < at('name: Deploy the portal AI connector'), 'after the database is up to date');
  assert.match(text, /CHECK_PORTAL_MCP: \$\{\{ env\.PORTAL_MCP_ENABLED == 'true' && '1' \|\| '0' \}\}/, 'the live check covers it when on');
  assert.match(text, /\n  PORTAL_MCP_ENABLED: "(true|false)"\n/, 'the switch lives in the workflow file');
});

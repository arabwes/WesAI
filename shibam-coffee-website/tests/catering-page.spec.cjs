// Catering conversations in a real browser, on a phone-sized screen: the staff panel in the portal
// and the customer's private page. Real pages, real handlers, real SQLite database.
const { test, expect } = require('@playwright/test');
const path = require('path');

const PROFILES = {
  leadA: { id: 'u_leada', role: 'lead', name: 'Ana Lead', username: 'ana' },
  leadB: { id: 'u_leadb', role: 'lead', name: 'Ben Lead', username: 'ben' },
  barista: { id: 'u_barista', role: 'barista', name: 'Bea Barista', username: 'bea' }
};
const REPLY = 'We can do 40 guests on Dec 10. The quote is $480.';

async function boot(page, who) {
  const { createTestDatabase, addUserWithSession } = await import('./helpers/d1-sqlite.js');
  const { submitCateringRequest } = await import('../functions/_lib/catering.js');
  const teamApi = (await import('../functions/api/team/index.js')).onRequestPost;
  const inquiryApi = (await import('../functions/api/inquiry.js')).onRequestPost;
  const db = createTestDatabase(path.join(__dirname, '..', 'migrations'));
  const sent = [];
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York', NOTIFICATIONS: { send: async (m) => { sent.push(m); } } };
  for (const profile of Object.values(PROFILES)) addUserWithSession(db, profile);
  const requestId = (await submitCateringRequest(new Request('https://x.test'), {
    name: 'Casey Customer', email: 'casey@example.com', phone: '555-0123', eventType: 'Corporate', eventDate: '2026-12-10',
    guestCount: '40', details: 'Coffee and dessert for a team lunch.'
  }, env)).requestId;
  const profile = PROFILES[who];
  await page.addInitScript((p) => localStorage.setItem('shibam_team_profile', JSON.stringify(p)),
    { ...profile, email: '', expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString() });
  await page.route('**/api/team', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const res = await teamApi({ request: new Request('https://portal.test/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `shibam_team_session=token-${profile.id}` }, body: request.postData() }), env });
    return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  await page.route('**/api/inquiry', async (route) => {
    const res = await inquiryApi({ request: new Request('https://shibamatlanta.com/api/inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' }, body: route.request().postData() }), env });
    return route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  return { db, env, requestId, sent };
}

const card = (page) => page.locator('.document-card', { hasText: 'Casey Customer' });
const tokenOf = (db) => db.raw.prepare('SELECT thread_token FROM catering_requests').get().thread_token;

test('a lead replies from the portal, adds an internal note, and can copy the customer link', async ({ page }) => {
  const { db, sent } = await boot(page, 'leadA');
  await page.goto('/team/catering-requests');
  await expect(card(page)).toContainText('new');
  await expect(card(page).locator('.catering-unread')).toBeHidden();

  await card(page).getByRole('button', { name: 'Conversation' }).click();
  await expect(card(page)).toContainText('No messages yet. Your first reply will email Casey Customer a link');

  await card(page).getByLabel('Message to Casey Customer').fill(REPLY);
  await card(page).getByRole('button', { name: 'Send reply' }).click();
  await expect(card(page).locator('.conv-message--staff')).toContainText(REPLY);
  await expect(card(page).locator('.conversation__status')).toContainText('Casey Customer has been emailed a link to read it');
  await expect(card(page).locator('.badge').first()).toHaveText('reviewed'); // a reply moves "new" to "reviewed"
  await expect(card(page).getByRole('button', { name: 'Conversation (1)' })).toBeVisible();
  expect(sent.filter((m) => m.kind === 'catering_message')).toHaveLength(1);

  // The private link is shown so a lead can share it another way, and copies to the clipboard.
  const link = card(page).locator('.conversation__link input');
  await expect(link).toHaveValue(/\/inquiry\/[A-Za-z0-9_-]{43}$/);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await card(page).getByRole('button', { name: 'Copy customer link' }).click();
  await expect(card(page).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.inputValue());

  // An internal note is clearly marked and sends nothing.
  await card(page).getByLabel('Message to Casey Customer').fill('INTERNAL: ask the manager about the discount');
  await card(page).getByLabel(/Internal note/).check();
  await card(page).getByRole('button', { name: 'Send reply' }).click();
  await expect(card(page).locator('.conv-message--note')).toContainText('INTERNAL: ask the manager');
  await expect(card(page).locator('.conv-message--note')).toContainText('internal note');
  await expect(card(page).locator('.conversation__status')).toContainText('Only the team can see it');
  expect(sent.filter((m) => m.kind === 'catering_message')).toHaveLength(1);
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'note'").get().n).toBe(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the customer reads the team\'s message, never sees internal notes, and replies on their private page', async ({ page, browser }) => {
  const { db, env, requestId } = await boot(page, 'leadA');
  const { sendCateringMessage } = await import('../functions/_lib/catering-conversation.js');
  const { addUserWithSession } = await import('./helpers/d1-sqlite.js');
  const lead = new Request('https://portal.test/api/team', { headers: { Cookie: 'shibam_team_session=token-u_leada' } });
  await sendCateringMessage(lead, { requestId, body: 'INTERNAL: they asked for a discount last time', internal: true }, env);
  await sendCateringMessage(lead, { requestId, body: REPLY }, env);
  const token = tokenOf(db);

  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`/inquiry/${token}`);
  await expect(page.locator('h1')).toHaveText('Your catering request');
  await expect(page.locator('#inquiry-app')).toContainText('Hi Casey');
  await expect(page.locator('#inquiry-app')).toContainText('Corporate · Date: 2026-12-10 · Guests: 40');
  await expect(page.locator('.thread-message--team')).toContainText(REPLY);
  await expect(page.locator('.thread-message--team')).toContainText('Ana (Shibam Coffee)');
  const text = await page.locator('body').innerText();
  for (const secret of ['INTERNAL', 'Ana Lead', 'ana@']) expect(text).not.toContain(secret);
  expect(requests.some((u) => /googletagmanager/.test(u))).toBe(false); // no analytics on a private link
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

  // Empty replies are refused with a message; a real reply appears at once.
  await page.getByRole('button', { name: 'Send reply' }).click(); // the browser blocks an empty required field
  await expect(page.locator('.thread-message--you')).toHaveCount(0);
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'customer'").get().n).toBe(0);
  await page.getByLabel('Your reply').fill('December 10th works. Can you also bring chai?');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.locator('.thread-message--you')).toContainText('December 10th works. Can you also bring chai?');
  await expect(page.locator('#inquiry-status')).toContainText('Our team has been told');
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM catering_messages WHERE kind = 'customer'").get().n).toBe(1);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the team sees the customer\'s reply as unread, on the dashboard and on the request, until they open it', async ({ page }) => {
  const { db, env, requestId } = await boot(page, 'leadB');
  const { sendCateringMessage, replyToInquiry } = await import('../functions/_lib/catering-conversation.js');
  const lead = new Request('https://portal.test/api/team', { headers: { Cookie: 'shibam_team_session=token-u_leada' } });
  await sendCateringMessage(lead, { requestId, body: 'Hello Casey' }, env);
  await replyToInquiry(env, tokenOf(db), 'Hi! A question about parking.');
  await replyToInquiry(env, tokenOf(db), 'Also, is there a kids menu?');

  await page.goto('/team/dashboard');
  await expect(page.locator('#catering-request-alert')).toBeVisible();
  await expect(page.locator('#catering-request-alert-title')).toContainText('1 catering reply to read');

  await page.goto('/team/catering-requests');
  await expect(card(page).locator('.catering-unread')).toHaveText('2 new replies');
  await card(page).getByRole('button', { name: 'Conversation (3)' }).click();
  await expect(card(page).locator('.conv-message--customer.is-unread')).toHaveCount(2);
  await expect(card(page).locator('.conv-message--customer')).toContainText(['Hi! A question about parking.', 'Also, is there a kids menu?']);
  await expect(card(page).locator('.catering-unread')).toBeHidden(); // opening it marks the replies read

  // Reading by a different lead than the one who replied is fine, and the alert is gone afterwards.
  await page.goto('/team/dashboard');
  await expect(page.locator('#catering-request-alert')).toBeHidden();
});

test('a link that is not valid shows a plain message and nothing about any request', async ({ page }) => {
  await boot(page, 'leadA');
  await page.goto('/inquiry/' + 'q'.repeat(43));
  await expect(page.locator('h1')).toHaveText('This link is not available');
  await expect(page.locator('body')).not.toContainText('Casey');
  await page.goto('/inquiry');
  await expect(page.locator('h1')).toHaveText('This link is not available');
});

test('baristas cannot open the catering requests page', async ({ page }) => {
  await boot(page, 'barista');
  await page.goto('/team/catering-requests');
  await page.waitForURL(/\/team\/dashboard/);
});

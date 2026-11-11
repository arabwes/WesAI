// Booking Links page (Lead+). The browser talks to the REAL API handlers
// backed by a real SQLite database (D1 stand-in), so this checks the page,
// the router and the database together on a phone-width viewport.
const { test, expect } = require('@playwright/test');

const LEAD = {
  id: 'u_lead', role: 'lead', name: 'Ana Lead', username: 'ana', email: 'ana@example.test',
  expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString()
};

async function boot(page, session) {
  const { createTestDatabase, addUserWithSession } = await import('./helpers/d1-sqlite.js');
  const { onRequestPost } = await import('../functions/api/team/index.js');
  const db = createTestDatabase(require('path').join(__dirname, '..', 'migrations'));
  addUserWithSession(db, { id: session.id, username: session.username, name: session.name, role: session.role });
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York' };
  await page.addInitScript((profile) => localStorage.setItem('shibam_team_profile', JSON.stringify(profile)), session);
  await page.route('**/api/team', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const response = await onRequestPost({
      request: new Request('https://portal.test/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `shibam_team_session=token-${session.id}` },
        body: request.postData()
      }),
      env
    });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  return { db, env };
}

test('a lead sets up an address, hours and a meeting type, then creates a link', async ({ page }) => {
  const { db } = await boot(page, LEAD);
  await page.goto('/team/booking-links');
  await expect(page.locator('h1')).toHaveText('Booking Links');
  await expect(page.locator('#types-list')).toContainText('No meeting types yet');

  // No address yet: creating a type is blocked with guidance.
  await page.click('#new-type-btn');
  await expect(page.locator('#booking-status')).toContainText('Add a meeting address first');

  // Add an address.
  await page.click('#new-location-btn');
  const form = page.locator('#location-form');
  await form.getByLabel('Name', { exact: true }).fill('Alpharetta shop');
  await form.getByLabel('Street address').fill('4000 North Point Pkwy Suite 900');
  await form.getByLabel('City').fill('Alpharetta');
  await form.getByLabel('State').fill('ga');
  await form.getByLabel('ZIP code').fill('30022');
  await form.getByRole('button', { name: 'Add address' }).click();
  await expect(page.locator('#locations-list')).toContainText('4000 North Point Pkwy Suite 900, Alpharetta, GA 30022');

  // Invalid ZIP shows a friendly message and saves nothing.
  await page.click('#new-location-btn');
  await form.getByLabel('Name', { exact: true }).fill('Bad');
  await form.getByLabel('Street address').fill('1 Main');
  await form.getByLabel('City').fill('Atlanta');
  await form.getByLabel('State').fill('GA');
  await form.getByLabel('ZIP code').fill('ABCDE');
  await form.getByRole('button', { name: 'Add address' }).click();
  await expect(page.locator('#booking-status')).toContainText('5-digit ZIP');
  await form.getByRole('button', { name: 'Cancel' }).click();

  // Weekly hours: Monday gets a window, then save.
  await page.getByRole('button', { name: 'Add hours' }).first().click();
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(page.locator('#booking-status')).toContainText('Hours saved');
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM booking_availability').get().n).toBe(1);

  // Create a meeting type that requires the address and asks a question.
  await page.click('#new-type-btn');
  const type = page.locator('#type-form');
  await type.getByLabel('Meeting name').fill('Barista interview');
  await type.getByLabel('Address').selectOption({ index: 1 });
  await type.getByRole('button', { name: 'Add question' }).click();
  await type.getByLabel('Question').fill('Which position are you applying for?');

  // "People can book up to" offers exactly 1 to 30 days, and defaults to 30.
  const window_ = type.getByLabel('People can book up to (1 to 30 days ahead)');
  const choices = await window_.locator('option').allTextContents();
  expect(choices).toHaveLength(30);
  expect(choices[0]).toBe('1 day');
  expect(choices[1]).toBe('2 days');
  expect(choices[29]).toBe('30 days');
  await expect(window_).toHaveValue('30');
  await window_.selectOption('7');

  await type.getByRole('button', { name: 'Create meeting type' }).click();
  await expect(page.locator('#types-list')).toContainText('Barista interview');
  await expect(page.locator('#types-list')).toContainText('30 minutes · Alpharetta shop');
  expect(db.raw.prepare('SELECT max_days_ahead FROM event_types').get().max_days_ahead).toBe(7);

  // Editing shows the saved window and lets it change, including down to 1 day.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await expect(type.getByLabel('People can book up to (1 to 30 days ahead)')).toHaveValue('7');
  await type.getByLabel('People can book up to (1 to 30 days ahead)').selectOption('1');
  await type.getByRole('button', { name: 'Save meeting type' }).click();
  await expect.poll(() => db.raw.prepare('SELECT max_days_ahead FROM event_types').get().max_days_ahead).toBe(1);

  // The links list starts closed, with a button showing how many links there are.
  await expect(page.locator('.booking-links')).toBeHidden();
  await expect(page.getByRole('button', { name: 'View links (0)' })).toBeVisible();
  await page.getByRole('button', { name: 'View links (0)' }).click();
  await expect(page.locator('.booking-links')).toContainText('No links yet');
  await page.getByRole('button', { name: 'Hide links' }).click();
  await expect(page.locator('.booking-links')).toBeHidden();

  // Create a reusable link. The list opens by itself and shows the address.
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByLabel('Label (just for you)').fill('Spring hiring');
  await page.locator('.booking-form').getByRole('button', { name: 'Create link' }).click();
  await expect(page.locator('.booking-links')).toBeVisible();
  await expect(page.locator('.booking-links')).toContainText('Spring hiring');
  await expect(page.locator('.booking-links')).toContainText('0 booked');
  const url = await page.locator('.booking-link-url').inputValue();
  expect(url).toMatch(/\/book\/[A-Za-z0-9_-]{43}$/);
  expect(db.raw.prepare('SELECT max_uses FROM booking_links').get().max_uses).toBeNull();

  // Close it, reload the whole page, and view the very same link again.
  await page.reload();
  await expect(page.locator('.booking-links')).toBeHidden();
  await page.getByRole('button', { name: 'View links (1)' }).click();
  await expect(page.locator('.booking-link-url')).toHaveValue(url);
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

  // Copy puts the full link on the clipboard.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

  // A link made before addresses were kept explains itself instead of showing one.
  db.raw.prepare('UPDATE booking_links SET token = NULL').run();
  await page.reload();
  await page.getByRole('button', { name: 'View links (1)' }).click();
  await expect(page.locator('.booking-links')).toContainText("made before links could be viewed");
  await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
  await expect(page.locator('.booking-link-url')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Revoke' })).toBeVisible(); // it can still be revoked

  // Revoke it: the address disappears and the stored token is erased.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Revoke' }).click();
  await expect(page.locator('.booking-links')).toContainText('revoked');
  await expect(page.locator('.booking-link-url')).toHaveCount(0);
  await expect(page.locator('.booking-links')).toBeVisible(); // the list stays open after revoking
  expect(db.raw.prepare('SELECT token FROM booking_links').get().token).toBeNull();

  // No horizontal scrolling on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a day off can be added and removed', async ({ page }) => {
  await boot(page, LEAD);
  await page.goto('/team/booking-links');
  const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  await page.getByLabel('Date', { exact: true }).fill(future);
  await page.getByRole('button', { name: 'Save date' }).click();
  await expect(page.locator('#hours-editor')).toContainText(future);
  await expect(page.locator('#hours-editor')).toContainText('Not available');
  await page.locator('.booking-link-row', { hasText: future }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#hours-editor')).toContainText('No upcoming exceptions');
});

test('baristas are sent back to the dashboard', async ({ page }) => {
  await boot(page, { ...LEAD, id: 'u_bar', role: 'barista', username: 'bea', name: 'Bea' });
  await page.goto('/team/booking-links');
  await page.waitForURL(/\/team\/dashboard/);
});

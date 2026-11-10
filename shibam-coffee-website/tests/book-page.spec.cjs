// Public booking page (/book/<token>). The browser talks to the REAL public API
// handlers backed by a real SQLite database (D1 stand-in), on a phone viewport.
const { test, expect } = require('@playwright/test');
const path = require('path');

async function boot(page, { turnstileSecret } = {}) {
  const { createTestDatabase, addUserWithSession } = await import('./helpers/d1-sqlite.js');
  const setup = await import('../functions/_lib/calendar-setup.js');
  const { onRequestPost } = await import('../functions/api/book.js');
  const db = createTestDatabase(path.join(__dirname, '..', 'migrations'));
  const sent = [];
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York', NOTIFICATIONS: { send: async (m) => { sent.push(m); } } };
  if (turnstileSecret) env.TURNSTILE_SECRET = turnstileSecret;
  const lead = addUserWithSession(db, { id: 'u_lead', username: 'ana', name: 'Ana Lead', role: 'lead' });
  const location = await setup.saveMeetingLocation(lead, {
    name: 'Alpharetta shop', addressLine1: '4000 North Point Pkwy Suite 900', city: 'Alpharetta', state: 'GA', postalCode: '30022', notes: 'Use the side door'
  }, env);
  const type = await setup.saveEventType(lead, {
    name: 'Barista interview', description: 'A relaxed chat about the role', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60,
    questions: [{ label: 'Which position are you applying for?', required: true }]
  }, env);
  await setup.saveBookingAvailability(lead, {
    timezone: 'America/New_York', weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00' }))
  }, env);
  const link = await setup.createBookingLink(lead, { eventTypeId: type.id, label: 'Hiring' }, env);
  await page.route('**/api/book', async (route) => {
    const request = route.request();
    const response = await onRequestPost({
      request: new Request('https://portal.test/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.postData() }),
      env
    });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  return { db, env, sent, token: link.url.split('/').pop() };
}

test('a candidate books, reschedules and cancels from a phone', async ({ page }) => {
  const { db, token, sent } = await boot(page);
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`/book/${token}`);

  // The page: event details, address, and no analytics on a tokenised URL.
  await expect(page.locator('h1')).toHaveText('Barista interview');
  await expect(page.locator('#booking-app')).toContainText('30 minutes · in person · with Ana');
  await expect(page.locator('#booking-app')).toContainText('4000 North Point Pkwy Suite 900');
  await expect(page.locator('#booking-app')).toContainText('Use the side door');
  expect(requests.some((u) => /googletagmanager/.test(u))).toBe(false);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);

  // Pick a day and a time.
  await page.locator('.booking-chip').first().click();
  await page.locator('.booking-time').first().click();
  await expect(page.locator('.booking-chosen')).toBeVisible();

  // Required question and email validation.
  const form = page.locator('.booking-form');
  await form.getByLabel('Full name').fill('Cam Candidate');
  await form.getByLabel('Email').fill('cam@example.com');
  await form.getByRole('button', { name: 'Confirm booking' }).click();
  // Browser blocks submit until the required question is answered.
  await expect(page.locator('h1')).toHaveText('Barista interview');
  await form.getByLabel('Which position are you applying for?').fill('Barista');
  await form.getByRole('button', { name: 'Confirm booking' }).click();

  await expect(page.locator('h1')).toHaveText('You are booked');
  await expect(page.locator('#booking-app')).toContainText('We sent a confirmation to cam@example.com');
  await expect(page.locator('#booking-app')).toContainText('Use the side door');
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").get().n).toBe(1);
  expect(sent.filter((m) => m.kind === 'booking_email' && m.template === 'confirmed')).toHaveLength(1);
  const original = db.raw.prepare('SELECT start_utc FROM bookings').get().start_utc;
  // The address bar now holds the private manage link, not the shared booking link.
  await expect(page).toHaveURL(/\/book\/manage\//);

  // Reschedule to a different time.
  await page.getByRole('link', { name: 'Change or cancel this booking' }).click();
  await expect(page.getByRole('button', { name: 'Reschedule' })).toBeVisible();
  await page.getByRole('button', { name: 'Reschedule' }).click();
  await page.locator('.booking-chip').nth(1).click(); // the second day always has a full set of times
  await page.locator('.booking-time').first().click();
  await page.getByRole('button', { name: 'Confirm new time' }).click();
  await expect(page.locator('h1')).toHaveText('You are booked');
  const rows = db.raw.prepare('SELECT status, start_utc FROM bookings ORDER BY rowid').all();
  expect(rows.map((r) => r.status)).toEqual(['cancelled', 'confirmed']);
  expect(rows[1].start_utc).not.toBe(original);

  // Cancel.
  await page.getByRole('link', { name: 'Change or cancel this booking' }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.locator('h1')).toHaveText('This booking was cancelled');
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed'").get().n).toBe(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('an unavailable link and a wrong manage link show a generic message, not details', async ({ page }) => {
  await boot(page);
  await page.goto('/book/' + 'a'.repeat(43));
  await expect(page.locator('h1')).toHaveText('This booking link is not available');
  await page.goto('/book/manage/' + 'b'.repeat(43));
  await expect(page.locator('h1')).toHaveText('We could not find this booking');
  await page.goto('/book');
  await expect(page.locator('h1')).toHaveText('This booking link is not available');
});

test('two people cannot take the same time: the second sees a clear message and fresh times', async ({ page }) => {
  const { token, env, db } = await boot(page);
  const questionId = JSON.parse(db.raw.prepare('SELECT questions_json FROM event_types').get().questions_json)[0].id;
  const { createBooking } = await import('../functions/_lib/calendar.js');
  await page.goto(`/book/${token}`);
  await page.locator('.booking-chip').first().click();
  const first = page.locator('.booking-time').first();
  const label = await first.textContent();
  await first.click();
  // Someone else books that exact time while this form is open.
  const slots = (await (await import('../functions/_lib/calendar.js')).getAvailableSlots(env, token)).slots;
  await createBooking(env, token, { name: 'Other', email: 'other@example.com', start: slots[0], answers: { [questionId]: 'x' } });
  const form = page.locator('.booking-form');
  await form.getByLabel('Full name').fill('Cam Candidate');
  await form.getByLabel('Email').fill('cam@example.com');
  await form.getByLabel('Which position are you applying for?').fill('Barista');
  await form.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.locator('#booking-status')).toContainText('That time was just taken');
  await expect(page.locator('.booking-chip').first()).toBeVisible();
  expect(label).toBeTruthy();
});

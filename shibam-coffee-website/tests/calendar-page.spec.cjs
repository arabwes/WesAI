// Team calendar page. Real page + real API handlers + real SQLite database.
// Checks what each role actually SEES on screen, not just what the API returns.
const { test, expect } = require('@playwright/test');
const path = require('path');

const PROFILES = {
  barista: { id: 'u_barista', role: 'barista', name: 'Bea Barista', username: 'bea' },
  leadA: { id: 'u_leada', role: 'lead', name: 'Ana Lead', username: 'ana' },
  leadB: { id: 'u_leadb', role: 'lead', name: 'Ben Lead', username: 'ben' },
  admin: { id: 'u_admin', role: 'management', name: 'Max Admin', username: 'max' }
};
const expiresAt = () => new Date(Date.now() + 12 * 3600 * 1000).toISOString();

async function boot(page, who) {
  const { createTestDatabase, addUserWithSession } = await import('./helpers/d1-sqlite.js');
  const setup = await import('../functions/_lib/calendar-setup.js');
  const cal = await import('../functions/_lib/calendar.js');
  const team = await import('../functions/_lib/calendar-team.js');
  const { onRequestPost } = await import('../functions/api/team/index.js');
  const db = createTestDatabase(path.join(__dirname, '..', 'migrations'));
  const env = { TEAM_DB: db, STORE_TIMEZONE: 'America/New_York' };
  const req = {};
  for (const [key, profile] of Object.entries(PROFILES)) req[key] = addUserWithSession(db, profile);

  // Data: a team event today, and a booking by Ana's candidate tomorrow.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  await team.saveTeamEvent(req.leadA, { title: 'Supplier tasting', date: today, startTime: '14:00', endTime: '15:00', location: 'Back room' }, env);
  const location = await setup.saveMeetingLocation(req.leadA, { name: 'Shop', addressLine1: '1 Main St', city: 'Alpharetta', state: 'GA', postalCode: '30022' }, env);
  const type = await setup.saveEventType(req.leadA, { name: 'Barista interview', durationMinutes: 30, locationId: location.id, minNoticeMinutes: 60 }, env);
  await setup.saveBookingAvailability(req.leadA, { timezone: 'America/New_York', weekly: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '17:00' })) }, env);
  const link = await setup.createBookingLink(req.leadA, { eventTypeId: type.id }, env);
  const token = link.url.split('/').pop();
  const slots = (await cal.getAvailableSlots(env, token)).slots;
  await cal.createBooking(env, token, { name: 'Cam Candidate', email: 'cam@example.com', phone: '555-0100', start: slots[0] });

  const profile = PROFILES[who];
  await page.addInitScript((p) => localStorage.setItem('shibam_team_profile', JSON.stringify(p)), { ...profile, email: '', expiresAt: expiresAt() });
  await page.route('**/api/team', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const response = await onRequestPost({
      request: new Request('https://portal.test/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `shibam_team_session=token-${profile.id}` }, body: request.postData() }),
      env
    });
    return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  return { db, env };
}

async function seeAll(page) {
  await page.goto('/team/calendar');
  await expect(page.locator('#cal-agenda')).not.toContainText('Loading calendar');
  // Show every item for the visible month in the agenda.
}

test('a barista sees team events and "Booked", but never the candidate, and cannot add events', async ({ page }) => {
  await boot(page, 'barista');
  await seeAll(page);
  const agenda = page.locator('#cal-agenda');
  await expect(agenda).toContainText('Supplier tasting');
  await expect(agenda).toContainText('Back room');
  await expect(agenda.locator('.cal-item--booking')).toHaveCount(1);
  await expect(agenda.locator('.cal-item--booking')).toContainText('Booked');
  const text = await page.locator('body').innerText();
  for (const secret of ['Cam Candidate', 'cam@example.com', '555-0100', 'Barista interview']) expect(text).not.toContain(secret);
  await expect(page.locator('#cal-new')).toBeHidden();
  await expect(agenda.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(agenda.getByRole('button', { name: 'Details' })).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toContain('cam@example.com');
});

test('another lead sees the meeting as "Booked" only', async ({ page }) => {
  await boot(page, 'leadB');
  await seeAll(page);
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('Cam Candidate');
  await expect(page.locator('#cal-agenda .cal-item--booking')).toContainText('Booked');
  await expect(page.locator('#cal-new')).toBeVisible();
  await expect(page.locator('#cal-agenda').getByRole('button', { name: 'Edit' })).toHaveCount(0); // not their event
});

test('the host sees candidate details and can cancel; the event is theirs to edit', async ({ page }) => {
  const { db } = await boot(page, 'leadA');
  await seeAll(page);
  const booking = page.locator('#cal-agenda .cal-item--booking');
  await expect(booking).toContainText('Barista interview — Cam Candidate');
  await expect(booking.locator('.cal-item__details')).toBeHidden();
  await booking.getByRole('button', { name: 'Details' }).click();
  await expect(booking.locator('.cal-item__details')).toContainText('cam@example.com');
  await expect(booking.locator('.cal-item__details')).toContainText('555-0100');
  await expect(page.locator('#cal-agenda').getByRole('button', { name: 'Edit' })).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await booking.getByRole('button', { name: 'Cancel meeting' }).click();
  await expect(page.locator('#cal-status')).toContainText('Meeting cancelled');
  await expect(page.locator('#cal-agenda .cal-item--booking')).toHaveCount(0);
  expect(db.raw.prepare("SELECT status FROM bookings").get().status).toBe('cancelled');
});

test('Management sees candidate details for every booking', async ({ page }) => {
  await boot(page, 'admin');
  await seeAll(page);
  await expect(page.locator('#cal-agenda .cal-item--booking')).toContainText('Cam Candidate');
  await expect(page.locator('#cal-agenda').getByRole('button', { name: 'Edit' })).toHaveCount(1);
});

test('"My meetings" filter hides other people\'s bookings and team events', async ({ page }) => {
  await boot(page, 'leadB');
  await seeAll(page);
  await page.selectOption('#cal-filter', 'mine');
  await expect(page.locator('#cal-agenda')).toContainText('Nothing scheduled this month');
  await page.selectOption('#cal-filter', 'events');
  await expect(page.locator('#cal-agenda .cal-item--booking')).toHaveCount(0);
  await expect(page.locator('#cal-agenda')).toContainText('Supplier tasting');
});

test('a lead adds a team event; the form is hidden until asked for', async ({ page }) => {
  const { db } = await boot(page, 'leadA');
  await seeAll(page);
  await expect(page.locator('#event-form')).toBeHidden();
  await page.click('#cal-new');
  await expect(page.locator('#event-form')).toBeVisible();
  const form = page.locator('#event-form');
  await form.getByLabel('Title').fill('Staff meeting');
  await form.getByLabel('Starts').fill('08:00');
  await form.getByLabel('Ends').fill('09:00');
  await form.getByLabel('Location (optional)').fill('Dining room');
  await form.getByRole('button', { name: 'Add event' }).click();
  await expect(page.locator('#cal-status')).toContainText('Event saved');
  await expect(page.locator('#cal-agenda')).toContainText('Staff meeting');
  await expect(page.locator('#event-form')).toBeHidden();
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM team_events WHERE title = 'Staff meeting'").get().n).toBe(1);
  // End before start is refused with a clear message.
  await page.click('#cal-new');
  await form.getByLabel('Title').fill('Bad times');
  await form.getByLabel('Starts').fill('10:00');
  await form.getByLabel('Ends').fill('09:00');
  await form.getByRole('button', { name: 'Add event' }).click();
  await expect(page.locator('#cal-status')).toContainText('end must be after the start');
});

test('month navigation works and the page fits a phone', async ({ page }) => {
  await boot(page, 'barista');
  await seeAll(page);
  const first = await page.locator('#cal-month').textContent();
  await page.click('#cal-next');
  await expect(page.locator('#cal-month')).not.toHaveText(first);
  await expect(page.locator('#cal-agenda')).toContainText('Nothing scheduled this month');
  await page.click('#cal-today');
  await expect(page.locator('#cal-month')).toHaveText(first);
  await page.locator('.cal-day:not(.is-outside)').first().click();
  await expect(page.locator('.cal-day.is-selected')).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('Booking Links forms stay hidden until opened', async ({ page }) => {
  await boot(page, 'leadA');
  await page.goto('/team/booking-links');
  await expect(page.locator('#type-form')).toBeHidden();
  await expect(page.locator('#location-form')).toBeHidden();
  await page.click('#new-location-btn');
  await expect(page.locator('#location-form')).toBeVisible();
});

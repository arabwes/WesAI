const { test, expect } = require('@playwright/test');

test('public pages load their images', async ({ page }) => {
  for (const path of ['/', '/menu', '/catering-events', '/about', '/location', '/contact', '/careers']) {
    await page.goto(path);
    await page.locator('img').first().waitFor();
    // Below-the-fold images are lazy-loaded (loading="lazy"), so they have not
    // started loading yet. Force every image to load, then check none are broken.
    const broken = await page.locator('img').evaluateAll(async (images) => {
      await Promise.all(images.map((image) => {
        image.loading = 'eager';
        return image.complete ? null : new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        });
      }));
      return images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute('src'));
    });
    expect(broken, path).toEqual([]);
  }
});

test('contact form validates input and confirms delivery', async ({ page }) => {
  let submissions = 0;
  await page.route('**/api/contact-request', async (route) => {
    submissions++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('/contact');
  await page.locator('#form-contact-submit').click();
  expect(submissions).toBe(0);
  await page.locator('#contact-name').fill('Test Customer');
  await page.locator('#contact-email').fill('customer@example.com');
  await page.locator('#contact-message').fill('I have a question.');
  await page.locator('#form-contact-submit').click();
  await expect(page.locator('#contact-inquiry-form [data-form-status]')).toHaveAttribute('data-state', 'success');
  expect(submissions).toBe(1);
});

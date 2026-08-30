// Verifies the Phase 7 mobile card-collapse fix: every /team/ page must fit
// a phone-width viewport without horizontal scrolling. Backend calls are
// mocked (page.route) with canned responses so this doesn't depend on a
// live Cloudflare Pages Function or production D1 data.
const { test, expect } = require('@playwright/test');

const SESSION = {
  id: 'employee-test-manager',
  role: 'management',
  name: 'Test Manager',
  username: 'TestManager',
  email: 'manager@example.test',
  expiresAt: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
};

function catalogItems(formType, count) {
  var items = [];
  for (var i = 0; i < count; i++) {
    items.push({
      catalogId: formType + '-' + i,
      formType: formType,
      group: 'Group ' + (i % 3),
      name: 'Item with a fairly long descriptive name ' + i,
      unit: 'lb',
      threshold: 2,
      location: 'Storage',
      target: 10,
      status: i === 0 ? 'flagged' : (i === 1 ? 'discontinued' : 'active'),
      addedBy: 'system',
    });
  }
  return items;
}

async function mockBackend(page) {
  await page.route('**/api/team', async (route) => {
    var body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    var action = body.action;
    var payload = { ok: true };

    if (action === 'login') {
      payload = Object.assign({ ok: true }, SESSION);
    } else if (action === 'getCatalog') {
      payload = { ok: true, items: catalogItems(body.formType || 'inventory', 6) };
    } else if (action === 'getEntries') {
      payload = {
        ok: true,
        entries: [
          { submittedAt: new Date().toISOString(), employeeName: 'Test Barista', date: '2026-08-19', product: 'Some product with a long name', details: '{"category":"Coffee Beans","qtyKitchen":3,"qtyStorage":1,"notes":""}', entryId: 'e1', lastEditedBy: '', lastEditedAt: '' },
        ],
      };
    } else if (action === 'getUsers') {
      payload = {
        ok: true,
        users: [
          { username: 'TestManager', name: 'Test Manager', role: 'management', active: true, createdAt: new Date().toISOString() },
          { username: 'TestBarista', name: 'Test Barista With A Long Name', role: 'barista', active: true, createdAt: new Date().toISOString() },
        ],
      };
    } else if (action === 'getChangelog') {
      payload = {
        ok: true,
        entries: [
          { timestamp: new Date().toISOString(), username: 'TestManager', role: 'management', action: 'discontinueItem', target: 'abc-123', details: '{"count":1}' },
        ],
      };
    } else if (action === 'getDocuments') {
      payload = {
        ok: true,
        documents: [
          { documentId: 'doc-1', title: 'Employee Handbook With A Fairly Long Title', description: 'Company policies and conduct.', category: 'Handbook', driveFileId: '', status: 'active', addedBy: 'TestManager', addedAt: new Date().toISOString() },
        ],
      };
    } else if (action === 'getMyEntries') {
      payload = { ok: true, submissions: [] };
    }

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

async function seedSession(page) {
  await page.addInitScript((session) => {
    localStorage.setItem('shibam_team_profile', JSON.stringify(session));
  }, SESSION);
}

// Checks two things: the page itself doesn't scroll sideways, AND no
// individual table (or its .table-scroll wrapper) needs its own horizontal
// scroll either — a naive check of just document.documentElement would
// pass even with the old desktop table layout, since .table-scroll clips
// overflow into its own scrollable container instead of widening the page.
async function assertNoHorizontalScroll(page, label) {
  var result = await page.evaluate(() => {
    var doc = { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
    var overflowing = [];
    document.querySelectorAll('.table-scroll, .count-table').forEach((node) => {
      if (node.scrollWidth > node.clientWidth + 1) {
        overflowing.push({
          selector: node.className,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        });
      }
    });
    return { doc, overflowing };
  });

  expect(result.doc.scrollWidth, label + ': document.documentElement.scrollWidth (' + result.doc.scrollWidth + ') should not exceed clientWidth (' + result.doc.clientWidth + ')')
    .toBeLessThanOrEqual(result.doc.clientWidth + 1);
  expect(result.overflowing, label + ': no table should need its own horizontal scroll, found: ' + JSON.stringify(result.overflowing))
    .toEqual([]);
}

test.describe('Mobile layout — no horizontal scroll at phone width', () => {
  test('login page (/team/)', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/team/');
    await assertNoHorizontalScroll(page, '/team/');
  });

  const protectedPages = [
    '/team/dashboard',
    '/team/inventory',
    '/team/dessert-inventory',
    '/team/local-order',
    '/team/admin',
    '/team/documents',
    '/team/document?id=doc-1',
  ];

  for (const path of protectedPages) {
    test(path, async ({ page }) => {
      await mockBackend(page);
      await seedSession(page);
      await page.goto(path);
      // Let catalog-driven tables finish rendering before measuring.
      await page.waitForTimeout(300);
      await assertNoHorizontalScroll(page, path);
    });
  }

  test('admin dashboard — all five tabs stay within viewport', async ({ page }) => {
    await mockBackend(page);
    await seedSession(page);
    await page.goto('/team/admin');
    await page.waitForTimeout(300);

    for (const tabId of ['tab-submissions', 'tab-catalog', 'tab-users', 'tab-changelog', 'tab-documents']) {
      await page.click('[data-tab-target="' + tabId + '"]');
      await page.waitForTimeout(150);
      await assertNoHorizontalScroll(page, '/team/admin#' + tabId);
    }
  });

  test('admin Submissions tab — an expanded submission stays within viewport', async ({ page }) => {
    await mockBackend(page);
    await seedSession(page);
    await page.goto('/team/admin');
    await page.waitForTimeout(300);
    await page.click('.submission-row');
    await page.waitForTimeout(150);
    await assertNoHorizontalScroll(page, '/team/admin#tab-submissions (expanded)');
  });
});

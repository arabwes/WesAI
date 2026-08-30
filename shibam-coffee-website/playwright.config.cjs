// Playwright config for the team-portal mobile-layout check.
// Runs against dev-server.cjs (not a plain static server) — see dev-server.cjs
// and team/README.md for why: Cloudflare Pages' .html-stripping and
// _headers behavior have both caused real bugs a plain server hid.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.cjs',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8000',
  },
  projects: [
    {
      // iPhone SE viewport on Chromium specifically — Chromium is the only
      // browser binary available in this environment (WebKit/Firefox
      // aren't installed), and this suite only cares about CSS layout at a
      // narrow width, not engine-specific rendering quirks.
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: 'node dev-server.cjs 8000',
    url: 'http://localhost:8000/team/',
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
  },
});

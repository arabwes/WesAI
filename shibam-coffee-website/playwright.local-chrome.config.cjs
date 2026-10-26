// Same as playwright.config.cjs, but drives the locally installed Google
// Chrome instead of Playwright's downloaded browser — handy on a machine
// where `npx playwright install` hasn't been run:
//   npx playwright test --config playwright.local-chrome.config.cjs
const base = require('./playwright.config.cjs');

module.exports = {
  ...base,
  projects: base.projects.map((project) => ({
    ...project,
    use: { ...project.use, channel: 'chrome' },
  })),
};

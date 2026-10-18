// SPDX-License-Identifier: GPL-3.0-only
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests', testMatch: '*.browser.cjs', workers: 1,
  timeout: 45000, reporter: 'list',
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1100 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' }
});

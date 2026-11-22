const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node e2e/setup-and-start.js',
    url: 'http://127.0.0.1:3000/healthz',
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      PORT: '3000',
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://frontdesk:frontdesk@localhost:5432/frontdesk',
    },
  },
});

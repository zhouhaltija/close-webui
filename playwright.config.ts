import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, trace: 'retain-on-failure' },
  webServer: { command: 'pnpm preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: false },
});

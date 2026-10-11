import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, trace: 'retain-on-failure' },
  projects: [
    { name: 'mock', testIgnore: '**/real-api.spec.ts' },
    { name: 'real-api', testMatch: '**/real-api.spec.ts', use: { baseURL: 'http://localhost:4174' } },
  ],
  webServer: [
    { command: 'pnpm preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: false },
    {
      command: 'pnpm test:real-server', url: 'http://localhost:4174', reuseExistingServer: false,
      env: { VITE_ENABLE_MOCK: 'false', VITE_API_BASE_URL: '/integration-api', VITE_MOCK_SCENARIO: 'failure' },
    },
  ],
});

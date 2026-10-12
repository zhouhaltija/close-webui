import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: true,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalTeardown: './tests/e2e/backend-cleanup.ts',
  use: { baseURL: 'http://localhost:4173', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL, trace: 'retain-on-failure' },
  projects: [
    { name: 'mock', testIgnore: ['**/real-api.spec.ts', '**/backend.spec.ts', '**/responsiveness.spec.ts', '**/provider-settings.spec.ts', '**/fixes.spec.ts', '**/performance.spec.ts'] },
    { name: 'real-api', testMatch: ['**/real-api.spec.ts', '**/responsiveness.spec.ts', '**/provider-settings.spec.ts'], use: { baseURL: 'http://localhost:4174' } },
    { name: 'backend', testMatch: ['**/backend.spec.ts', '**/fixes.spec.ts', '**/performance.spec.ts'], use: { baseURL: 'http://127.0.0.1:4175' } },
  ],
  // The global pnpm launcher occasionally stalls on a network version check, which would
  // fail the 60s webServer timeout; these run the identical commands through node.
  webServer: [
    { command: 'node node_modules/vite/bin/vite.js preview --host localhost --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: false },
    {
      command: 'node node_modules/vite/bin/vite.js build --outDir .test-dist/real && node node_modules/vite/bin/vite.js preview --outDir .test-dist/real --host localhost --port 4174 --strictPort', url: 'http://localhost:4174', reuseExistingServer: false,
      env: { VITE_ENABLE_MOCK: 'false', VITE_API_BASE_URL: '/integration-api', VITE_MOCK_SCENARIO: 'failure' },
    },
    { command: 'node scripts/backend-test-server.mjs', url: 'http://127.0.0.1:4175/health', reuseExistingServer: false, timeout: 120000 },
  ],
});

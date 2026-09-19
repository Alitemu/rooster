import { defineConfig, devices } from '@playwright/test';
// Plain ESM helper, shared with scripts/ui-check.mjs so
// both ways of driving a browser resolve the same one. See its doc comment.
import { chromiumExecutable } from './scripts/chromiumPath.mjs';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: undefined, // Server already running
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: chromiumExecutable() },
      },
    },
  ],
});

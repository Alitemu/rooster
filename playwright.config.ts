import { defineConfig, devices } from '@playwright/test';
// Plain ESM helper, shared with scripts/ui-check.mjs so
// both ways of driving a browser resolve the same one. See its doc comment.
import { chromiumExecutable } from './scripts/chromiumPath.mjs';

const BASIS = process.env.APP_URL || 'http://localhost:3000';

/**
 * Since 2.0.0 the period page shows the new layout, and the accordion only with a hidden flag
 * (lib/indelingOnthouden.ts). Most of these tests still go through the accordion's sections, so every
 * browser starts with that flag. The tests of the new layout (indeling-nieuw, aios-indeling) start without it.
 */
export const MET_OUDE_INDELING = {
  cookies: [],
  origins: [{ origin: new URL(BASIS).origin, localStorage: [{ name: 'dienstrooster.oudeIndeling', value: 'ja' }] }],
};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: BASIS,
    trace: 'on-first-retry',
    storageState: MET_OUDE_INDELING,
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

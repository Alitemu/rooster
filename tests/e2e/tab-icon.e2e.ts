import { test, expect } from '@playwright/test';
import { getBaseUrl } from './setup';

/**
 * The tab icon is found where the page says it is, also in a sub-folder
 * build (APP_URL=http://localhost:3000/achterwacht, CLAUDE.md "Sub-folder").
 * Linked by Next.js's app/icon.tsx convention it came out as /icon without
 * the base path: a 404 on every page and no icon (audit 16).
 */
test('the tab icon the page links to is there', async ({ page }) => {
  await page.goto(`${getBaseUrl()}/planner/login`);
  const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
  expect(href).toBeTruthy();
  const basePath = new URL(getBaseUrl()).pathname.replace(/\/$/, '');
  expect(href!.startsWith(`${basePath}/`)).toBe(true);

  const icon = await page.request.get(new URL(href!, getBaseUrl()).toString());
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toContain('image/png');
});

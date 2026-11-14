import { test, expect } from '@playwright/test';
import { getBaseUrl } from './setup';

/**
 * An address the app does not know (functional audit F-01, 1.7.0): a page of its own in Dutch, with
 * status 404, the app's own header and a way back that keeps the sub-folder. Next's own page said
 * "404, This page could not be found." The source side is in app/algemenePaginas.test.ts.
 */
test('an unknown address answers 404 in Dutch and leads back to the start page', async ({ page }) => {
  const res = await page.goto(`${getBaseUrl()}/bestaat-niet-${Date.now()}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Deze pagina bestaat niet' })).toBeVisible();
  await expect(page.getByText('could not be found')).toHaveCount(0);
  // The app's own header, so it is clearly still Dienstrooster.
  await expect(page.getByRole('link', { name: 'Dienstrooster' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Naar de startpagina' }).click();
  await expect(page.getByRole('heading', { name: 'Welkom bij Dienstrooster' })).toBeVisible();
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe(new URL(getBaseUrl()).pathname.replace(/\/$/, ''));
});

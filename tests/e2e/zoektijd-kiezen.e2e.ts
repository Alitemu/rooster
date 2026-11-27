import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsPlanner, openOnderdeel } from './setup';

/**
 * 2.6.0: the planner chooses how long the achterwacht's solver searches before "Genereren", as for the AIOS: 10
 * minutes (the default), 15 or 30, or a whole number of minutes of their own up to 60 (lib/solverZoektijd.ts). The
 * request carries that choice; a number outside 1 to 60 keeps "Genereren" from going.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GESLOTEN');
  // No roster yet, so the period offers "Rooster genereren met solver".
  db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(testData.period.id);
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('the search time is chosen before generating and sent with it', async ({ page }) => {
  const verzonden: unknown[] = [];
  await page.route('**/generate-roster', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    verzonden.push(route.request().postDataJSON());
    // Not started: this test is about what is asked, not about solving.
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Niet gestart in deze test' }) });
  });

  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await openOnderdeel(page, 'Periode');
  await page.getByRole('button', { name: /Rooster genereren met solver/ }).first().click();
  const dialoog = page.getByRole('dialog', { name: 'Rooster genereren' });
  const keuze = dialoog.getByTestId('zoektijd-keuze');
  await expect(keuze).toBeVisible();

  const lijst = keuze.getByLabel('Hoe lang zoeken');
  await expect(lijst).toHaveValue('600');
  await expect(lijst.locator('option')).toHaveText(['10 minuten', '15 minuten', '30 minuten', 'Zelf kiezen']);
  await expect(dialoog.getByTestId('zoektijd-uitleg')).toContainText('De solver zoekt hoogstens 10 minuten.');

  // A number of minutes of their own: out of range, "Genereren" waits and says why.
  await lijst.selectOption('eigen');
  const minuten = keuze.getByLabel(/Aantal minuten \(1 tot 60\)/);
  await minuten.fill('61');
  await expect(dialoog.getByTestId('zoektijd-uitleg')).toContainText('Vul een heel aantal minuten in, van 1 tot 60.');
  await expect(dialoog.getByRole('button', { name: 'Genereren' })).toBeDisabled();

  await minuten.fill('45');
  await expect(dialoog.getByTestId('zoektijd-uitleg')).toContainText('De solver zoekt hoogstens 45 minuten.');
  await dialoog.getByRole('button', { name: 'Genereren' }).click();
  await expect.poll(() => verzonden.length).toBe(1);
  expect(verzonden[0]).toEqual({ time_limit_seconds: 2700 });
});

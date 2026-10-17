import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsPlanner } from './setup';

/**
 * A period in the prullenbak, opened from a bookmark or a tab left open
 * (the full audit, 0.86.0): the page says where it is, and a step on it is
 * refused with that same message instead of going through.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GESLOTEN');
  db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(new Date().toISOString(), testData.period.id);
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('the page says it is in the prullenbak, and Terug naar open is refused', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await expect(page.getByTestId('in-prullenbak')).toContainText('Deze periode staat in de prullenbak. Je kunt hem bekijken, maar niet wijzigen.');

  await page.getByRole('button', { name: '↩️ Terug naar open' }).click();
  await page.getByRole('button', { name: 'Zeker weten? Nogmaals klikken' }).click();
  await expect(page.getByText('Deze periode staat in de prullenbak. Zet hem eerst terug.')).toBeVisible();
  const status = db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(testData.period.id) as { status: string };
  expect(status.status).toBe('GESLOTEN');
});

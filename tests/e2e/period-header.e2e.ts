import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsPlanner } from './setup';

/**
 * The period header shows the windows the period generates with (audit
 * 14). It showed the single windowWeeks the wizard sets to the avond
 * window at opening: a weekend window of 4 never showed, and an avond
 * window changed in the generation dialog (which saves only the
 * per-teller windows) left the old number in the header.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GESLOTEN');
  db.prepare('UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ? WHERE id = ?').run(
    JSON.stringify({
      windowWeeks: 3,
      windowWeeksAvond: 2,
      windowWeeksWeekendFeestdag: 4,
      bandAvond: [5, 6],
      bandWeekend: [2, 3],
      bandFeestdag: [0, 1],
    }),
    testData.period.id
  );
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('the header shows both windows the period generates with', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await expect(page.getByText('Venster: avond 2 weken · weekend/feestdag 4 weken')).toBeVisible();
  await expect(page.getByText('Venster: 3 weken')).toHaveCount(0);
});

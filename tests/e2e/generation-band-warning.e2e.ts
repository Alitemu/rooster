import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsPlanner } from './setup';

/**
 * The streefbereik is required when a period opens, and the setup wizard
 * fills it in from the members there are at that moment. It is frozen with
 * the period and does not follow later changes to the pool: removing half
 * the people leaves a band whose maximums together are far fewer than the
 * shifts. Audit 9 (the planner's 160 empty shifts: a band of 5-6
 * avonddiensten worked out for 30 people, then 15 left).
 *
 * The generation dialog should say so before "Genereren" is pressed - it
 * only says so afterwards (lib/unfilledExplanation.ts), after a run that
 * can take minutes and always leaves those shifts empty.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GESLOTEN');
  db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(testData.period.id);
  // A band nobody can fill seven shifts with: zero each.
  db.prepare('UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ? WHERE id = ?').run(
    JSON.stringify({ windowWeeks: 0, bandAvond: [0, 0], bandWeekend: [0, 0], bandFeestdag: [0, 0] }),
    testData.period.id
  );
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('the dialog warns about a streefbereik too small for the shifts before generating', async ({ page }) => {
  test.fail();
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.getByRole('button', { name: /Rooster genereren met solver/ }).first().click();
  await expect(page.getByText('Venster en streefbereik')).toBeVisible();
  await expect(page.getByText(/laat samen hoogstens 0 avonddiensten toe/)).toBeVisible({ timeout: 5000 });
});

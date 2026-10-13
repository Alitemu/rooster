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
 * The generation dialog says so before "Genereren" is pressed
 * (lib/bandShortfall.ts via band-check) - it used to say so only afterwards,
 * after a run that can take minutes and always leaves those shifts empty -
 * and "Bereik voor de huidige leden" puts in a band that holds them.
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
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.getByRole('button', { name: /Rooster genereren met solver/ }).first().click();
  await expect(page.getByText('Venster en streefbereik')).toBeVisible();
  const warning = page.getByTestId('bereik-tekort');
  await expect(warning).toContainText(/laat samen hoogstens 0 avonddiensten toe/, { timeout: 5000 });

  // One click puts in the band the app would choose for these members.
  await warning.getByRole('button', { name: 'Bereik voor de huidige leden' }).click();
  await expect(warning).toBeHidden({ timeout: 5000 });
  // Nothing is saved until "Genereren": the frozen band is still zero.
  const frozen = JSON.parse(
    (db.prepare('SELECT bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(testData.period.id) as { bevroren_ruleset_json: string }).bevroren_ruleset_json
  );
  expect(frozen.bandAvond).toEqual([0, 0]);
});

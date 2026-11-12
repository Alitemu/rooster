import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, getBaseUrl } from './setup';

/**
 * Audit per role R-06 (1.7.0): the planner changes the streefbereik of an open period on its page, before
 * or after the invitations; afterwards the page says the invitations named the old number. The rules of
 * the fields are in components/streefbereikAanpassen.test.ts.
 */
let testData: ReturnType<typeof createTestPeriod> | undefined;
test.afterEach(() => {
  if (testData) cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

const regels = (id: string) =>
  JSON.parse((db.prepare('SELECT bevroren_ruleset_json AS r FROM dienstrooster_schedule_period WHERE id = ?').get(id) as { r: string }).r);

test('an open period: Aanpassen next to the streefbereik changes it, and the page says the invitations named the old one', async ({ page }) => {
  testData = createTestPeriod('OPEN');
  db.prepare(`UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ?, uitgenodigd_op = ? WHERE id = ?`).run(
    JSON.stringify({ windowWeeks: 7, bandAvond: [3, 4], bandWeekend: [1, 2], bandFeestdag: [0, 1], distributionMode: 'GELIJK' }),
    new Date().toISOString(),
    testData.period.id
  );
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('periode-regels')).toContainText('3 of 4 avonddiensten');

  await page.getByTestId('streefbereik-aanpassen').click();
  // A minimum above the maximum is refused before anything is saved.
  await page.getByLabel('Avond, minimaal').fill('7');
  await page.getByLabel('Avond, maximaal').fill('6');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByTestId('streefbereik-bewerken').getByRole('alert')).toContainText('Streefbereik avond: vul twee hele getallen van 0 of meer in.');
  expect(regels(testData.period.id).bandAvond).toEqual([3, 4]);

  await page.getByLabel('Avond, minimaal').fill('5');
  await expect(page.getByTestId('streefbereik-wordt')).toContainText('5 of 6 avonddiensten');
  await page.getByRole('button', { name: 'Opslaan' }).click();

  await expect(page.getByTestId('periode-regels')).toContainText('5 of 6 avonddiensten');
  await expect(page.getByTestId('streefbereik-melding')).toContainText('De uitnodigingen zijn al verstuurd en noemden het oude aantal.');
  expect(regels(testData.period.id)).toMatchObject({ bandAvond: [5, 6], bandWeekend: [1, 2], bandFeestdag: [0, 1] });
  expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(testData.period.id) as { status: string }).status).toBe('OPEN');
});

test('a closed period has no Aanpassen there: Rooster genereren has the fields from then on', async ({ page }) => {
  testData = createTestPeriod('GESLOTEN');
  db.prepare(`UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ? WHERE id = ?`).run(
    JSON.stringify({ windowWeeks: 7, bandAvond: [3, 4], bandWeekend: [1, 2], bandFeestdag: [0, 1] }),
    testData.period.id
  );
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('periode-regels')).toContainText('3 of 4 avonddiensten');
  await expect(page.getByTestId('streefbereik-aanpassen')).toHaveCount(0);
});

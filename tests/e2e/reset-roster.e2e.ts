import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsPlanner } from './setup';

/**
 * "Rooster verwijderen" in the period header removes a generated roster and
 * takes the period back to gesloten, ready to generate again
 * (POST /api/periods/[id]/reset-roster). A shift filled in by hand stays
 * unless the planner ticks it along.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GEGENEREERD');
  // One of the seven filled in by hand: it stays.
  db.prepare(`UPDATE dienstrooster_assignment SET bron = 'MANUAL' WHERE id = ?`).run(testData.assignments[0].id);
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('removes the generated roster and keeps what was filled in by hand', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await expect(page.getByText('Status: Gegenereerd').first()).toBeVisible();

  await page.getByRole('button', { name: /Rooster verwijderen/ }).click();
  const panel = page.getByTestId('rooster-verwijderen');
  await expect(panel).toContainText('De periode gaat terug naar gesloten');
  // Annuleren leaves everything as it was.
  await panel.getByRole('button', { name: 'Annuleren' }).click();
  await expect(panel).toBeHidden();
  expect((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(testData.period.id) as { n: number }).n).toBe(7);

  await page.getByRole('button', { name: /Rooster verwijderen/ }).click();
  await page.getByTestId('rooster-verwijderen').getByRole('button', { name: 'Verwijderen' }).click();

  await expect(page.getByTestId('rooster-verwijderd')).toHaveText(
    '6 diensten verwijderd. De periode staat weer op gesloten, klaar om opnieuw te genereren.'
  );
  await expect(page.getByText('Status: Gesloten').first()).toBeVisible();
  const left = db.prepare('SELECT bron FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(testData.period.id) as Array<{ bron: string }>;
  expect(left).toEqual([{ bron: 'MANUAL' }]);
});

import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, getPersonalLinkUrl, loginAsPlanner } from './setup';

/**
 * A period in the prullenbak, opened from a bookmark or a tab left open
 * (the full audit, 0.86.0): the page shows nothing of it and says where to
 * go. The refusal of a step is app/api/periodTrashGuard.test.ts's.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GESLOTEN');
  db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(new Date().toISOString(), testData.period.id);
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('the planner sees only that the period is deleted, with the way back, and no step to take', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await expect(page.getByTestId('periode-verwijderd')).toContainText('Deze periode is verwijderd');
  await expect(page.getByTestId('periode-verwijderd')).toContainText('Zet hem terug via de Prullenbak op het overzicht.');
  await expect(page.getByRole('button', { name: '↩️ Terug naar open' })).toHaveCount(0);
});

test('a participant with a link to it is told to ask a new link on the startpagina', async ({ page }) => {
  const token = testData.users[0].token;
  await page.goto(getPersonalLinkUrl(token));
  const melding = page.getByTestId('periode-verwijderd');
  await expect(melding).toContainText('Deze periode is verwijderd');
  await expect(melding).toContainText('Link kwijt?');
  await melding.getByRole('link', { name: 'startpagina' }).click();
  await expect(page.getByText('Link kwijt?').first()).toBeVisible();
});

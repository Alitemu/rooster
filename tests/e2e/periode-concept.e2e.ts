import { test, expect } from '@playwright/test';
import { createTestPeriod, getPersonalLinkUrl, cleanupTestData } from './setup';

/**
 * A participant who opens a period that is not open yet (functional audit F-04, 1.7.0) reads that it is
 * not open yet. It said "De planner heeft deze periode gesloten", which it never was.
 * lib/invoerDichtMelding.test.ts holds the sentence.
 */
let testData: ReturnType<typeof createTestPeriod> | undefined;
test.afterEach(() => {
  if (testData) cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

test('a period in concept says it is not open yet', async ({ page }) => {
  testData = createTestPeriod('CONCEPT');
  await page.goto(getPersonalLinkUrl(testData.users[0].token));
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('invoer-dicht')).toContainText('Deze periode is nog niet geopend');
  await expect(page.getByText(/De planner heeft deze periode gesloten/)).toHaveCount(0);
});

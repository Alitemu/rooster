import { test, expect, type Locator, type Page } from '@playwright/test';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsBeheerder } from './setup';

/**
 * A modal dialog keeps focus (0.804.0): it takes focus when it opens, Tab and
 * Shift+Tab stay inside it however often you press them, and Escape closes it
 * and gives focus back to the button that opened it. The AIOS's dialogs have
 * the same in tests/e2e/aios-audit.e2e.ts (their own copy of the code).
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GEPUBLICEERD');
});
test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

export async function houdtFocusVast(page: Page, dialoog: Locator, opener: Locator): Promise<void> {
  const binnen = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')));
  await expect.poll(binnen).toBe(true);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    expect(await binnen(), `Tab ${i + 1}`).toBe(true);
  }
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await binnen(), `Shift+Tab ${i + 1}`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialoog).toHaveCount(0);
  await expect(opener).toBeFocused();
}

test('Mailinstellingen: focus in the dialog through Tab and Shift+Tab, and back on the button after Escape', async ({ page }) => {
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.getByRole('heading', { name: 'Exporteren & communicatie' }).getByRole('button').click();
  const opener = page
    .locator('div.card', { has: page.getByRole('heading', { name: 'Exporteren & communicatie' }) })
    .first()
    .getByRole('button', { name: /Mailinstellingen/ });
  await opener.click();
  await houdtFocusVast(page, page.getByRole('dialog', { name: 'Mailinstellingen' }), opener);
});

test('Exporteren: the same for the export dialog', async ({ page }) => {
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.getByRole('heading', { name: 'Exporteren & communicatie' }).getByRole('button').click();
  const opener = page.getByRole('button', { name: /Uitnodigingen en herinneringen/ }).first();
  await opener.click();
  await houdtFocusVast(page, page.getByRole('dialog', { name: 'Exporteren' }), opener);
});

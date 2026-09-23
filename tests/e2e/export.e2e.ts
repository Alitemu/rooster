import { test, expect } from '@playwright/test';
import { createTestPeriod, cleanupTestData, loginAsPlanner, getBaseUrl } from './setup';

/**
 * Every mail to a participant goes through the Power Automate flow
 * (lib/verzendlijst.ts). The dialog used to offer two other ways out, a
 * JSON download to mail to yourself and a mailto link per person; neither
 * may come back. Without SMTP configured on the server (as in this suite)
 * the dialog says sending isn't set up, rather than issuing links nothing
 * can send.
 */

test.describe('Exporteren & communicatie', () => {
  let testData: ReturnType<typeof createTestPeriod>;
  test.beforeAll(() => {
    testData = createTestPeriod('OPEN');
  });
  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  const openDialog = async (page: import('@playwright/test').Page) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    await page.locator('[role="button"]:has-text("Exporteren & communicatie")').first().click();
    await page.getByRole('button', { name: /Uitnodigingen en herinneringen/ }).click();
    return page.getByRole('dialog', { name: 'Exporteren' });
  };

  test('volgorde: uitnodigingen versturen, herinneringen, uitnodigingen downloaden, geschiedenis', async ({ page }) => {
    const dialog = await openDialog(page);
    const kopjes = dialog.locator('p.font-semibold');
    await expect(kopjes.nth(0)).toHaveText(/Uitnodigingen versturen/);
    await expect(kopjes.nth(1)).toHaveText(/Herinneringen versturen/);
    await expect(kopjes.nth(2)).toHaveText(/Uitnodigingen downloaden/);
    await expect(kopjes.nth(3)).toHaveText(/Wijzigingsgeschiedenis downloaden/);
  });

  test('zonder mailinstelling: melding in plaats van versturen, geen andere uitweg', async ({ page }) => {
    const dialog = await openDialog(page);
    await dialog.getByRole('button', { name: /Herinneringen versturen/ }).click();
    await expect(dialog.getByText('Versturen is nog niet ingesteld')).toBeVisible();
    // Generating would issue links nothing can send.
    await expect(dialog.getByRole('button', { name: 'Herinneringen genereren' })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Terug' }).click();
    await dialog.getByRole('button', { name: /Uitnodigingen versturen/ }).click();
    await expect(dialog.getByText('Versturen is nog niet ingesteld')).toBeVisible();

    await expect(dialog.locator('a[href^="mailto:"]')).toHaveCount(0);
    await expect(dialog.getByText(/JSON/)).toHaveCount(0);
  });

  test('automatische herinneringen: zonder mailinstelling staat er dat ze uit staan', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    await page.locator('[role="button"]:has-text("Exporteren & communicatie")').first().click();
    const panel = page.getByTestId('auto-herinneringen');
    await expect(panel).toContainText('Automatische herinneringen');
    await expect(panel).toContainText('versturen is nog niet ingesteld op de server');
    await expect(panel.getByRole('button', { name: 'Pauzeren' })).toHaveCount(0);
  });
});

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
    await page.getByRole('heading', { name: /Exporteren & communicatie/ }).getByRole('button').click();
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

  test('zonder mailinstelling: versturen staat uit en zegt waarom, geen andere uitweg', async ({ page }) => {
    // Off and saying why, as on the AIOS's page (0.87.0); the downloads still work.
    const dialog = await openDialog(page);
    for (const naam of [/Herinneringen versturen/, /Uitnodigingen versturen/]) {
      const keuze = dialog.getByRole('button', { name: naam });
      await expect(keuze).toBeDisabled();
      await expect(keuze).toContainText('Kan pas als de mail is ingesteld. Dat doet de beheerder bij Mailinstellingen.');
    }
    await expect(dialog.getByRole('button', { name: /Uitnodigingen downloaden/ })).toBeEnabled();
    // Generating would issue links nothing can send.
    await expect(dialog.getByRole('button', { name: 'Herinneringen genereren' })).toHaveCount(0);
    await expect(dialog.locator('a[href^="mailto:"]')).toHaveCount(0);
    await expect(dialog.getByText(/JSON/)).toHaveCount(0);
  });

  test('zonder mailinstelling: de herinnerknoppen op de pagina staan uit en zeggen waarom', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('heading', { name: /Exporteren & communicatie/ }).getByRole('button').click();
    await expect(page.getByRole('button', { name: /Deadlineherinnering versturen/ })).toBeDisabled();
    await page.getByRole('heading', { name: /Status voorkeuren/ }).getByRole('button').click();
    await expect(page.getByRole('button', { name: /Herinnering sturen aan iedereen/ })).toBeDisabled();
    await expect(page.getByTestId('mail-nog-niet')).toHaveText(
      'Versturen kan pas als de mail is ingesteld. Dat doet de beheerder bij Mailinstellingen.'
    );
    const perPersoon = await page.getByRole('button', { name: 'Herinnering sturen', exact: true }).all();
    expect(perPersoon.length).toBeGreaterThan(0);
    for (const knop of perPersoon) await expect(knop).toBeDisabled();
  });

  test('automatische herinneringen: zonder mailinstelling staat er dat ze uit staan', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('heading', { name: /Exporteren & communicatie/ }).getByRole('button').click();
    const panel = page.getByTestId('auto-herinneringen');
    await expect(panel).toContainText('Automatische herinneringen');
    await expect(panel).toContainText('versturen is nog niet ingesteld');
    await expect(panel.getByRole('button', { name: 'Pauzeren' })).toHaveCount(0);
  });
});

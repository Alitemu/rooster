import { test, expect } from '@playwright/test';
import { createTestPeriod, getPersonalLinkUrl, cleanupTestData } from './setup';

/**
 * One shift may be offered to several colleagues at once: whoever approves
 * first wins (lib/swapLifecycle.ts). The dialog says so, and marks a
 * colleague already asked for that shift so they can't be picked again.
 */

test.describe('Eén dienst aan meerdere collega’s aanbieden', () => {
  let testData: ReturnType<typeof createTestPeriod>;
  test.beforeAll(() => {
    testData = createTestPeriod('GEPUBLICEERD');
  });
  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test('de al gevraagde collega is niet nog eens te kiezen, een ander wel', async ({ page }) => {
    // users[1] holds an evening shift; so do several colleagues.
    const user = testData.users[1];
    const offeredSlot = testData.assignments.find(
      (a) => a.personId === user.id && testData.slots.find((s) => s.id === a.slotId)?.type === 'AVOND'
    )!.slotId;

    const openDialog = async () => {
      await page.getByRole('button', { name: '+ Ruilverzoek' }).click();
      await page.locator('select[name="offered-slot"]').selectOption(offeredSlot);
      await page.waitForFunction(() => document.querySelectorAll('select[name="requested-slot"] option').length > 2);
    };

    await page.goto(getPersonalLinkUrl(user.token));
    await page.waitForLoadState('networkidle');
    await openDialog();
    await expect(page.getByText(/Je kunt dezelfde dienst aan meerdere collega/)).toBeVisible();

    const requested = page.locator('select[name="requested-slot"]');
    const eerste = await requested.locator('option:not([disabled])').nth(1).getAttribute('value');
    await requested.selectOption(eerste!);
    await page.getByRole('button', { name: 'Verzoek versturen' }).click();
    await expect(page.getByText('Ruilverzoek aangemaakt')).toBeVisible();

    await openDialog();
    const alGevraagd = requested.locator(`option[value="${eerste}"]`);
    await expect(alGevraagd).toBeDisabled();
    await expect(alGevraagd).toContainText('al gevraagd');

    // A second colleague can still be asked for the same shift.
    const tweede = await requested.locator('option:not([disabled])').nth(1).getAttribute('value');
    expect(tweede).not.toBe(eerste);
    await requested.selectOption(tweede!);
    await page.getByRole('button', { name: 'Verzoek versturen' }).click();
    await expect(page.getByText('Ruilverzoek aangemaakt')).toBeVisible();
  });
});

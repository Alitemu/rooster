import { test, expect, type Route } from '@playwright/test';
import { createTestPeriod, getPersonalLinkUrl, cleanupTestData, openSecties } from './setup';

/**
 * The swap dialog starts empty at every opening (2.6.3, components/SwapRequestDialogOpenen.test.ts). It
 * used to show the previous choice again until an effect wiped it: a choice made in that moment was lost
 * (tests/e2e/swap-multi.e2e.ts hung on it once in a full run), and the colleague's field said
 * "Collega's laden…" while nothing loaded.
 */
test.describe('het ruilvenster bij elke opening', () => {
  let testData: ReturnType<typeof createTestPeriod>;
  test.beforeAll(() => {
    testData = createTestPeriod('GEPUBLICEERD');
  });
  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  // users[1] holds an evening shift (swap-multi.e2e.ts offers the same one).
  const aanbod = () => {
    const user = testData.users[1];
    const slotId = testData.assignments.find(
      (a) => a.personId === user.id && testData.slots.find((s) => s.id === a.slotId)?.type === 'AVOND'
    )!.slotId;
    return { user, slotId };
  };

  test('opnieuw geopend toont het nooit de vorige keuze en vraagt het veld voor de collega om een keuze', async ({ page }) => {
    const { user, slotId } = aanbod();
    await page.goto(getPersonalLinkUrl(user.token));
    await openSecties(page);
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '+ Ruilverzoek' }).click();
    await page.locator('select[name="offered-slot"]').selectOption(slotId);
    await page.waitForFunction(() => document.querySelectorAll('select[name="requested-slot"] option').length > 2);
    await page.getByRole('button', { name: 'Annuleren' }).click();
    await expect(page.getByRole('dialog', { name: 'Ruilverzoek indienen' })).toHaveCount(0);

    // Every "Dienst die je aanbiedt" that enters the page, with the choice it shows at that very moment:
    // a look after the opening would come too late to see a wipe that follows it.
    await page.evaluate(() => {
      const gezien: string[] = [];
      (window as unknown as { gezien: string[] }).gezien = gezien;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (!(n instanceof Element)) continue;
            const veld = n.matches('select[name="offered-slot"]') ? n : n.querySelector('select[name="offered-slot"]');
            if (veld) gezien.push((veld as HTMLSelectElement).value);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByRole('button', { name: '+ Ruilverzoek' }).click();
    const veld = page.locator('select[name="offered-slot"]');
    await expect(veld).toBeVisible();
    await expect(veld).toHaveValue('');
    const gezien = await page.evaluate(() => (window as unknown as { gezien: string[] }).gezien);
    expect(gezien.length).toBeGreaterThan(0);
    expect(gezien.filter((waarde) => waarde !== '')).toEqual([]);

    const collega = page.locator('select[name="requested-slot"]');
    await expect(collega).toBeDisabled();
    await expect(collega.locator('option').first()).toHaveText('Kies een dienst');
  });

  test('is de aangeboden dienst weer weg terwijl de collega’s laden, dan vraagt het veld weer om een keuze', async ({ page }) => {
    const { user, slotId } = aanbod();
    await page.goto(getPersonalLinkUrl(user.token));
    await openSecties(page);
    await page.waitForLoadState('networkidle');

    // The colleagues stay underway until the test lets them through.
    const onderweg: Route[] = [];
    await page.route('**/swap-requests/candidates**', (route) => {
      onderweg.push(route);
    });
    await page.getByRole('button', { name: '+ Ruilverzoek' }).click();
    const veld = page.locator('select[name="offered-slot"]');
    const collega = page.locator('select[name="requested-slot"]');
    await veld.selectOption(slotId);
    await expect(collega.locator('option').first()).toHaveText("Collega's laden…");
    await veld.selectOption('');
    await expect(collega.locator('option').first()).toHaveText('Kies een dienst');
    await expect(collega).toBeDisabled();

    // Through after all: a shift chosen again loads its colleagues as always.
    for (const route of onderweg) await route.continue();
    await page.unroute('**/swap-requests/candidates**');
    await veld.selectOption(slotId);
    await page.waitForFunction(() => document.querySelectorAll('select[name="requested-slot"] option').length > 2);
    await expect(collega).toBeEnabled();
  });
});

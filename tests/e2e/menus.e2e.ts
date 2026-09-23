import { test, expect } from '@playwright/test';
import { createTestPeriod, getPersonalLinkUrl, cleanupTestData, loginAsPlanner, getBaseUrl } from './setup';

/**
 * Every pick-from-a-menu control closes once the pick is done.
 *
 * Several of them used to stay open after choosing - the Wisselen dropdown
 * in the roster list only staged a pick and waited for a separate
 * "Bevestigen", the imported-prior-assignments editor did the same. This
 * file goes through each menu that performs an action, including the
 * published-roster variants, where a reason is required first and the
 * menu may only close once that reason is confirmed.
 *
 * Plain form selects (a pool in the create-period form, a weekday in a
 * part-time pattern) are left out: those are fields in a form with its own
 * save button, not menus that act on their own.
 */

test.describe('Keuzemenu’s sluiten na een keuze', () => {
  test.describe('deelnemer: voorkeurenkalender', () => {
    let testData: ReturnType<typeof createTestPeriod>;
    test.beforeAll(() => {
      testData = createTestPeriod('OPEN');
    });
    test.afterAll(() => {
      cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
    });

    test('rechtsklikmenu op een dag sluit na het kiezen van een niveau', async ({ page }) => {
      await page.goto(getPersonalLinkUrl(testData.users[0].token));
      await page.waitForLoadState('networkidle');
      const calendarTab = page.getByRole('button', { name: /Voorkeuren/ }).first();
      if (await calendarTab.count()) await calendarTab.click();

      const cell = page.locator('button[title*="rechtsklik voor opties"]:not([disabled])').first();
      await expect(cell).toBeVisible();
      await cell.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();

      await menu.getByRole('menuitem', { name: /Voorkeur/ }).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
    });
  });

  test.describe('planner: gepubliceerd rooster (reden verplicht)', () => {
    let testData: ReturnType<typeof createTestPeriod>;
    test.beforeAll(() => {
      testData = createTestPeriod('GEPUBLICEERD');
    });
    test.afterAll(() => {
      cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
    });

    const openRoster = async (page: import('@playwright/test').Page) => {
      await loginAsPlanner(page);
      await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
      await page.waitForLoadState('networkidle');
      await page.locator('[role="button"]:has-text("Dienstrooster")').first().click();
      await expect(page.getByRole('button', { name: /Wisselen/ }).first()).toBeVisible();
    };

    test('lijst: Wisselen sluit na kiezen + reden + Bevestigen', async ({ page }) => {
      await openRoster(page);
      await page.getByRole('button', { name: 'Wisselen' }).first().click();
      const select = page.locator('table select');
      await page.waitForFunction(() => document.querySelectorAll('table select option').length > 1);
      await select.selectOption((await select.locator('option').nth(1).getAttribute('value'))!);

      // Published: the pick waits for a reason, so the editor is still there.
      await expect(select).toBeVisible();
      await page.getByPlaceholder('Reden (verplicht)').fill('Afgestemd met beiden');
      await page.locator('table').getByRole('button', { name: 'Bevestigen' }).click();
      await expect(page.locator('table select')).toHaveCount(0, { timeout: 5000 });
    });

    test('kalender: menu sluit na kiezen + reden + Bevestigen', async ({ page }) => {
      await openRoster(page);
      await page.getByRole('button', { name: /Kalender/ }).click();
      const cell = page.locator('[title*="rechtsklik om te wijzigen"]').first();
      await expect(cell).toBeVisible();
      await cell.click({ button: 'right' });
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();

      // First candidate person (not "Niemand toewijzen").
      await page.waitForFunction(() => document.querySelectorAll('[role="menu"] button[role="menuitem"]').length > 1);
      await menu.getByRole('menuitem').filter({ hasNotText: 'Niemand toewijzen' }).first().click();
      await menu.getByPlaceholder(/Reden/).fill('Afgestemd met beiden');
      await menu.getByRole('button', { name: 'Bevestigen' }).click();
      await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 5000 });
    });

    // The menu sits at a fixed pixel position, so really scrolling the page
    // away still closes it - only the small scroll right after opening
    // (momentum, the browser bringing the day into view) doesn't.
    test('kalender: menu sluit wel als de pagina echt wegscrollt', async ({ page }) => {
      await openRoster(page);
      await page.getByRole('button', { name: /Kalender/ }).click();
      const cell = page.locator('[title*="rechtsklik om te wijzigen"]').first();
      await cell.click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      await page.evaluate(() => window.scrollBy(0, 10));
      // "Still open" can't be waited for, only checked after the scroll
      // event and a re-render have had their chance.
      await page.waitForTimeout(300);
      await expect(page.getByRole('menu')).toHaveCount(1);
      await page.evaluate(() => {
        document.body.style.minHeight = '5000px';
        window.scrollBy(0, 600);
      });
      await expect(page.getByRole('menu')).toHaveCount(0);
    });
  });
});

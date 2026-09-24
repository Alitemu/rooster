import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, getBaseUrl } from './setup';

/**
 * Four things on the planner's period page:
 * - "Ongedaan maken" sits under the heading the change was made in and
 *   folds away with it (lib/pendingUndo.ts `onderdeel`);
 * - "Mailinstellingen" under Exporteren & communicatie, Gmail only;
 * - the version number next to the title;
 * - a warning at the top while no mail can go out.
 */

test.describe('Periodepagina', () => {
  let testData: ReturnType<typeof createTestPeriod>;
  let freeSlot: string;

  test.beforeAll(() => {
    testData = createTestPeriod('OPEN');
    // One open evening to fill "in advance", in a week nobody works yet.
    const avond = db.prepare(`SELECT id FROM dienstrooster_shift_type WHERE teller = 'AVOND' LIMIT 1`).get() as { id: string };
    freeSlot = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id)
       VALUES (?, ?, '2027-02-24', 2027, 8, ?)`
    ).run(freeSlot, testData.period.id, avond.id);
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  const section = (page: import('@playwright/test').Page, title: string) =>
    page.locator('div.card', { has: page.locator('[role="button"]', { hasText: title }) }).first();

  test('the undo for a change made in "Rooster vooraf invullen" is under that heading and folds away with it', async ({ page }) => {
    await loginAsPlanner(page);
    const assign = await page.request.post(
      `${getBaseUrl()}/api/planner/period/${testData.period.id}/assignments/manual-assign`,
      { data: { person_id: testData.users[1].id, slot_id: freeSlot, reason: 'test', onderdeel: 'VOORAF' } }
    );
    expect(assign.ok()).toBe(true);

    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');

    const vooraf = section(page, 'Rooster vooraf invullen');
    const header = vooraf.locator('[role="button"]').first();
    const banner = vooraf.getByText('Laatst gewijzigd:');
    if (!(await banner.isVisible())) await header.click();
    await expect(banner).toBeVisible();
    await expect(vooraf.getByRole('button', { name: /Ongedaan maken/ })).toBeVisible();

    // Not loose between the headings, not under the roster.
    await expect(page.getByText('Laatst gewijzigd:')).toHaveCount(1);

    await header.click();
    await expect(page.getByText('Laatst gewijzigd:')).toBeHidden();
  });

  test('Mailinstellingen says Gmail only and refuses another address', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    const exportSection = section(page, 'Exporteren & communicatie');
    const button = exportSection.getByRole('button', { name: /Mailinstellingen/ });
    if (!(await button.isVisible())) await exportSection.locator('[role="button"]').first().click();
    await button.click();

    const dialog = page.getByRole('dialog', { name: 'Mailinstellingen' });
    await expect(dialog.getByText('De app werkt alleen met Gmail.')).toBeVisible();
    await dialog.getByLabel('Gmail-adres').fill('iemand@outlook.com');
    await dialog.getByLabel('App-wachtwoord').fill('abcdefghijklmnop');
    await dialog.getByLabel('Verzendlijst sturen naar').fill('flow@ziekenhuis.test');
    await dialog.getByRole('button', { name: 'Opslaan' }).click();
    await expect(dialog.getByRole('alert')).toContainText('alleen via Gmail');
  });

  test('warns at the top of the page that no mail goes out, and opens Mailinstellingen from there', async ({ page }) => {
    // This test server has no mail settings, in the app or in .env.
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');

    const warning = page.getByRole('alert').filter({ hasText: 'Er wordt geen mail verstuurd' });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Uitnodigingen, herinneringen en ruilmails staan stil');
    await warning.getByRole('button', { name: 'Mailinstellingen openen' }).click();
    await expect(page.getByRole('dialog', { name: 'Mailinstellingen' })).toBeVisible();
  });

  test('the version number is on the title line', async ({ page }) => {
    await page.goto(`${getBaseUrl()}/planner/login`);
    await expect(page.getByTestId('app-versie')).toHaveText(/^versie \d+\.\d+\.\d+$/);
  });
});

import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsBeheerder, loginAsPlanner, getBaseUrl } from './setup';

/**
 * Four things on the planner's period page:
 * - "Ongedaan maken" sits under the heading the change was made in and
 *   folds away with it (lib/pendingUndo.ts `onderdeel`);
 * - "Mailinstellingen" under Exporteren & communicatie, Gmail only, and
 *   only for the beheerder (shared by the achterwacht and the AIOS; a
 *   planner sees how the mail stands, 0.87.0);
 * - the version number next to the title;
 * - a warning at the top while no mail can go out.
 */

test.describe('Periodepagina', () => {
  let testData: ReturnType<typeof createTestPeriod>;
  let freeSlot: string;

  test.beforeAll(() => {
    testData = createTestPeriod('OPEN');
    // One open evening to fill "in advance", in a week nobody works yet.
    const avond = db.prepare(`SELECT id FROM dienstrooster_shift_type WHERE teller = 'AVOND' AND code IS NULL LIMIT 1`).get() as { id: string };
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
    await loginAsBeheerder(page);
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
    await dialog.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('alleen via Gmail');
  });

  test('Mailinstellingen: the Gmail account for both, and per dienst the flow, the contact address and what waits', async ({ page }) => {
    await loginAsBeheerder(page);
    await page.goto(`${getBaseUrl()}/planner`);
    await page.getByRole('button', { name: 'Mailinstellingen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Mailinstellingen' });
    await expect(dialog.getByRole('heading', { name: 'Gmail-account voor de achterwacht en de AIOS samen' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Achterwacht', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Verzendlijst sturen naar', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Contactadres van de planner', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'AIOS', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Verzendlijst van de AIOS sturen naar')).toBeVisible();
    await expect(dialog.getByLabel('Contactadres van de planner van de AIOS')).toBeVisible();
    // Nothing waits on a test server without mail: both say so.
    await expect(dialog.getByText('Er wacht geen mail.')).toHaveCount(2);
    // A contact address that is no address is refused for the AIOS, and saves nothing.
    await dialog.getByLabel('Contactadres van de planner van de AIOS').fill('geen adres');
    await dialog.getByRole('button', { name: 'Opslaan voor de AIOS' }).click();
    await expect(dialog.getByRole('alert')).toContainText('geen geldig e-mailadres');
  });

  test('the beheerder reaches Mailinstellingen from the overview too, a planner does not', async ({ page }) => {
    await loginAsBeheerder(page);
    await page.goto(`${getBaseUrl()}/planner`);
    await page.getByRole('button', { name: 'Mailinstellingen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Mailinstellingen' });
    await expect(dialog.getByText('De app werkt alleen met Gmail.')).toBeVisible();

    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner`);
    await expect(page.getByRole('button', { name: 'Accounts beheren' }).or(page.getByRole('link', { name: 'Accounts beheren' }))).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mailinstellingen' })).toHaveCount(0);
  });

  test('a planner sees how the mail stands, without the button: only the beheerder sets it up', async ({ page }) => {
    // The planner's choice in 0.87.0, as on the AIOS's page.
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    const exportSection = section(page, 'Exporteren & communicatie');
    const status = exportSection.getByTestId('mail-status');
    if (!(await status.isVisible())) await exportSection.locator('[role="button"]').first().click();
    await expect(status).toContainText('Alleen de beheerder stelt de mail in.');
    await expect(exportSection.getByRole('button', { name: /Mailinstellingen/ })).toHaveCount(0);
  });

  test('warns at the top of the page that no mail goes out: the beheerder opens Mailinstellingen from there', async ({ page }) => {
    // This test server has no mail settings.
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    const warning = page.getByRole('alert').filter({ hasText: 'Er wordt geen mail verstuurd' });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Uitnodigingen, herinneringen en ruilmails staan stil');
    // A planner is told to ask.
    await expect(warning).toContainText('Vraag de beheerder om dit op te lossen.');
    await expect(warning.getByRole('button', { name: 'Mailinstellingen openen' })).toHaveCount(0);

    await loginAsBeheerder(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    await warning.getByRole('button', { name: 'Mailinstellingen openen' }).click();
    await expect(page.getByRole('dialog', { name: 'Mailinstellingen' })).toBeVisible();
  });

  test('the version number is on the title line', async ({ page }) => {
    await page.goto(`${getBaseUrl()}/planner/login`);
    await expect(page.getByTestId('app-versie')).toHaveText(/^versie \d+\.\d+\.\d+$/);
  });
});

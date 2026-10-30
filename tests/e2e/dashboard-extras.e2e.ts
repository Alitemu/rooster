import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsBeheerder, loginAsPlanner, getBaseUrl, demoDatum, isoJaarWeek } from './setup';

/**
 * Four things on the planner's period page:
 * - "Ongedaan maken" is for the acute moment (lib/pendingUndo.ts): on the page
 *   where the change is made, gone after a reload, never offered on opening;
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
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(freeSlot, testData.period.id, demoDatum('2027-02-24'), ...isoJaarWeek(demoDatum('2027-02-24')), avond.id);
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  const section = (page: import('@playwright/test').Page, title: string) =>
    page.locator('div.card', { has: page.getByRole('heading', { name: title }) }).first();

  test('"Ongedaan maken" is for the acute moment: on the page where the change is made, gone after a reload and not on the dashboard', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}/fill-gaps`);
    await page.waitForLoadState('networkidle');

    // Nothing to undo yet.
    await expect(page.getByText('Laatst gewijzigd:')).toHaveCount(0);
    // The change is made on the page itself: pick someone for the open evening and apply.
    await page.locator('select').first().selectOption({ index: 1 });
    await page.getByRole('button', { name: /Alle toewijzingen toepassen/ }).click();
    await expect(page.getByText('Laatst gewijzigd:')).toBeVisible();
    await expect(page.getByRole('button', { name: /Ongedaan maken/ })).toBeVisible();

    // A reload: nothing is offered any more, though the server still holds it for two minutes.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Laatst gewijzigd:')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ongedaan maken/ })).toHaveCount(0);

    // And the dashboard opening afterwards does not offer it either, under no heading.
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    const vooraf = section(page, 'Rooster vooraf invullen');
    await vooraf.getByRole('heading').getByRole('button').click();
    await expect(page.getByText('Laatst gewijzigd:')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Ongedaan maken/ })).toHaveCount(0);
  });

  test('"Ongedaan maken" on the fill-gaps page undoes what was just applied', async ({ page }) => {
    // The first test filled the open evening of beforeAll: another one, in another week nobody works yet.
    const avond = db.prepare(`SELECT id FROM dienstrooster_shift_type WHERE teller = 'AVOND' AND code IS NULL LIMIT 1`).get() as { id: string };
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuid(), testData.period.id, demoDatum('2027-03-03'), ...isoJaarWeek(demoDatum('2027-03-03')), avond.id);
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}/fill-gaps`);
    await page.waitForLoadState('networkidle');
    const voor = await page.locator('select').count();
    await page.locator('select').first().selectOption({ index: 1 });
    await page.getByRole('button', { name: /Alle toewijzingen toepassen/ }).click();
    await page.getByRole('button', { name: /Ongedaan maken/ }).click();
    // The open evening is open again.
    await expect(page.getByText('Laatst gewijzigd:')).toHaveCount(0);
    await expect(page.locator('select')).toHaveCount(voor);
  });

  test('Mailinstellingen says Gmail only and refuses another address', async ({ page }) => {
    await loginAsBeheerder(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    const exportSection = section(page, 'Exporteren & communicatie');
    const button = exportSection.getByRole('button', { name: /Mailinstellingen/ });
    if (!(await button.isVisible())) await exportSection.getByRole('heading').getByRole('button').click();
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
    // One Opslaan for all of it (0.901.0): there is no button of the AIOS's own any more, and with the Gmail part
    // untouched it saves without logging in to Gmail. A contact address that is no address is refused for the AIOS.
    await expect(dialog.getByRole('button', { name: 'Opslaan voor de AIOS' })).toHaveCount(0);
    await dialog.getByLabel('Contactadres van de planner van de AIOS').fill('geen adres');
    await dialog.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('de AIOS niet');
    await expect(dialog.getByRole('alert')).toContainText('geen geldig e-mailadres');
    // A real address for the AIOS is saved by the same button and is there when the dialog opens again.
    const adres = `aios-contact-${Date.now()}@example.test`;
    await dialog.getByLabel('Contactadres van de planner van de AIOS').fill(adres);
    await dialog.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(dialog.getByText('Opgeslagen.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Sluiten' }).click();
    await page.getByRole('button', { name: 'Mailinstellingen' }).click();
    await expect(page.getByRole('dialog', { name: 'Mailinstellingen' }).getByLabel('Contactadres van de planner van de AIOS')).toHaveValue(adres);
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
    if (!(await status.isVisible())) await exportSection.getByRole('heading').getByRole('button').click();
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

import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { getBaseUrl, loginAsBeheerder } from './setup';

/**
 * Step 5 (docs/aios-rooster.md, "Bouwvolgorde"): the beheerder adds a
 * planner for the AIOS at Accounts beheren, at 375 pixels. That planner logs
 * in with the temporary password, chooses their own and then sees the AIOS
 * pool only, not the achterwacht's (docs/development/diensten.md).
 */

const stamp = Date.now() % 1_000_000;
const codenaam = `aiosplanner${stamp}`;
const TIJDELIJK = 'Tijdelijk-Wachtwoord-7#';
const EIGEN = 'Eigen-Wachtwoord-Lang-9!';

test.afterAll(() => {
  const persoon = db.prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?').get(codenaam) as { id: string } | undefined;
  if (!persoon) return;
  // Sessions are signed cookies, not rows: the audit log is all it left.
  db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ? OR entiteit_id = ?').run(persoon.id, persoon.id);
  db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(persoon.id);
});

test('the beheerder adds an AIOS planner, who sees the AIOS pool only', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/accounts`);
  await page.getByLabel('Codenaam').fill(codenaam);
  await page.getByLabel('Rol', { exact: true }).selectOption({ label: 'Planner' });
  await page.getByLabel('Dienst').selectOption({ label: 'AIOS' });
  // exact: every row has a "Tijdelijk wachtwoord voor ..." field of its own.
  await page.getByLabel('Tijdelijk wachtwoord', { exact: true }).fill(TIJDELIJK);
  await page.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(page.getByText(`${codenaam} is toegevoegd als planner voor de AIOS.`)).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(codenaam) })).toContainText('AIOS');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const planner = await ctx.newPage();
  await planner.goto(`${getBaseUrl()}/planner/login`);
  await planner.getByLabel('Codenaam').fill(codenaam);
  await planner.getByLabel('Wachtwoord', { exact: true }).fill(TIJDELIJK);
  await planner.getByRole('button', { name: 'Inloggen' }).click();
  await expect(planner.getByRole('heading', { name: 'Kies een nieuw wachtwoord' })).toBeVisible();
  await planner.getByLabel('Nieuw wachtwoord', { exact: true }).fill(EIGEN);
  await planner.getByLabel('Nieuw wachtwoord herhalen').fill(EIGEN);
  await planner.getByRole('button', { name: 'Wachtwoord opslaan en verder' }).click();

  await planner.waitForURL(/\/planner\/?$/);
  await planner.getByRole('button', { name: '+ Nieuwe periode' }).click();
  const pools = planner.locator('select').first().locator('option');
  await expect(pools).toHaveText([/^AIOS \(\d+ leden\)$/]);
  await expect(planner.getByText(/loopt altijd van woensdag tot en met dinsdag/)).toBeVisible();
  await ctx.close();
});

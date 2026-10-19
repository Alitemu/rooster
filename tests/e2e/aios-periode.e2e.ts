import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { getBaseUrl, loginAsBeheerder, openAiosSectie, loginAsPlanner } from './setup';

/**
 * The AIOS roster, step 1 (docs/aios-rooster.md): the beheerder picks the
 * AIOS pool and a quarter, the period comes with its diensten, and its page
 * shows them per week with the blocks and the points, readable at 375
 * pixels. Opening needs an AIOS taking part. The achterwacht's planner
 * never sees the AIOS pool. The preferences: aios-voorkeuren.e2e.ts.
 */

const made: string[] = [];

test.afterAll(() => {
  // What the period brought with it, then the period.
  db.pragma('foreign_keys = OFF');
  try {
    for (const id of made) {
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_shift_block WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

test('the beheerder makes an AIOS quarter and sees its diensten, blocks and points', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner`);
  await page.getByRole('button', { name: '+ Nieuwe periode' }).click();

  const pool = page.locator('select').first();
  const aios = await pool.locator('option', { hasText: 'AIOS' }).getAttribute('value');
  await pool.selectOption(aios!);
  // The last quarter on offer: the furthest from anything made by hand.
  const kwartaal = page.locator('#aios-kwartaal');
  const opties = await kwartaal.locator('option').allInnerTexts();
  await kwartaal.selectOption({ label: opties[opties.length - 1] });
  await expect(page.getByText(/loopt altijd van woensdag tot en met dinsdag/)).toBeVisible();
  await page.getByRole('button', { name: 'Aanmaken en instellen' }).click();

  await page.waitForURL(/\/planner\/period\//);
  made.push(page.url().split('/planner/period/')[1]);
  await expect(page.getByRole('heading', { name: `AIOS ${opties[opties.length - 1]}` })).toBeVisible();

  // Every part folds, as on the achterwacht's page (0.86.0): all closed at first.
  const knop = (titel: string) => page.getByRole('heading', { name: titel, exact: true }).getByRole('button');
  for (const titel of ['Voorkeuren van de AIOS', 'Voortgangstoets', 'Geschiedenis van vóór de app', 'Punten in dit kwartaal', 'Dienstrooster (nog niet gegenereerd)']) {
    await expect(knop(titel)).toHaveAttribute('aria-expanded', 'false');
  }
  // The history from before the app is the first section, the roster the last (the planner's wish, as on the achterwacht's page).
  const volgorde = await page.getByRole('heading').filter({ has: page.getByRole('button') }).allTextContents();
  expect(volgorde[0]).toContain('Geschiedenis van vóór de app');
  expect(volgorde[volgorde.length - 1]).toContain('Dienstrooster (nog niet gegenereerd)');
  await expect(page.getByText(/hebben de AIOS samen minstens/)).toBeHidden();
  await openAiosSectie(page, 'Punten in dit kwartaal');
  await expect(page.getByText(/hebben de AIOS samen minstens/)).toBeVisible();
  // Opening another closes it, unless it is pinned.
  await openAiosSectie(page, 'Dienstrooster (nog niet gegenereerd)');
  // The table of the diensten is the legend of that section.
  await expect(page.getByTestId('aios-dienstrooster-legenda').getByRole('heading', { name: 'Diensten (toelichting)' })).toBeVisible();
  await expect(knop('Punten in dit kwartaal')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /^Vastzetten/ }).click();
  await openAiosSectie(page, 'Voorkeuren van de AIOS');
  await expect(knop('Dienstrooster (nog niet gegenereerd)')).toHaveAttribute('aria-expanded', 'true');

  // Opening asks for an AIOS taking part; the demo's AIOS pool is empty.
  await expect(page.getByLabel('Deadline voor de voorkeuren')).toBeVisible();
  await page.getByRole('button', { name: 'Periode openen' }).click();
  await expect(page.getByText(/Er doet nog geen AIOS mee in dit kwartaal/)).toBeVisible();
  // Thirteen or fourteen weeks, each with its evening and night blocks.
  await openAiosSectie(page, 'Dienstrooster (nog niet gegenereerd)');
  const weken = await page.getByText(/^Week \d+ en \d+ · /).count();
  expect([13, 14]).toContain(weken);
  await expect(page.locator('[title^="Blok zo t/m di"]').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // Listed with "Bekijken", not the achterwacht's setup wizard.
  await page.goto(`${getBaseUrl()}/planner`);
  await expect(page.getByRole('link', { name: 'Bekijken →' }).first()).toBeVisible();
});

test("the achterwacht's planner does not see the AIOS pool", async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner`);
  await expect(page.getByRole('heading', { name: 'Personeel' })).toBeVisible();
  await expect(page.getByText('AIOS', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '+ Nieuwe periode' }).click();
  await expect(page.locator('select').first().locator('option', { hasText: 'AIOS' })).toHaveCount(0);
});

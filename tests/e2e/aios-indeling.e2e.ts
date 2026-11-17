import { test, expect, type Page } from '@playwright/test';
import { db } from '@/db/client';
import { getBaseUrl, loginAsBeheerder } from './setup';

// The new layout as everyone has it since 2.0.0: without the hidden flag every other test starts with (playwright.config.ts).
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The new layout of the AIOS's period page (1.13.0, the planner's wish), as the achterwacht's has it: the
 * list of sections all the way left, "Periode" on top, the period's name and status in the blue bar, one
 * section at a time with its own address; below 1100 px the list behind a button in the blue bar. The
 * new layout is the layout since 2.0.0, without a switch. The rules are in lib/aiosIndeling.test.ts.
 */
const made: string[] = [];
let adres = '';

test.afterAll(() => {
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

const lijst = (page: Page) => page.getByRole('navigation', { name: 'Onderdelen van de periode' });
const sectie = (page: Page) => page.locator('[data-onderdeel]');

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner`);
  await page.getByRole('button', { name: '+ Nieuwe periode' }).click();
  const pool = page.locator('select').first();
  await pool.selectOption((await pool.locator('option', { hasText: 'AIOS' }).getAttribute('value'))!);
  const kwartaal = page.locator('#aios-kwartaal');
  const opties = await kwartaal.locator('option').allInnerTexts();
  // The quarter before the last: aios-periode.e2e.ts makes the last one.
  await kwartaal.selectOption({ label: opties[opties.length - 2] });
  await page.getByRole('button', { name: 'Aanmaken en instellen' }).click();
  await page.waitForURL(/\/planner\/period\//);
  adres = page.url().split('?')[0];
  made.push(adres.split('/planner/period/')[1]);
  await page.close();
});

test('the new layout, without a switch: the list left, Periode on top, the name in the blue bar', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 650 });
  await loginAsBeheerder(page);
  await page.goto(adres);
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nieuwe indeling proberen' })).toHaveCount(0);

  // The blue bar: the name, which is the page's one heading, and the status.
  const naam = await page.getByTestId('kop-periode').getByRole('heading', { level: 1 }).innerText();
  expect(naam).toMatch(/^AIOS /);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId('kop-periode')).toContainText('Concept');

  // The list all the way left from the blue bar down, "Periode" first. A concept opens where it is opened.
  const balk = (await page.locator('header').boundingBox())!;
  const vak = (await lijst(page).boundingBox())!;
  expect(vak.x).toBe(0);
  expect(Math.abs(vak.y - (balk.y + balk.height))).toBeLessThanOrEqual(1);
  await expect(lijst(page).getByRole('link').first()).toHaveText(/^Periode/);
  await expect(sectie(page)).toHaveAttribute('data-onderdeel', 'voorkeuren');
  await expect(sectie(page).getByRole('button', { name: 'Periode openen' })).toBeVisible();
  expect((await sectie(page).boundingBox())!.y).toBeLessThan(200);
  // "Periode": the header that stood above the sections.
  await lijst(page).getByRole('link', { name: /^Periode/ }).click();
  await expect(lijst(page).getByRole('link', { name: /^Periode/ })).toHaveAttribute('aria-current', 'page');
  await expect(sectie(page)).toHaveAttribute('data-onderdeel', 'periode');
  await expect(sectie(page)).toContainText('Deadline voorkeuren');
  await expect(sectie(page)).toContainText('Status: Concept');
  for (const groep of ['Voorbereiden', 'Deelnemers', 'Rooster']) await expect(lijst(page).getByText(groep, { exact: true })).toBeVisible();

  // Each item shows its own section, and only that one, at its own address, with the focus on its title.
  for (const [titel, deel] of [
    ['Punten in dit kwartaal', 'punten'],
    ['Geschiedenis van vóór de app', 'geschiedenis'],
    ['Voortgangstoets', 'voortgangstoets'],
  ]) {
    await lijst(page).getByRole('link', { name: new RegExp(`^${titel}`) }).click();
    await expect(sectie(page).getByRole('heading', { level: 2 })).toHaveText(titel);
    await expect(sectie(page)).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`onderdeel=${deel}`));
    await expect(sectie(page).getByRole('heading', { level: 2 })).toBeFocused();
  }
  await page.goBack();
  await expect(sectie(page).getByRole('heading', { level: 2 })).toHaveText('Geschiedenis van vóór de app');

  // No way back in the list; the accordion only for ?indeling=oud, as it was, for that page.
  await expect(lijst(page).getByRole('button', { name: 'Terug naar de oude indeling' })).toHaveCount(0);
  await page.goto(`${adres}?indeling=oud`);
  await expect(page.getByRole('heading', { name: 'Geschiedenis van vóór de app' }).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('kop-periode')).toHaveCount(0);
  await page.goto(adres);
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
});

test('on a phone the button of the list is in the blue bar, which sticks, and the list comes from the left', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAsBeheerder(page);
  await page.goto(`${adres}?indeling=nieuw`);
  await expect(sectie(page)).toHaveAttribute('data-onderdeel', 'voorkeuren');
  await expect(lijst(page)).toHaveCount(0);
  const knop = page.locator('header').getByRole('button', { name: 'Onderdelen van de periode' });
  expect((await knop.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect((await page.locator('header').boundingBox())!.y).toBe(0);

  await knop.click();
  await expect(knop).toHaveAttribute('aria-expanded', 'true');
  await expect(lijst(page).getByRole('link', { name: /^Voorkeuren van de AIOS/ })).toBeFocused();
  expect((await lijst(page).boundingBox())!.x).toBe(0);
  await lijst(page).getByRole('link', { name: /^Punten in dit kwartaal/ }).click();
  await expect(lijst(page)).toHaveCount(0);
  await expect(sectie(page)).toHaveAttribute('data-onderdeel', 'punten');

  await knop.click();
  await page.keyboard.press('Escape');
  await expect(lijst(page)).toHaveCount(0);
  await expect(knop).toBeFocused();
  await knop.click();
  await page.mouse.click(365, 500);
  await expect(lijst(page)).toHaveCount(0);
});

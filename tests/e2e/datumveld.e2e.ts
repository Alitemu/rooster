import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * Every date field reads dd-mm-jjjj, also in an English browser (1.2.0).
 *
 * The browser's own date input followed the browser's language: an English
 * Chrome asked for mm/dd/yyyy on a Dutch page. The fields are text now
 * (components/DatumVeld.tsx); what is stored stays YYYY-MM-DD.
 */

test.use({ locale: 'en-US' });

const tag = uuid().slice(0, 6);
let poolId = '';
let rulesetId = '';
let periodId = '';
let personId = '';

test.beforeAll(() => {
  rulesetId = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'E2E-Datum', '{}', datetime('now'))`).run(rulesetId);
  poolId = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(poolId, `E2E-Datum-${tag}`, rulesetId);
  periodId = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op)
     VALUES (?, ?, 'Datumperiode', 'OPEN', '2099-03-02', '2099-08-30', '2098-12-31T23:00', datetime('now'))`
  ).run(periodId, poolId);
  personId = uuid();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(personId, `Datum-${tag}`);
});

test.afterAll(() => {
  db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
  db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
  db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(rulesetId);
});

test('a date is typed and shown as dd-mm-jjjj and stored as YYYY-MM-DD', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/pool/${poolId}/staff`);
  const vanaf = page.locator('#nieuw-lid-vanaf');
  const tot = page.locator('#nieuw-lid-tot');
  // The default, the start of the period, already in the Dutch order.
  await expect(vanaf).toHaveValue('02-03-2099');
  await expect(vanaf).toHaveAttribute('placeholder', 'dd-mm-jjjj');

  // Something that is no date is marked once the field is left, and not stored.
  await vanaf.fill('31-02-2099');
  await tot.click();
  await expect(vanaf).toHaveAttribute('aria-invalid', 'true');

  // A short form is written out in full on leaving: the 6th of April, never the 4th of June.
  await vanaf.fill('6-4-2099');
  await tot.click();
  await expect(vanaf).toHaveValue('06-04-2099');
  await expect(vanaf).not.toHaveAttribute('aria-invalid', 'true');
  await tot.fill('31-12-2099');

  await page.locator('#nieuw-lid-codenaam').fill(`Datum-${tag}`);
  await page.getByRole('button', { name: 'Toevoegen', exact: true }).click();
  await expect
    .poll(() => db.prepare('SELECT geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership WHERE person_id = ? AND pool_id = ?').get(personId, poolId))
    .toEqual({ geldig_vanaf: '2099-04-06', geldig_tot: '2099-12-31' });
});

test('a deadline is a date and a 24-hour time, stored as before', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${periodId}`);
  await page.getByRole('button', { name: 'Aanpassen' }).click();
  const datum = page.getByLabel('Deadline', { exact: true });
  const tijd = page.getByLabel('Deadline, tijd');
  await expect(datum).toHaveValue('31-12-2098');
  await expect(tijd).toHaveValue('23:00');
  await datum.fill('15-01-2099');
  await tijd.fill('17.30');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect
    .poll(() => (db.prepare('SELECT deadline FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { deadline: string }).deadline)
    .toBe('2099-01-15T17:30');
});

test('a date in a list stays on one line on a phone', async ({ page }) => {
  // "03-01-2028" fell apart over three lines at 375px: the hyphens are break points (audit 1.2.1).
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner`);
  const datums = page.locator('[data-datumtekst]');
  await expect(datums.first()).toBeVisible();
  const regels = await datums.evaluateAll((els) => els.map((el) => el.getClientRects().length));
  expect(regels.length).toBeGreaterThan(0);
  expect(regels.every((n) => n === 1)).toBe(true);
  await expect(datums.first()).toHaveText(/^\d{2}-\d{2}-\d{4}$/);
});

import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { localIsoDate } from '@/lib/localDate';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * "Nieuw personeelslid toevoegen" on Personeel beheren starts at the start
 * of the pool's period being rostered, or today without one, and always
 * with an open end, 31 December 2099 (lib/membershipDefaults.ts, 0.901.0).
 *
 * Two pools of its own, so periods other test files make in the seeded
 * pool don't decide the outcome.
 */

const pools: string[] = [];
const periods: string[] = [];
const rulesets: string[] = [];

function pool(naam: string): string {
  const ruleset = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, '{}', datetime('now'))`).run(ruleset, naam);
  rulesets.push(ruleset);
  const id = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(id, `${naam}-${id.slice(0, 6)}`, ruleset);
  pools.push(id);
  return id;
}

function period(poolId: string, naam: string, status: string, start: string, eind: string): void {
  const id = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, '2098-12-31T23:00', datetime('now'))`
  ).run(id, poolId, naam, status, start, eind);
  periods.push(id);
}

test.afterAll(() => {
  for (const id of periods) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  for (const id of pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
});

async function newMemberDates(page: import('@playwright/test').Page, poolId: string) {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/pool/${poolId}/staff`);
  await expect(page.getByText('Nieuw personeelslid toevoegen')).toBeVisible();
  const dates = page.locator('input[type="date"]');
  return { vanaf: dates.nth(0), tot: dates.nth(1), uitleg: page.getByTestId('geldig-uitleg') };
}

test('a new member starts at the period being rostered, with an open end', async ({ page }) => {
  const id = pool('E2E-Standaard');
  period(id, 'Vorige periode', 'GEPUBLICEERD', '2099-01-05', '2099-03-01');
  period(id, 'Winter 2099', 'OPEN', '2099-03-02', '2099-08-30');
  const { vanaf, tot, uitleg } = await newMemberDates(page, id);
  await expect(vanaf).toHaveValue('2099-03-02');
  await expect(tot).toHaveValue('2099-12-31');
  await expect(uitleg).toContainText('staat op het begin van de periode Winter 2099');
});

test('without a period being rostered: today, with an open end', async ({ page }) => {
  const id = pool('E2E-Geen-periode');
  const { vanaf, tot, uitleg } = await newMemberDates(page, id);
  // The Dutch date, like the page: in UTC it is still yesterday until 01:00
  // or 02:00 (audit 10 caught this test failing at 00:47).
  await expect(vanaf).toHaveValue(localIsoDate());
  await expect(tot).toHaveValue('2099-12-31');
  await expect(uitleg).toHaveText('Geldig vanaf staat op vandaag. Geldig tot staat op 31 december 2099: deze persoon doet mee tot je een einddatum zet.');
});

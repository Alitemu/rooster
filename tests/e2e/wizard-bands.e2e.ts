import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * The wizard's "Venster" step checks the streefbereik with the server's
 * own rules before moving on (audit 15). A minimum above its maximum went
 * through every step and came back from "Periode openen" as
 * "bandAvond: min en max moeten hele getallen zijn (min <= max, min >= 0)",
 * a field name and code signs on a planner's screen.
 */

let periodId = '';

test.afterAll(() => {
  if (periodId) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
});

test('a minimum above the maximum is told at the window step, in words', async ({ page }) => {
  await loginAsPlanner(page);
  const pool = db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'ACHTERWACHT' ORDER BY rowid LIMIT 1`).get() as { id: string };
  const created = await page.request.post(`${getBaseUrl()}/api/planner/periods`, {
    data: { naam: `Wizard-bereik ${Date.now()}`, pool_id: pool.id, start_datum: '2032-01-05', eind_datum: '2032-03-28', deadline: '2031-12-15T12:00' },
  });
  periodId = (await created.json()).data.id;

  await page.goto(`${getBaseUrl()}/planner/setup/${periodId}`);
  await page.getByRole('button', { name: '3. Venster' }).click();
  await page.getByLabel('Streefbereik avond minimum').fill('6');
  await page.getByLabel('Streefbereik avond maximum').fill('5');
  await page.getByRole('button', { name: 'Volgende' }).click();

  await expect(page.getByText(/Streefbereik avond: vul twee hele getallen van 0 of meer in/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Venster en budgetten' })).toBeVisible();
  await expect(page.getByText(/bandAvond|min <= max/)).toHaveCount(0);

  // Put right, the step lets the planner on.
  await page.getByLabel('Streefbereik avond maximum').fill('7');
  await page.getByRole('button', { name: 'Volgende' }).click();
  await expect(page.getByRole('heading', { name: 'Verdelingsmodus' })).toBeVisible();
});

import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * Rooster instellen starts a new period from the previous period's settings
 * (lib/vorigeInstellingen.ts, audit 1.3.0: 2027-2 opened on Gelijk while
 * 2027-1 ran Naar rato). The steps say where the settings come from, the
 * budget fields carry their own label, and the summary warns when the
 * planner changed one.
 */

const ids: string[] = [];

test.afterAll(() => {
  for (const id of ids) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
});

test('a new period takes over the verdeling, window and budget of the one before', async ({ page }) => {
  await loginAsPlanner(page);
  const pool = db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'ACHTERWACHT' ORDER BY rowid LIMIT 1`).get() as { id: string };
  const budget = (f: number) => ({ AVOND: { maxFraction: f }, WEEKEND: { maxFraction: f }, FEESTDAG: { maxFraction: f }, parttimeExempt: true });
  const vorigeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, ?, '2036-01-07', '2036-06-29', '2035-12-01T12:00', 'GESLOTEN', ?, ?)`
  ).run(
    vorigeId,
    pool.id,
    'Vorige 2036-1',
    JSON.stringify({ distributionMode: 'NAAR_RATO', windowWeeksAvond: 3, windowWeeksWeekendFeestdag: 3, blockBudget: budget(0.15), softBlockBudget: budget(1) }),
    new Date().toISOString()
  );
  ids.push(vorigeId);
  const created = await page.request.post(`${getBaseUrl()}/api/planner/periods`, {
    data: { naam: `Nieuw 2036-2 ${Date.now()}`, pool_id: pool.id, start_datum: '2036-07-07', eind_datum: '2036-12-28', deadline: '2036-05-15T12:00' },
  });
  const periodId = (await created.json()).data.id;
  ids.push(periodId);

  await page.goto(`${getBaseUrl()}/planner/setup/${periodId}`);
  await page.getByRole('button', { name: '3. Venster' }).click();
  await expect(page.getByTestId('vorige-instellingen')).toContainText('overgenomen van Vorige 2036-1');
  await expect(page.getByLabel('Geblokkeerd (max % van de diensten)')).toHaveValue('15');
  await expect(page.getByLabel('Liever niet (max % van de diensten)')).toHaveValue('100');
  await expect(page.getByLabel('Venster avonddiensten (weken)')).toHaveValue('3');

  await page.getByRole('button', { name: '4. Verdeling' }).click();
  await expect(page.getByTestId('vorige-verdeling')).toHaveText('De verdeling is overgenomen van Vorige 2036-1: Naar rato.');
  await expect(page.getByLabel('Naar rato (streefbereik geschaald naar deeltijdfactor)')).toBeChecked();

  // As before, the summary says nothing; changed, it names what the previous period had.
  await page.getByRole('button', { name: '7. Bevestigen' }).click();
  await expect(page.getByText('geblokkeerd hoogstens 15% · liever niet zonder limiet')).toBeVisible();
  await expect(page.getByTestId('anders-dan-vorige')).toHaveCount(0);
  await page.getByRole('button', { name: '4. Verdeling' }).click();
  await page.getByLabel('Gelijk (zelfde streefbereik voor iedereen)').check();
  await page.getByRole('button', { name: '7. Bevestigen' }).click();
  await expect(page.getByTestId('anders-dan-vorige')).toHaveText(
    '⚠️ Anders dan in Vorige 2036-1. Daar was het: verdeling Naar rato. Klopt dat zo voor deze periode?'
  );
});

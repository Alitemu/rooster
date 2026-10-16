import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { getBaseUrl, loginAsBeheerder } from './setup';

/**
 * Step 4a (docs/aios-rooster.md): the planner makes an AIOS roster with the
 * real AIOS-solver (aios-solver/ on AIOS_SOLVER_URL), at 375 pixels: the
 * outcome, the roster per week with the AIOS in it, every AIOS's
 * dienstpercentage, and "Rooster verwijderen" back to gesloten. Two weeks
 * from a Wednesday, so the solver is quick; the request it gets is the
 * app's own, so a contract the two disagree on fails here (422).
 *
 * Step 4b: two weeks over kerst and oudjaar. No roster before the planner
 * says what happens with the blocks around kerst; a cut block and the
 * second night of New Year's Eve go to the real solver, which fills them.
 * These eight AIOS are fulltime, so a whole nachtblok zo t/m di stays
 * empty (hard rule 5); cut up, its nights are single diensten they may do.
 */

const START = '2094-07-07'; // a Wednesday
const EIND = '2094-07-20'; // the Tuesday two weeks on
const stamp = Date.now();
// Kerst on Saturday and Sunday: the zo t/m di blocks ask; oudjaar on a Friday.
const KERST_START = '2094-12-22';
const KERST_EIND = '2095-01-04';
const ids = {} as { period: string; kerst: string; mensen: string[] };
let snapshot: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

test.beforeAll(() => {
  snapshot = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const pool = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'AIOS' ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
  ids.period = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, naam, pool_id, start_datum, eind_datum, deadline, status, auto_herinneren, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'GESLOTEN', 0, datetime('now'))`
  ).run(ids.period, `AIOS rooster e2e ${stamp}`, pool, START, EIND, '2094-05-01T17:00');
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(pool)!, START, EIND))();
  ids.kerst = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, naam, pool_id, start_datum, eind_datum, deadline, status, auto_herinneren, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'GESLOTEN', 0, datetime('now'))`
  ).run(ids.kerst, `AIOS kerst e2e ${stamp}`, pool, KERST_START, KERST_EIND, '2094-11-01T17:00');
  db.transaction(() => persistAiosSlots(ids.kerst, aiosShiftTypes(pool)!, KERST_START, KERST_EIND))();
  ids.mensen = [];
  for (let i = 0; i < 8; i++) {
    const id = uuid();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(
      id,
      `ar${String(i).padStart(2, '0')}-${stamp % 100000}`
    );
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, 1, '2094-01-01', '2095-12-31')`
    ).run(uuid(), id, pool);
    ids.mensen.push(id);
  }
});

test.afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(snapshot.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

test('the planner makes the AIOS roster, sees it per block and per AIOS, and removes it again', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);

  const paneel = page.getByTestId('aios-rooster-maken');
  await expect(paneel.getByRole('heading', { name: 'Rooster' })).toBeVisible();
  await paneel.getByRole('button', { name: 'Rooster maken' }).click();
  await expect(paneel.getByText(/^Klaar: \d+ diensten ingedeeld/)).toBeVisible({ timeout: 200_000 });

  await expect(page.getByRole('heading', { name: 'Per AIOS' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Het rooster per week' })).toBeVisible();
  // Every AIOS a row with a percentage; the roster names them.
  const tabel = page.locator('table', { hasText: 'Percentage' });
  await expect(tabel.locator('tbody tr')).toHaveCount(8);
  await expect(tabel.getByText(/\d+(,\d)?%/).first()).toBeVisible();
  await expect(page.locator('td span', { hasText: new RegExp(`^ar0\\d-${stamp % 100000}`) }).first()).toBeVisible();
  const ingedeeld = (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(ids.period) as { n: number }).n;
  expect(ingedeeld).toBeGreaterThan(0);
  expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(ids.period) as { status: string }).status).toBe('GEGENEREERD');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await paneel.getByRole('button', { name: 'Rooster verwijderen' }).click();
  await paneel.getByRole('button', { name: 'Ja, rooster verwijderen' }).click();
  await expect(paneel.getByRole('button', { name: 'Rooster maken' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Per AIOS' })).toHaveCount(0);
  expect((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(ids.period) as { n: number }).n).toBe(0);
});

test('around kerst the planner chooses first, and oudjaar gets two AIOS', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.kerst}`);

  const paneel = page.getByTestId('aios-rooster-maken');
  const vragen = paneel.getByTestId('aios-feestdagblokken');
  await expect(vragen.getByRole('heading', { name: '★ Blokken rond feestdagen' })).toBeVisible();
  await expect(vragen.getByText(/Eerste Kerstdag en Tweede Kerstdag/)).toBeVisible();
  await expect(paneel.getByText('Kies eerst bij elk blok rond de feestdagen wat ermee gebeurt en bewaar je keuzes.')).toBeVisible();
  await expect(paneel.getByRole('button', { name: 'Rooster maken' })).toBeDisabled();
  await expect(vragen.getByText('(nog kiezen)')).toHaveCount(2);

  await vragen.getByRole('group', { name: /^Nachtblok zo t\/m di/ }).getByLabel(/^Opknippen/).check();
  await vragen.getByRole('group', { name: /^Avondblok zo t\/m di/ }).getByLabel(/^Heel laten/).check();
  await expect(vragen.getByRole('group', { name: /^Oudjaarsnacht/ }).getByLabel('Twee AIOS')).toBeChecked();
  await expect(paneel.getByText('Bewaar eerst je keuzes over de blokken rond de feestdagen.')).toBeVisible();
  await vragen.getByRole('button', { name: 'Keuzes bewaren' }).click();
  await expect(vragen.getByText('Bewaard.')).toBeVisible();
  await expect(vragen.getByText('(nog kiezen)')).toHaveCount(0);

  await paneel.getByRole('button', { name: 'Rooster maken' }).click();
  await expect(paneel.getByText(/^Klaar: \d+ diensten ingedeeld/)).toBeVisible({ timeout: 200_000 });
  await expect(page.getByRole('cell', { name: 'Nacht 2', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // The kerst nights cut up: each a single dienst, all three filled by fulltimers.
  const kerstNachten = db
    .prepare(
      `SELECT a.person_id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_assignment a ON a.slot_id = sl.id
       WHERE sl.period_id = ? AND sl.datum BETWEEN '2094-12-26' AND '2094-12-28' AND st.code = 'ND'`
    )
    .all(ids.kerst) as Array<{ person_id: string | null }>;
  expect(kerstNachten).toHaveLength(3);
  expect(kerstNachten.every((n) => n.person_id)).toBe(true);

  // Two AIOS on the night of 31 December, one of them in the block.
  const oudjaar = db
    .prepare(
      `SELECT sl.shift_block_id AS blok, a.person_id FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_assignment a ON a.slot_id = sl.id
       WHERE sl.period_id = ? AND sl.datum = '2094-12-31' AND st.code = 'ND' ORDER BY sl.shift_block_id IS NULL`
    )
    .all(ids.kerst) as Array<{ blok: string | null; person_id: string | null }>;
  expect(oudjaar).toHaveLength(2);
  expect(oudjaar[0].blok).not.toBeNull();
  expect(oudjaar[1].blok).toBeNull();
  expect(oudjaar.every((n) => n.person_id)).toBe(true);
  expect(oudjaar[0].person_id).not.toBe(oudjaar[1].person_id);
});

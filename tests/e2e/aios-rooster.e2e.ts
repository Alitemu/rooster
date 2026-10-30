import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { getBaseUrl, loginAsBeheerder, openAiosSectie, openDienstrooster } from './setup';

/**
 * Step 4a (docs/aios-rooster.md): the planner makes an AIOS roster with the
 * real AIOS-solver (aios-solver/ on AIOS_SOLVER_URL), at 375 pixels: the
 * outcome, the roster per week with the AIOS in it, every AIOS's
 * dienstpercentage, and "Rooster verwijderen" back to gesloten. Two weeks
 * from a Wednesday, so the solver is quick; the request it gets is the
 * app's own, so a contract the two disagree on fails here (422).
 *
 * Step 4c: then a block to another AIOS by hand, with its warnings
 * confirmed, and "Ongedaan maken" back to the roster as it was.
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

test('the planner makes the AIOS roster, sees it per block and per AIOS, changes it by hand and removes it again', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);

  const paneel = page.getByTestId('aios-rooster-maken');
  // Making, publishing and withdrawing sit at the top as a card, not in sections of their own.
  await expect(page.getByRole('heading', { name: 'Rooster', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Publiceren', exact: true })).toHaveCount(0);
  // Ten minutes unless chosen otherwise (0.902.0); a test quarter of 8 AIOS takes one, typed in.
  await expect(paneel.getByLabel('Hoe lang zoeken')).toHaveValue('600');
  await expect(paneel.getByTestId('aios-tijd-uitleg')).toContainText('Hoe langer de solver zoekt, hoe eerlijker de verdeling.');
  await paneel.getByLabel('Hoe lang zoeken').selectOption('eigen');
  await paneel.getByLabel(/Aantal minuten/).fill('61');
  await expect(paneel.getByRole('button', { name: 'Rooster maken' })).toBeDisabled();
  await expect(paneel.getByTestId('aios-tijd-uitleg')).toContainText('Vul een heel aantal minuten in, van 1 tot 60.');
  await paneel.getByLabel(/Aantal minuten/).fill('1');
  await paneel.getByRole('button', { name: 'Rooster maken' }).click();
  await expect(paneel.getByTestId('aios-lege-diensten').getByText(/^Gemaakt op .*: \d+ diensten ingedeeld/)).toBeVisible({ timeout: 200_000 });
  // Whether the solver finished is said, either way.
  await expect(paneel.getByTestId('aios-solver-klaar')).toHaveText(/^(De solver is klaar: dit is de eerlijkste verdeling binnen de regels\.|De tijd was op voordat de solver klaar was.*)$/);

  await expect(page.getByRole('heading', { name: 'Dienstpercentage en saldo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dienstrooster (automatisch ingevuld)', exact: true })).toBeVisible();
  // Every AIOS a row with a percentage; the roster names them.
  await openAiosSectie(page, 'Dienstpercentage en saldo');
  const tabel = page.locator('table', { hasText: 'Percentage' });
  await expect(tabel.locator('tbody tr')).toHaveCount(8);
  await expect(tabel.getByText(/\d+(,\d)?%/).first()).toBeVisible();
  await openDienstrooster(page);
  await expect(page.locator('td span', { hasText: new RegExp(`^ar0\\d-${stamp % 100000}`) }).first()).toBeVisible();
  const ingedeeld = (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(ids.period) as { n: number }).n;
  expect(ingedeeld).toBeGreaterThan(0);
  expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(ids.period) as { status: string }).status).toBe('GEGENEREERD');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // By hand: a night block to the AIOS the list offers first, then back.
  const rooster = () =>
    Object.fromEntries(
      (db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(ids.period) as Array<{
        slot_id: string;
        person_id: string;
      }>).map((r) => [r.slot_id, r.person_id])
    );
  const voor = rooster();
  await page.getByRole('button', { name: /^Nachtblok .*Wijzigen$/ }).first().click();
  const wijzig = page.getByTestId('aios-wijzigen');
  await expect(wijzig.getByRole('heading', { name: 'Wie doet dit?' })).toBeVisible();
  await expect(wijzig.getByLabel('Het hele blok')).toBeChecked();
  const kies = wijzig.getByRole('button', { name: /^Kies / }).first();
  const codenaam = (await kies.getAttribute('aria-label'))!.replace(/^Kies /, '');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await kies.click();
  const klaar = page.getByTestId('aios-laatste-wijziging');
  const toch = wijzig.getByRole('button', { name: 'Ja, toch indelen' });
  await expect(klaar.or(toch)).toBeVisible();
  if (await toch.isVisible()) await toch.click();
  await expect(klaar).toContainText(`nu ${codenaam}.`);
  // Changed by hand: the heading says so.
  await expect(page.getByRole('heading', { name: 'Dienstrooster (handmatig aangepast)', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`^Nachtblok .*: ${codenaam}`) }).first()).toBeVisible();
  const na = rooster();
  expect(Object.keys(na).filter((k) => na[k] !== voor[k]).length).toBeGreaterThanOrEqual(3);
  await klaar.getByRole('button', { name: 'Ongedaan maken' }).click();
  await expect(klaar).toHaveCount(0);
  expect(rooster()).toEqual(voor);

  // The other views of the same section: the list of every dienst, the dienstdoende with their numbers, the swaps (empty before publishing).
  const sectie = page.getByTestId('aios-dienstrooster');
  await sectie.getByRole('tab', { name: /Lijst/ }).click();
  const lijst = sectie.getByTestId('aios-dienstrooster-lijst');
  const aantalDiensten = (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?').get(ids.period) as { n: number }).n;
  await expect(lijst.locator('tbody tr')).toHaveCount(aantalDiensten);
  await lijst.getByRole('button', { name: /Wijzig in de lijst$/ }).first().click();
  await expect(sectie.getByTestId('aios-wijzigen').getByRole('heading', { name: 'Wie doet dit?' })).toBeVisible();
  await sectie.getByTestId('aios-wijzigen').getByRole('button', { name: 'Sluiten' }).click();
  await sectie.getByRole('tab', { name: /Dienstdoende/ }).click();
  const dienstdoende = sectie.getByTestId('aios-dienstdoende');
  await expect(dienstdoende.locator('tbody tr')).toHaveCount(8);
  await expect(dienstdoende.getByRole('row', { name: /^Samen/ })).toBeVisible();
  // Fairness is in points per fte, not in the number of diensten: both are there (0.902.0).
  await expect(dienstdoende.getByRole('columnheader', { name: 'Punten' })).toBeVisible();
  await expect(dienstdoende.getByRole('columnheader', { name: 'Percentage' })).toBeVisible();
  await expect(dienstdoende.getByTestId('dienstdoende-punten')).toHaveCount(8);
  await sectie.getByRole('tab', { name: /Ruilverzoeken/ }).click();
  await expect(sectie.getByTestId('aios-ruilen-overzicht')).toContainText('Er zijn nog geen ruilverzoeken gedaan.');
  await expect(sectie.getByTestId('aios-ruilen-overzicht')).toContainText('Ruilen kan pas als het rooster definitief is.');
  await sectie.getByRole('tab', { name: /Kalender/ }).click();

  await paneel.getByRole('button', { name: 'Rooster verwijderen' }).click();
  await paneel.getByRole('button', { name: 'Ja, rooster verwijderen' }).click();
  await expect(paneel.getByRole('button', { name: 'Rooster maken' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dienstpercentage en saldo' })).toHaveCount(0);
  // Not made: the heading says so, and the calendar shows the diensten themselves.
  await expect(page.getByRole('heading', { name: 'Dienstrooster (nog niet gegenereerd)', exact: true })).toBeVisible();
  await openDienstrooster(page);
  await expect(page.getByTestId('aios-dienstrooster-nog-niet')).toBeVisible();
  expect((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(ids.period) as { n: number }).n).toBe(0);
});

test('around kerst the planner chooses first, and oudjaar gets two AIOS', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.kerst}`);

  const paneel = page.getByTestId('aios-rooster-maken');
  await openAiosSectie(page, 'Blokken rond de feestdagen');
  const vragen = page.getByTestId('aios-feestdagblokken');
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

  await paneel.getByLabel('Hoe lang zoeken').selectOption('eigen');
  await paneel.getByLabel(/Aantal minuten/).fill('1');
  await paneel.getByRole('button', { name: 'Rooster maken' }).click();
  await expect(paneel.getByTestId('aios-lege-diensten').getByText(/^Gemaakt op .*: \d+ diensten ingedeeld/)).toBeVisible({ timeout: 200_000 });
  await openDienstrooster(page);
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

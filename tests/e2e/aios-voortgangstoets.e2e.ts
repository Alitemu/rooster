import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { getBaseUrl, loginAsBeheerder, openAiosSectie } from './setup';

/**
 * The voortgangstoets (docs/aios-rooster.md, "Voortgangstoets"): on a roster
 * already made the planner gives its date on the period's page, at 375
 * pixels. The night before says Fellow in the week table and in the roster,
 * and the block's other two nights stay with their AIOS. Clearing it brings
 * the night back, empty.
 */

const START = '2094-10-13'; // a Wednesday
const EIND = '2094-10-26';
const TOETS = '2094-10-20'; // the Wednesday of week two: the Tuesday night before is the fellow's
const stamp = Date.now();
const ids = {} as { period: string; mensen: string[] };
let snapshot: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

const nacht = (datum: string) =>
  db
    .prepare(
      `SELECT a.person_id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_assignment a ON a.slot_id = sl.id WHERE sl.period_id = ? AND sl.datum = ? AND st.code = 'ND'`
    )
    .get(ids.period, datum) as { person_id: string | null } | undefined;

test.beforeAll(() => {
  snapshot = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const pool = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'AIOS' ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
  ids.period = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, naam, pool_id, start_datum, eind_datum, deadline, status, auto_herinneren, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'GEGENEREERD', 0, datetime('now'))`
  ).run(ids.period, `AIOS voortgangstoets e2e ${stamp}`, pool, START, EIND, '2094-09-01T17:00');
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(pool)!, START, EIND))();
  ids.mensen = [];
  for (let i = 0; i < 4; i++) {
    const id = uuid();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(
      id,
      `av${i}-${stamp % 100000}`
    );
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, 1, '2094-01-01', '2094-12-31')`
    ).run(uuid(), id, pool);
    ids.mensen.push(id);
  }
  // Every dienst filled: a block whole to one AIOS, a single dienst to the next.
  const slots = db
    .prepare(
      `SELECT sl.id, COALESCE(sl.shift_block_id, sl.id) AS eenheid FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ? ORDER BY sl.datum, st.start_tijd`
    )
    .all(ids.period) as Array<{ id: string; eenheid: string }>;
  const wie = new Map<string, string>();
  for (const s of slots) {
    if (!wie.has(s.eenheid)) wie.set(s.eenheid, ids.mensen[wie.size % ids.mensen.length]);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(uuid(), ids.period, wie.get(s.eenheid), s.id);
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

test('the planner gives the date, and the night before says Fellow', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  const houder = nacht('2094-10-17')!.person_id;
  expect(nacht('2094-10-19')!.person_id).toBe(houder);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);

  const kaart = page.getByTestId('aios-voortgangstoets');
  await expect(kaart.getByRole('heading', { name: 'Voortgangstoets' })).toBeVisible();
  await openAiosSectie(page, 'Voortgangstoets');
  await kaart.getByLabel('Er is een voortgangstoets in dit kwartaal').check();
  await kaart.getByLabel('Datum van de voortgangstoets').fill(TOETS);
  await kaart.getByRole('button', { name: 'Opslaan' }).click();
  await expect(kaart.getByText(/^Opgeslagen\. Het rooster was al gemaakt\./)).toBeVisible();
  await expect(kaart).toContainText('De voortgangstoets is op woensdag 20 oktober 2094');
  await expect(kaart).toContainText('In de nacht ervoor (dinsdag 19 oktober 2094) heeft geen AIOS dienst.');

  // In the week table and in the roster: the one pinned open, so both show.
  await openAiosSectie(page, 'Per week');
  await page.getByRole('button', { name: /^Vastzetten/ }).click();
  await openAiosSectie(page, 'Handmatige correctie gegenereerde rooster');
  const fellow = page.getByTitle('Nacht voor de voortgangstoets: een fellow');
  await expect(fellow).toHaveCount(2);
  expect(nacht('2094-10-19')).toBeUndefined();
  expect([nacht('2094-10-17')!.person_id, nacht('2094-10-18')!.person_id]).toEqual([houder, houder]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await openAiosSectie(page, 'Voortgangstoets');
  await kaart.getByLabel('Er is een voortgangstoets in dit kwartaal').uncheck();
  await kaart.getByRole('button', { name: 'Opslaan' }).click();
  // The night back with the AIOS of the rest of its block (the full audit, 0.86.0).
  await expect(
    kaart.getByText('Opgeslagen. De nacht van dinsdag 19 oktober 2094 staat weer in het rooster, bij de AIOS die de rest van dat blok heeft.')
  ).toBeVisible();
  await openAiosSectie(page, 'Handmatige correctie gegenereerde rooster');
  await expect(fellow).toHaveCount(0);
  expect(nacht('2094-10-19')).toEqual({ person_id: houder });
});

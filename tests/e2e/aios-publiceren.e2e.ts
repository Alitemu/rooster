import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
import { getBaseUrl, loginAsBeheerder } from './setup';

/**
 * Step 4d (docs/aios-rooster.md): the planner publishes an AIOS roster
 * voorlopig, the AIOS sees their own diensten on their page with the
 * voorlopig notice and their dienstpercentage, the planner makes it
 * definitief, and the roster comes as a workbook. Two weeks, every dienst
 * filled beforehand (a block whole to one AIOS, round the four), at 375
 * pixels. The AIOS's mail is not set up here: publishing says so and goes
 * on.
 */

const START = '2094-08-04'; // a Wednesday
const EIND = '2094-08-17';
const stamp = Date.now();
const ids = {} as { period: string; mensen: string[]; link: string };
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
     VALUES (?, ?, ?, ?, ?, ?, 'GEGENEREERD', 0, datetime('now'))`
  ).run(ids.period, `AIOS publiceren e2e ${stamp}`, pool, START, EIND, '2094-06-01T17:00');
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(pool)!, START, EIND))();
  ids.mensen = [];
  for (let i = 0; i < 4; i++) {
    const id = uuid();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(
      id,
      `ap${i}-${stamp % 100000}`
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
  ids.link = aiosPersoonlijkeLink(ids.mensen[0], ids.period, getBaseUrl());
});

test.afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(snapshot.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

test('the planner publishes, the AIOS sees their diensten, then definitief and as Excel', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);

  const paneel = page.getByTestId('aios-publiceren');
  await expect(paneel.getByRole('heading', { name: 'Publiceren' })).toBeVisible();
  await paneel.getByRole('button', { name: 'Voorlopig publiceren' }).click();
  await paneel.getByRole('button', { name: /^Ja, (toch )?publiceren$/ }).click();
  await expect(paneel.getByText(/^Voorlopig gepubliceerd\. Er is geen e-mail verstuurd/)).toBeVisible();
  await expect(paneel.getByText(/^Voorlopig gepubliceerd op .*\. Nog niet definitief\.$/)).toBeVisible();
  expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(ids.period) as { status: string }).status).toBe('GEPUBLICEERD');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // The workbook, as the planner downloads it.
  const excel = await page.request.get(`${getBaseUrl()}/api/aios/periode/${ids.period}/download-rooster`);
  expect(excel.status()).toBe(200);
  expect(excel.headers()['content-type']).toContain('spreadsheetml');

  // The AIOS, on their own link, in a browser of their own.
  const aiosContext = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const aios = await aiosContext.newPage();
  await aios.goto(ids.link);
  const mijn = aios.getByTestId('aios-mijn-rooster');
  await expect(mijn.getByRole('heading', { name: 'Jouw rooster' })).toBeVisible();
  await expect(mijn.getByTestId('aios-voorlopig')).toContainText('Dit is het voorlopige rooster.');
  await expect(mijn.getByText(/Je dienstpercentage dit kwartaal: \d+(,\d)?%/)).toBeVisible();
  const eigen = (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ? AND person_id = ?').get(ids.period, ids.mensen[0]) as { n: number }).n;
  await expect(mijn.locator('li')).toHaveCount(eigen);
  expect(await aios.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await paneel.getByRole('button', { name: 'Definitief maken' }).click();
  await paneel.getByRole('button', { name: 'Ja, definitief maken' }).click();
  await expect(paneel.getByText(/^Het rooster is definitief\./)).toBeVisible();
  await aios.reload();
  await expect(mijn.getByText('Dit rooster is definitief.')).toBeVisible();
  await expect(mijn.getByTestId('aios-voorlopig')).toHaveCount(0);
  await aiosContext.close();
});

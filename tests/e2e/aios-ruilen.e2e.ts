import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
import { getBaseUrl } from './setup';

/**
 * Step 4f (docs/aios-rooster.md, "Ruilen"): on a definitief AIOS roster one
 * AIOS asks another, on their own link, to swap a Saturday dagdienst for
 * the colleague's of a week later; the requester can remind the colleague
 * (after a yes in the box); the colleague approves on theirs, and both
 * rosters show it. Their requests in two categories, each with its filter on
 * status and the number behind every option. On a voorlopig roster the page
 * says why nothing can be swapped yet. At 375 pixels, each in a browser of
 * their own.
 */

const START = '2094-09-01'; // a Wednesday
const EIND = '2094-09-14';
const stamp = Date.now();
const ids = {} as { period: string; a: string; b: string; linkA: string; linkB: string; ddA: string; ddB: string };
let snapshot: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

const dd = (datum: string) =>
  (
    db
      .prepare(
        `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.period_id = ? AND st.code = 'DD' AND sl.datum = ?`
      )
      .get(ids.period, datum) as { id: string }
  ).id;
const wieHeeft = (slot: string) => (db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE slot_id = ?').get(slot) as { person_id: string }).person_id;

test.beforeAll(() => {
  snapshot = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const pool = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'AIOS' ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
  ids.period = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, naam, pool_id, start_datum, eind_datum, deadline, status, definitief_op, auto_herinneren, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'GEPUBLICEERD', datetime('now'), 0, datetime('now'))`
  ).run(ids.period, `AIOS ruilen e2e ${stamp}`, pool, START, EIND, '2094-07-01T17:00');
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(pool)!, START, EIND))();
  const persoon = (n: string) => {
    const id = uuid();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(
      id,
      `ar${n}-${stamp % 100000}`
    );
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, 1, '2094-01-01', '2094-12-31')`
    ).run(uuid(), id, pool);
    return id;
  };
  ids.a = persoon('a');
  ids.b = persoon('b');
  // a the dagdienst of Saturday 4 September, b that of Saturday 11 September.
  ids.ddA = dd('2094-09-04');
  ids.ddB = dd('2094-09-11');
  for (const [slot, wie] of [
    [ids.ddA, ids.a],
    [ids.ddB, ids.b],
  ]) {
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(uuid(), ids.period, wie, slot);
  }
  ids.linkA = aiosPersoonlijkeLink(ids.a, ids.period, getBaseUrl());
  ids.linkB = aiosPersoonlijkeLink(ids.b, ids.period, getBaseUrl());
});

test.afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(snapshot.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

test('one AIOS asks, the other approves, and both rosters show the swap', async ({ browser }) => {
  test.setTimeout(90_000);
  const naamB = `arb-${stamp % 100000}`;

  const ctxA = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const a = await ctxA.newPage();
  await a.goto(ids.linkA);
  const ruilenA = a.getByTestId('aios-ruilen');
  await expect(ruilenA.getByRole('heading', { name: 'Ruilen', exact: true })).toBeVisible();
  await ruilenA.getByRole('button', { name: /^Ruilen: Dagdienst, za 4 sep/ }).click();
  const kandidaten = ruilenA.getByTestId('aios-ruil-kandidaten');
  await kandidaten.getByLabel('Toelichting voor je collega (mag leeg)').fill('familieweekend');
  await kandidaten.getByRole('button', { name: `Vraag ${naamB}: Dagdienst, za 11 sep` }).click();
  await expect(ruilenA.getByText(/^Je ruilverzoek is verstuurd\./)).toBeVisible();
  // Their requests: "Jouw ruilverzoeken" with a filter and the number behind every status.
  const verzonden = ruilenA.getByTestId('aios-ruilen-verzonden');
  await expect(verzonden.getByRole('heading', { name: 'Jouw ruilverzoeken' })).toBeVisible();
  await expect(verzonden.getByLabel('Filter op status: Jouw ruilverzoeken').locator('option')).toHaveText([
    'Alle statussen (1)',
    'In afwachting (1)',
    'Goedgekeurd (0)',
    'Afgewezen (0)',
    'Ingetrokken (0)',
  ]);
  await expect(verzonden.getByTestId('aios-ruil-verzonden')).toContainText('In afwachting');
  // A reminder: only after the yes, which says there was none yet.
  const herinnering = verzonden.getByTestId('aios-ruil-herinnering');
  await expect(herinnering).toContainText('Er is nog geen herinnering gestuurd.');
  await herinnering.getByRole('button', { name: 'Herinnering sturen' }).click();
  await expect(herinnering.getByRole('alertdialog')).toContainText('Weet je zeker dat je een herinnering wilt sturen');
  await herinnering.getByRole('button', { name: 'Annuleren' }).click();
  await expect(herinnering).toContainText('Er is nog geen herinnering gestuurd.');
  await herinnering.getByRole('button', { name: 'Herinnering sturen' }).click();
  await herinnering.getByRole('button', { name: 'Ja, stuur herinnering' }).click();
  await expect(herinnering).toContainText('Laatste herinnering:');
  await expect(herinnering.getByRole('button', { name: 'Herinnering sturen' })).toBeDisabled();
  expect(await a.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  const ctxB = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const b = await ctxB.newPage();
  await b.goto(ids.linkB);
  const ontvangen = b.getByTestId('aios-ruilen-ontvangen');
  await expect(ontvangen.getByRole('heading', { name: 'Ontvangen ruilverzoeken' })).toBeVisible();
  await expect(ontvangen.getByLabel('Filter op status: Ontvangen ruilverzoeken').locator('option').first()).toHaveText('Alle statussen (1)');
  const verzoek = b.getByTestId('aios-ruil-aan-mij');
  await expect(verzoek).toContainText('In afwachting');
  await expect(verzoek).toContainText('Toelichting: familieweekend');
  await verzoek.getByRole('button', { name: 'Goedkeuren' }).click();
  await expect(b.getByText('Goedgekeurd. Je rooster is aangepast.', { exact: false })).toBeVisible();
  await expect(b.getByTestId('aios-mijn-rooster').getByText(/za 4 sep/)).toBeVisible();

  expect(wieHeeft(ids.ddA)).toBe(ids.b);
  expect(wieHeeft(ids.ddB)).toBe(ids.a);
  await a.reload();
  await expect(a.getByTestId('aios-mijn-rooster').getByText(/za 11 sep/)).toBeVisible();
  // The default filter shows what waits; "Alle statussen" shows it as approved.
  await a.getByTestId('aios-ruilen').getByLabel('Filter op status: Jouw ruilverzoeken').selectOption('');
  await expect(a.getByTestId('aios-ruil-verzonden')).toContainText('Goedgekeurd');
  await ctxA.close();
  await ctxB.close();
});

test('on a voorlopig roster the page says why nothing can be swapped, and asks for no request', async ({ browser }) => {
  db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = NULL WHERE id = ?`).run(ids.period);
  try {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(ids.linkA);
    const voorlopig = page.getByTestId('aios-ruilen-voorlopig');
    await expect(voorlopig).toContainText('Ruilen kan pas als het rooster definitief is. Klopt er iets niet in je voorlopige rooster? Meld dat bij de planner');
    await expect(page.getByTestId('aios-ruilen').getByRole('button', { name: /^Ruilen: / })).toHaveCount(0);
    await ctx.close();
  } finally {
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = datetime('now') WHERE id = ?`).run(ids.period);
  }
});

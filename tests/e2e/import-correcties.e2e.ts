import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { db } from '@/db/client';
import { buildXlsx } from '../fixtures/buildXlsx';
import { SALDO_KOP } from '@/lib/importSjablonen';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * The rule (1.1.0): a beginsaldo from an Excel file and a correctie entered
 * after the period opened - the invitations out, the wizard long done - give
 * that person that many more or fewer shifts in the roster the real solver
 * makes. Through the section "Import en correcties", the first section of
 * the period page, with the real solver behind the app.
 *
 * Eight avonddiensten, four people, a streefbereik of exactly 2 each. The
 * file gives one person one avonddienst extra, the correctie another one
 * fewer: the only roster that fills every dienst within everyone's bereik
 * is then 3, 1, 2 and 2. Without them it is 2 for everyone, so a saldo the
 * solver never got makes this test fail.
 */

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ids: Record<string, string> = {};
const codenaam: Record<string, string> = {};

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

test.beforeAll(() => {
  const now = new Date().toISOString();
  ids.ruleset = insert('dienstrooster_ruleset', { naam: 'E2E achteraf', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: `E2E achteraf ${Date.now()}`, type: 'ACHTERWACHT', ruleset_id: ids.ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam: `E2E achteraf ${Date.now()}`,
    start_datum: '2034-01-02',
    eind_datum: '2034-02-26',
    deadline: '2033-12-15T12:00:00.000Z',
    status: 'OPEN',
    bevroren_ruleset_json: JSON.stringify({ windowWeeks: 0, bandAvond: [2, 2], bandWeekend: [0, 0], bandFeestdag: [0, 0] }),
    overloop_bevestigd_op: now,
    uitgenodigd_op: now,
    aangemaakt_op: now,
  });
  // One avonddienst on each Monday of the eight weeks (2034-01-02 is a Monday, ISO week 1).
  for (let week = 0; week < 8; week++) {
    const d = new Date(Date.UTC(2034, 0, 2 + week * 7));
    insert('dienstrooster_shift_slot', {
      period_id: ids.period,
      shift_type_id: ids.avond,
      datum: d.toISOString().slice(0, 10),
      iso_jaar: 2034,
      iso_week: week + 1,
      is_feestdag: 0,
      benodigd_aantal_personen: 1,
    });
  }
  for (const label of ['extra', 'minder', 'gewoon1', 'gewoon2']) {
    codenaam[label] = `E2E-achteraf-${label}-${crypto.randomUUID().slice(0, 4)}`;
    ids[label] = insert('dienstrooster_person', { codenaam: codenaam[label], rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[label], pool_id: ids.pool, geldig_vanaf: '2020-01-01', geldig_tot: '2099-12-31' });
  }
});

test.afterAll(() => {
  // Everything this test made or the app wrote for it: by the period's id in any column that names a
  // period, then the people, the pool and the ruleset.
  const periodColumns = ['period_id', 'periode_id', 'schedule_period_id', 'schedule_version_id', 'geldt_voor_periode_id', 'scope_id', 'entiteit_id'];
  const people = ['extra', 'minder', 'gewoon1', 'gewoon2'].map((l) => ids[l]).filter(Boolean);
  db.pragma('foreign_keys = OFF');
  try {
    const tabellen = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dienstrooster_%'`).all() as Array<{ name: string }>).map((t) => t.name);
    for (const tabel of tabellen) {
      const kolommen = (db.prepare(`PRAGMA table_info(${tabel})`).all() as Array<{ name: string }>).map((c) => c.name);
      for (const kolom of kolommen) {
        if (periodColumns.includes(kolom)) db.prepare(`DELETE FROM ${tabel} WHERE ${kolom} = ?`).run(ids.period);
        if (kolom === 'person_id' || kolom === 'actor_id') {
          for (const p of people) db.prepare(`DELETE FROM ${tabel} WHERE ${kolom} = ?`).run(p);
        }
        if (kolom === 'pool_id') db.prepare(`DELETE FROM ${tabel} WHERE ${kolom} = ?`).run(ids.pool);
      }
    }
    for (const p of people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(p);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(ids.period);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(ids.pool);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(ids.ruleset);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

test('an import and a correctie after the opening give each person that many shifts from the real solver', async ({ page }) => {
  test.setTimeout(6 * 60 * 1000);
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);

  // The first section of the page, closed until opened.
  const sectieKnoppen = page.locator('h2 > button[aria-expanded]');
  await expect(sectieKnoppen.first()).toHaveText('Import en correcties');
  await sectieKnoppen.first().click();
  const sectie = page.getByTestId('import-en-correcties');
  await expect(sectie).toBeVisible();

  // The sjabloon is in the section and downloads as a workbook.
  const sjabloon = sectie.getByRole('link', { name: 'Sjabloon downloaden (Excel)' });
  await expect(sjabloon).toBeVisible();
  const download = await page.request.get(new URL((await sjabloon.getAttribute('href'))!, getBaseUrl()).toString());
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toContain(XLSX);

  // The Excel file: one avonddienst extra.
  await sectie.getByLabel('Beginsaldo als Excel-bestand').setInputFiles({
    name: 'saldo.xlsx',
    mimeType: XLSX,
    buffer: buildXlsx([[...SALDO_KOP], [codenaam.extra, 1, null]]),
  });
  await sectie.getByRole('button', { name: 'Importeren' }).click();
  await expect(sectie.getByText('Beginsaldo geïmporteerd voor 1 persoon.')).toBeVisible();
  await sectie.getByText('1 persoon heeft een beginsaldo').click();
  await expect(sectie.getByTestId('beginsaldi')).toContainText(`${codenaam.extra}: 1 avonddienst extra`);

  // The correctie: one avonddienst fewer, saved at once.
  await sectie.getByLabel('Persoon').selectOption({ label: codenaam.minder });
  await sectie.getByLabel('Type').selectOption({ label: 'Avonddienst' });
  await sectie.getByLabel('Reden').selectOption({ label: 'Overig' });
  await sectie.getByRole('button', { name: 'Minder diensten' }).click();
  await sectie.getByLabel('Aantal').fill('1');
  await sectie.getByRole('button', { name: 'Correctie opslaan' }).click();
  await expect(sectie.getByText(`Correctie voor ${codenaam.minder} opgeslagen.`)).toBeVisible();
  await expect(sectie.getByTestId('correcties')).toContainText('1 avonddienst minder');

  // Close the period as the planner does, then generate with the real solver. The question says who has
  // not confirmed yet (R-08, 1.7.0): in this period nobody has.
  await page.getByRole('button', { name: '🔒 Periode sluiten' }).click();
  await expect(page.getByTestId('sluit-vraag')).toContainText(/deelnemers hebben hun voorkeuren nog niet bevestigd|deelnemers heeft de voorkeuren nog niet bevestigd/);
  await expect(page.getByTestId('sluit-vraag')).toContainText('Na het sluiten kan niemand meer iets invullen of wijzigen.');
  await page.getByRole('button', { name: 'Zeker weten? Nogmaals klikken' }).click();
  await expect(page.getByText('🔒 Status: Gesloten')).toBeVisible();

  const start = await page.request.post(`${getBaseUrl()}/api/planner/period/${ids.period}/generate-roster`, {
    data: { time_limit_seconds: 60 },
  });
  expect(start.status(), await start.text()).toBe(200);
  const jobId = (await start.json()).data.job_id as string;
  let status = 'RUNNING';
  for (let i = 0; i < 240 && status === 'RUNNING'; i++) {
    await page.waitForTimeout(1000);
    const poll = await page.request.get(`${getBaseUrl()}/api/planner/period/${ids.period}/generate-roster/status?job_id=${jobId}`);
    status = (await poll.json()).data?.status ?? 'ERROR';
  }
  expect(status).toBe('DONE');

  const telling = Object.fromEntries(
    (db
      .prepare(
        `SELECT person_id, COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ? GROUP BY person_id`
      )
      .all(ids.period) as Array<{ person_id: string; n: number }>).map((r) => [r.person_id, r.n])
  );
  expect({
    extra: telling[ids.extra] ?? 0,
    minder: telling[ids.minder] ?? 0,
    gewoon1: telling[ids.gewoon1] ?? 0,
    gewoon2: telling[ids.gewoon2] ?? 0,
  }).toEqual({ extra: 3, minder: 1, gewoon1: 2, gewoon2: 2 });

  // Once generated the section says why it no longer takes a saldo.
  await page.reload();
  await page.locator('h2 > button[aria-expanded]').first().click();
  await expect(page.getByTestId('saldo-dicht')).toContainText('al een rooster gegenereerd');
  await expect(page.getByTestId('import-en-correcties').getByLabel('Beginsaldo als Excel-bestand')).toHaveCount(0);
});

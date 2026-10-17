import fs from 'fs';
import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { readFirstSheet } from '@/lib/xlsx';
import { getBaseUrl, loginAsBeheerder } from './setup';

/**
 * The AIOS's preferences, step 2 (docs/aios-rooster.md): on their own page
 * (/aios/<token>), at 375 pixels, an AIOS passes Deeltijd, marks a whole evening block
 * with taps, finds geblokkeerd skipped on a feestdag, saves their requests
 * and hands in; the planner sees it under "Status voorkeuren".
 */

const q = aiosQuarter(2095, 2); // With Koningsdag and Hemelvaart in it.
const stamp = Date.now();
const ids = {} as { period: string; person: string; codenaam: string; token: string };
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
    `INSERT INTO dienstrooster_schedule_period (id, naam, pool_id, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', datetime('now'))`
  ).run(ids.period, `AIOS e2e ${stamp}`, pool, q.start_datum, q.eind_datum, '2095-02-01T17:00');
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(pool)!, q.start_datum, q.eind_datum))();
  ids.person = uuid();
  ids.codenaam = `aios-e2e-${stamp}`;
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(
    ids.person,
    ids.codenaam
  );
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2095-01-01', '2095-12-31')`
  ).run(uuid(), ids.person, pool);
  ids.token = generateAccessToken();
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(uuid(), ids.person, ids.period, hashToken(ids.token));
});

test.afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(snapshot.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

const datumLang = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

test('an AIOS marks a block, finds no geblokkeerd on a feestdag, asks and hands in', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  // The AIOS's own page (app/aios/[token]), not the achterwacht's /person/.
  await page.goto(`${getBaseUrl()}/aios/${ids.token}`);

  // Deeltijd first, with what a part-time day means for the AIOS.
  await expect(page.getByText(/Je avond op die dag staat op liever niet/)).toBeVisible();
  await page.getByRole('button', { name: 'Volgende: voorkeuren opgeven' }).click();

  await expect(page.getByRole('heading', { name: 'Je voorkeuren per dienst' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  // What a feestdag means, in a box of its own (components/AiosFeestdagUitleg.tsx).
  await expect(page.getByText('★ Let op bij feestdagen')).toBeVisible();
  await expect(page.getByText(/Ben je afwezig op een feestdag, dan telt die dag als liever niet/)).toBeVisible();

  // The first evening block of a whole week, Sunday to Tuesday: one box.
  const blok = page.getByRole('button', { name: /^Avonddienst \(blok zo .*: geen voorkeur/ }).first();
  const label = (await blok.getAttribute('aria-label'))!.split(':')[0];
  const zelfde = page.getByRole('button', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}:`) });
  await blok.click();
  await expect(zelfde).toHaveAttribute('aria-label', /: voorkeur/);
  await zelfde.click();
  await expect(zelfde).toHaveAttribute('aria-label', /: liever niet/);
  await zelfde.click();
  await expect(zelfde).toHaveAttribute('aria-label', /: geblokkeerd\. Tik voor geen voorkeur/);
  await expect(page.getByText(/^1 van de \d+ avondblokken geblokkeerd/).first()).toBeVisible();

  // A dagdienst on a feestdag: from liever niet straight back to none.
  const feestdag = db
    .prepare(
      `SELECT sl.datum FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND sl.is_feestdag = 1 AND st.code = 'DD' ORDER BY sl.datum LIMIT 1`
    )
    .get(ids.period) as { datum: string };
  const dd = page.getByRole('button', { name: new RegExp(`^Dagdienst ${datumLang(feestdag.datum)}:`) });
  await dd.click();
  await expect(dd).toHaveAttribute('aria-label', /: voorkeur/);
  await dd.click();
  await expect(dd).toHaveAttribute('aria-label', /: liever niet\. Tik voor geen voorkeur/);

  // The requests at the top.
  await page.getByLabel(/^4 nachten/).check();
  await page.getByLabel(/^Inwerken/).check();
  await page.locator('#aios-inwerken_van').fill(q.start_datum);
  await page.locator('#aios-inwerken_tot').fill(q.start_datum);
  await page.getByLabel('Algemene verzoeken').fill('Liever geen nachten in mei');
  await page.getByRole('button', { name: 'Verzoeken opslaan' }).click();
  await expect(page.getByText('Je verzoeken zijn opgeslagen.')).toBeVisible();

  await page.getByRole('button', { name: 'Volgende: bevestigen' }).click();
  await expect(page.getByRole('heading', { name: 'Bevestigen' })).toBeVisible();
  await expect(page.getByText('1 dienst of blok geblokkeerd')).toBeVisible();
  await expect(page.getByText(/Verzoeken: 4 nachten, inwerken van/)).toBeVisible();
  await page.getByRole('button', { name: 'Bevestigen en indienen' }).click();
  await expect(page.getByRole('heading', { name: 'Voorkeuren ingediend' })).toBeVisible();

  const wens = db.prepare('SELECT vier_nachten, inwerken_van, opmerking FROM dienstrooster_aios_wens WHERE period_id = ? AND person_id = ?').get(ids.period, ids.person);
  expect(wens).toEqual({ vier_nachten: 1, inwerken_van: q.start_datum, opmerking: 'Liever geen nachten in mei' });

  // The planner sees it.
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
  await expect(page.getByRole('heading', { name: 'Status voorkeuren' })).toBeVisible();
  const rij = page.locator('li', { hasText: ids.codenaam });
  await expect(rij).toContainText('Ingediend');
  await expect(rij).toContainText('1 geblokkeerd');
  await expect(rij).toContainText('4 nachten');
  await expect(page.getByRole('button', { name: 'Links downloaden' })).toBeVisible();
  await expect(page.getByText('Mail naar de AIOS', { exact: true })).toBeVisible();
  // The AIOS's own automatic reminders, off while their mail is not set up.
  await expect(page.getByTestId('aios-auto-herinneringen')).toContainText('de mail voor de AIOS is nog niet ingesteld');

  // The requests as a workbook, with this AIOS's 4 nachten in it.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Verzoeken per AIOS' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^verzoeken-aios-.*\.xlsx$/);
  const [kop, ...rijen] = readFirstSheet(fs.readFileSync((await download.path())!));
  const mijn = rijen.find((r) => r[0] === ids.codenaam)!;
  expect(mijn[kop.indexOf('Status')]).toBe('Ingediend');
  expect(mijn[kop.indexOf('4 nachten (wo t/m za)')]).toBe('ja');
  expect(mijn[kop.indexOf('Opmerking')]).toBe('Liever geen nachten in mei');
  const [perDienst] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '⬇ Voorkeuren per dienst' }).click()]);
  const [dienstKop, ...diensten] = readFirstSheet(fs.readFileSync((await perDienst.path())!));
  const kolom = dienstKop.indexOf(ids.codenaam);
  expect(diensten.filter((r) => r[5]?.startsWith('avondblok zo t/m di') && r[kolom] === 'geblokkeerd').length).toBe(3);
});

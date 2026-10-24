import fs from 'fs';
import { test, expect, type Page } from '@playwright/test';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { syncAiosPersoon } from '@/lib/aiosSync';
import { readFirstSheet } from '@/lib/xlsx';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';
import { getBaseUrl, loginAsBeheerder, loginAsPlanner, openAiosSectie, openDienstrooster } from './setup';

/**
 * The audit of 0.90.0 to 0.93.0 in the browser (points 1 to 8 of the
 * request): the toelichting of an AIOS from their own page to the planner's
 * Excel, import and manual correction and nowhere else; Personeel beheren
 * with the factor from the part-time days; closing and opening the period
 * with its message about a made roster; the message about empty diensten
 * that stays after a refresh and a new login; and what the planner of the
 * AIOS may do against what the beheerder may.
 *
 * Two weeks from a Wednesday, eight fulltime AIOS (so the nights Sunday to
 * Tuesday stay empty, hard rule 5), the real AIOS solver for the roster. One
 * world for the four tests, in order.
 */

test.describe.configure({ mode: 'serial' });

const START = '2096-07-04'; // a Wednesday
const EIND = '2096-07-17'; // the Tuesday two weeks on
const stamp = Date.now() % 1_000_000;
const TEKST_A = 'Bruiloft van mijn zus';
const TEKST_A_NIEUW = 'Verhuizing';
const TEKST_B = 'Studiedag';
const ids = {} as {
  pool: string;
  period: string;
  mensen: Array<{ id: string; codenaam: string }>;
  tokenA: string;
  tokenB: string;
};
let snapshot: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

const redenen = () =>
  db
    .prepare(
      `SELECT p.codenaam, r.datum, r.tekst FROM dienstrooster_aios_reden r JOIN dienstrooster_person p ON p.id = r.person_id
       WHERE r.period_id = ? ORDER BY p.codenaam, r.datum`
    )
    .all(ids.period) as Array<{ codenaam: string; datum: string; tekst: string }>;

test.beforeAll(() => {
  snapshot = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  ids.pool = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'AIOS' ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
  ids.period = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, naam, pool_id, start_datum, eind_datum, deadline, status, auto_herinneren, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 0, datetime('now'))`
  ).run(ids.period, `AIOS audit ${stamp}`, ids.pool, START, EIND, '2096-05-01T17:00');
  db.transaction(() => persistAiosSlots(ids.period, aiosShiftTypes(ids.pool)!, START, EIND))();
  ids.mensen = [];
  for (let i = 0; i < 8; i++) {
    const id = uuid();
    const codenaam = `audit${i}-${stamp}`;
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(id, codenaam);
    db.prepare(`INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2096-01-01', '2096-12-31')`).run(
      uuid(),
      id,
      ids.pool
    );
    ids.mensen.push({ id, codenaam });
  }
  const link = (persoon: string) => {
    const token = generateAccessToken();
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(uuid(), persoon, ids.period, hashToken(token));
    return token;
  };
  ids.tokenA = link(ids.mensen[0].id);
  ids.tokenB = link(ids.mensen[1].id);
  // B is part-time on Wednesdays, every week: 0,8 (and not on the Sunday to Tuesday evening block B is asked to mark below).
  db.prepare(
    `INSERT INTO dienstrooster_parttime_pattern (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
     VALUES (?, ?, 'WO', 'ELKE_WEEK', '2096-01-01', '2096-12-31', ?, datetime('now'))`
  ).run(uuid(), ids.mensen[1].id, ids.mensen[1].id);
  syncAiosPersoon(ids.mensen[1].id);
});

test.afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(snapshot.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

async function handIn(page: Page, token: string): Promise<void> {
  await page.goto(`${getBaseUrl()}/aios/${token}`);
  await page.getByRole('button', { name: 'Volgende: voorkeuren opgeven' }).click();
  await page.getByRole('button', { name: 'Volgende: bevestigen' }).click();
  await page.getByRole('button', { name: 'Bevestigen en indienen' }).click();
  await expect(page.getByRole('heading', { name: 'Voorkeuren ingediend' })).toBeVisible();
}

/** Everything the page and its own API say to this participant, as one string. */
async function wat(page: Page, personId: string): Promise<string> {
  const res = await page.request.get(`${getBaseUrl()}/api/aios/deelnemer/${personId}/periode/${ids.period}`);
  return `${await page.content()}\n${res.status()}\n${await res.text()}`;
}

async function voorkeurenOverzicht(page: Page): Promise<string[][]> {
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
  await openAiosSectie(page, 'Exporteren & communicatie');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Voorkeurenoverzicht downloaden/ }).click()]);
  return readFirstSheet(fs.readFileSync((await download.path())!));
}

test('toelichting: the AIOS types it, the planner reads it, a colleague never sees it, the beheerder imports it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const [A, B] = ids.mensen;

  await test.step('A marks an evening block geblokkeerd; the field says it is optional and saves on leaving it', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${getBaseUrl()}/aios/${ids.tokenA}`);
    await page.getByRole('button', { name: 'Volgende: voorkeuren opgeven' }).click();
    const blok = page.getByRole('button', { name: /^Avonddienst \(blok zo .*: geen voorkeur/ }).first();
    const label = (await blok.getAttribute('aria-label'))!.split(':')[0];
    const zelfde = page.getByRole('button', { name: new RegExp(`^${label.replace(/[()]/g, '\\$&')}:`) });
    await blok.click();
    await zelfde.click();
    await zelfde.click();
    await expect(zelfde).toHaveAttribute('aria-label', /: geblokkeerd\. Tik voor geen voorkeur/);

    const groep = page.getByTestId('aios-redenen');
    await expect(groep).toContainText('Toelichting bij je dagen in deze week (niet verplicht)');
    await expect(groep).toContainText('Alleen de planner van de AIOS ziet dit');
    // Where the planner sees it: only while correcting or filling in the roster by hand, nowhere else.
    await expect(groep).toContainText('alleen bij het met de hand aanpassen of aanvullen van het rooster');
    await expect(groep).not.toContainText('Excel');
    await expect(groep).toContainText('Andere AIOS zien het nooit, ook niet bij een ruilverzoek');
    // The block is three days: three fields, each marked optional.
    await expect(groep.getByLabel(/^Toelichting voor .*\(niet verplicht\)/)).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

    // Typing and going straight on: leaving the field saves it before the click lands.
    await groep.getByLabel(/^Toelichting voor /).first().fill(TEKST_A);
    await page.getByRole('button', { name: 'Volgende: bevestigen' }).click();
    await expect(page.getByRole('heading', { name: 'Bevestigen' })).toBeVisible();
    await expect.poll(() => redenen().map((r) => r.tekst)).toEqual([TEKST_A]);
    // Handing in without a toelichting on the other two days is fine: it is optional.
    await page.getByRole('button', { name: 'Bevestigen en indienen' }).click();
    await expect(page.getByRole('heading', { name: 'Voorkeuren ingediend' })).toBeVisible();
    // Their own page and API give A their own text back.
    expect(await wat(page, A.id)).toContain(TEKST_A);
  });

  await test.step('B hands in; nothing of A is on B\'s page, in B\'s API, or reachable with B\'s link', async () => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const b = await ctx.newPage();
    await handIn(b, ids.tokenB);
    const wat_b = await wat(b, B.id);
    expect(wat_b).not.toContain(TEKST_A);
    expect(wat_b).not.toContain('Bruiloft');
    // B's session on A's data: refused, saying nothing.
    const lees = await b.request.get(`${getBaseUrl()}/api/aios/deelnemer/${A.id}/periode/${ids.period}`);
    expect([403, 404]).toContain(lees.status());
    expect(await lees.text()).not.toContain('Bruiloft');
    const schrijf = await b.request.put(`${getBaseUrl()}/api/aios/deelnemer/${A.id}/periode/${ids.period}/reden`, {
      data: { datum: START, tekst: 'overschreven' },
    });
    expect([403, 404]).toContain(schrijf.status());
    expect(redenen().map((r) => r.tekst)).toEqual([TEKST_A]);
    await ctx.close();
  });

  await test.step('the planner\'s voorkeurenoverzicht has it in A\'s column, on that day only, and in nobody else\'s', async () => {
    await loginAsBeheerder(page);
    const [kop, ...rijen] = await voorkeurenOverzicht(page);
    const kolomA = kop.indexOf(A.codenaam);
    expect(kolomA).toBeGreaterThan(-1);
    const blokRijen = rijen.filter((r) => r[5]?.startsWith('avondblok zo t/m di') && r[kolomA]?.startsWith('geblokkeerd'));
    expect(blokRijen.map((r) => r[kolomA]).sort()).toEqual(['geblokkeerd', 'geblokkeerd', `geblokkeerd: ${TEKST_A}`]);
    for (const rij of rijen) rij.forEach((cel, i) => i !== kolomA && expect(cel).not.toContain('Bruiloft'));
    // The import button is the beheerder's, while the period is open.
    await expect(page.getByRole('button', { name: /Voorkeuren importeren \(test\)/ })).toBeVisible();
  });

  await test.step('import by the beheerder: the check lists what changes, the apply does the same, A\'s text and B\'s block follow', async () => {
    const [kop, ...rijen] = await voorkeurenOverzicht(page);
    const kolomA = kop.indexOf(A.codenaam);
    const kolomB = kop.indexOf(B.codenaam);
    let eerste = true;
    const nieuw = rijen.map((r) => {
      const kopie = [...r];
      // A's text changes; B gets the same block geblokkeerd, with a text on its first day.
      if (r[5]?.startsWith('avondblok zo t/m di') && r[kolomA]?.startsWith('geblokkeerd')) {
        if (r[kolomA].includes(':')) kopie[kolomA] = `geblokkeerd: ${TEKST_A_NIEUW}`;
        kopie[kolomB] = r[kolomA].includes(':') ? `geblokkeerd: ${TEKST_B}` : 'geblokkeerd';
        eerste = false;
      }
      return kopie;
    });
    expect(eerste).toBe(false);
    await page.getByRole('button', { name: /Voorkeuren importeren \(test\)/ }).click();
    const dialoog = page.getByRole('dialog', { name: 'Voorkeuren van de AIOS importeren' });
    await dialoog.getByLabel('Excel-bestand met voorkeuren van de AIOS').setInputFiles({
      name: 'voorkeuren.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: buildXlsx([kop, ...nieuw]),
    });
    await dialoog.getByRole('button', { name: /^Controleren/ }).click();
    const resultaat = dialoog.getByTestId('import-resultaat');
    await expect(resultaat).toContainText(/\d+ keuzes veranderen/);
    const aantal = Number((await resultaat.textContent())!.match(/(\d+) keuzes veranderen/)![1]);
    await expect(resultaat).toContainText('toelichting');
    // Checking changed nothing.
    expect(redenen().map((r) => [r.codenaam, r.tekst])).toEqual([[A.codenaam, TEKST_A]]);
    await dialoog.getByRole('button', { name: new RegExp(`^Toepassen \\(${aantal} wijzigingen\\)`) }).click();
    await expect(resultaat).toContainText(`Klaar. ${aantal} keuzes aangepast bij 2 personen.`);
    expect(redenen().map((r) => [r.codenaam, r.tekst])).toEqual([
      [A.codenaam, TEKST_A_NIEUW],
      [B.codenaam, TEKST_B],
    ]);
  });

  await test.step('after the import everyone sees their own text and only that', async () => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    const b = await ctx.newPage();
    await b.goto(`${getBaseUrl()}/aios/${ids.tokenB}`);
    // The link is exchanged for a session by the page: wait for it before asking the API.
    await expect(b.getByRole('button', { name: /Ingediend/ })).toBeVisible();
    const inhoud = await wat(b, B.id);
    expect(inhoud).toContain(TEKST_B);
    expect(inhoud).not.toContain(TEKST_A_NIEUW);
    expect(inhoud).not.toContain('Bruiloft');
    await ctx.close();
  });
});

test('Personeel beheren: the factor from the part-time days, nog onbekend until handed in, never typed in', async ({ page }) => {
  const [A, B, C] = ids.mensen;
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/pool/${ids.pool}/staff`);
  const factor = (codenaam: string) => page.locator('tr', { hasText: codenaam }).getByTestId('deelnamefactor');
  // A and B handed in (the first test): A has no part-time day, B has Wednesdays.
  await expect(factor(A.codenaam)).toHaveText('Voltijd');
  await expect(factor(B.codenaam)).toHaveText('80%');
  await expect(factor(C.codenaam)).toHaveText('nog onbekend');
  // The list says which period the factors are about.
  await expect(page.getByTestId('deelnamefactor-periode')).toContainText(`AIOS audit ${stamp}`);

  // No place to type it: not when adding and not when changing.
  await expect(page.getByLabel('Deelnamefactor')).toHaveCount(0);
  await expect(page.getByTestId('deelnamefactor-uitleg')).toContainText('De deelnamefactor typ je niet in.');
  await page.locator('tr', { hasText: B.codenaam }).getByRole('button', { name: 'Bewerken' }).click();
  await expect(page.locator('tr', { hasText: B.codenaam }).locator('input[type="number"]')).toHaveCount(0);
  await page.locator('tr', { hasText: B.codenaam }).getByRole('button', { name: 'Annuleren' }).click();

  // The same on the achterwacht's page, and a new member keeps no factor of their own.
  const achterwacht = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'ACHTERWACHT' ORDER BY rowid LIMIT 1`).get() as { id: string }).id;
  await page.goto(`${getBaseUrl()}/planner/pool/${achterwacht}/staff`);
  await expect(page.getByLabel('Deelnamefactor')).toHaveCount(0);
  const nieuw = `audit-ach-${stamp}`;
  await page.getByPlaceholder('bijv. staf31').fill(nieuw);
  await page.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(factor(nieuw)).toHaveText('nog onbekend');
  const rij = db.prepare(`SELECT pm.deelnamefactor FROM dienstrooster_pool_membership pm JOIN dienstrooster_person p ON p.id = pm.person_id WHERE p.codenaam = ?`).get(nieuw) as {
    deelnamefactor: number;
  };
  expect(rij.deelnamefactor).toBe(1);
});

test('status, the roster, empty diensten that stay, and back to open', async ({ page, browser }) => {
  test.setTimeout(420_000);
  // Eight fulltimers, as the world says: B's Wednesdays were for the factor of the test before. With them the
  // nights Sunday to Tuesday could be filled, and nothing would be left to tell about.
  db.prepare('DELETE FROM dienstrooster_availability WHERE bron_pattern_id IN (SELECT id FROM dienstrooster_parttime_pattern WHERE person_id = ?)').run(ids.mensen[1].id);
  db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE person_id = ?').run(ids.mensen[1].id);
  syncAiosPersoon(ids.mensen[1].id);
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
  const status = page.getByTestId('aios-periode-status');
  const sluit = async () => {
    await status.getByRole('button', { name: /Periode sluiten/ }).click();
    await status.getByRole('button', { name: /Zeker weten/ }).click();
  };
  const open = async () => {
    await status.getByRole('button', { name: /Terug naar open/ }).click();
    await status.getByRole('button', { name: /Zeker weten/ }).click();
  };

  await test.step('closing and opening again, without a roster, as the achterwacht does', async () => {
    await expect(status).toContainText('Status: Open');
    await sluit();
    await expect(status).toContainText('Status: Gesloten');
    // Closed: the AIOS cannot change their requests any more.
    const A = ids.mensen[0];
    const dicht = await page.request.put(`${getBaseUrl()}/api/aios/deelnemer/${A.id}/periode/${ids.period}/reden`, { data: { datum: START, tekst: 'x' } });
    expect(dicht.status()).toBeGreaterThanOrEqual(400);
    await open();
    await expect(status).toContainText('Status: Open');
    await sluit();
    await expect(status).toContainText('Status: Gesloten');
  });

  let leeg = 0;
  await test.step('making the roster; what is still empty is told, and told again after a refresh and a new login', async () => {
    const paneel = page.getByTestId('aios-rooster-maken');
    await paneel.getByRole('button', { name: 'Rooster maken' }).click();
    const melding = paneel.getByTestId('aios-lege-diensten');
    await expect(melding.getByText(/^Gemaakt op .*: \d+ diensten ingedeeld/)).toBeVisible({ timeout: 250_000 });
    const nogLeeg = async (p: Page) => {
      await expect(p.getByTestId('aios-nog-leeg')).toContainText(/Nog leeg: \d+/);
      return Number(((await p.getByTestId('aios-nog-leeg').textContent()) ?? '').match(/Nog leeg: (\d+)/)![1]);
    };
    leeg = await nogLeeg(page);
    expect(leeg).toBeGreaterThan(0);
    await expect(status).toContainText('Status: Gegenereerd');
    const tekst = await melding.textContent();

    await page.reload();
    await expect(page.getByTestId('aios-lege-diensten')).toHaveText(tekst!);

    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const nieuw = await ctx.newPage();
    await loginAsBeheerder(nieuw);
    await nieuw.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
    await expect(nieuw.getByTestId('aios-lege-diensten')).toHaveText(tekst!);
    await ctx.close();
  });

  await test.step('by hand: the reason of the AIOS is on one block only, and filling an empty block lowers what is still empty', async () => {
    await openDienstrooster(page);
    // The reason of A (the imported text) shows on the candidate in the block with A's marked days.
    const avond = page.getByRole('button', { name: /^Avondblok .*Wijzigen$/ });
    const aantal = await avond.count();
    expect(aantal).toBeGreaterThan(0);
    let gezien = 0;
    let dubbelGezien = 0;
    for (let i = 0; i < aantal; i++) {
      await avond.nth(i).click();
      const dialoog = page.getByTestId('aios-wijzigen');
      await expect(dialoog.getByRole('heading', { name: 'Wie doet dit?' })).toBeVisible();
      // The candidates load after the heading is there: wait for the list before looking for a text in it.
      await expect(dialoog.getByRole('button', { name: /^Kies / }).first()).toBeVisible();
      const toelichting = dialoog.getByTestId('aios-toelichting');
      if (await toelichting.count()) {
        gezien++;
        await expect(toelichting.first()).toContainText(`Toelichting van de AIOS voor `);
        await expect(dialoog).toContainText(TEKST_A_NIEUW);
        await expect(dialoog).not.toContainText('Bruiloft');
        // Choosing A shows the same reason again in the step that asks to be sure.
        await dialoog.locator('ul[aria-label="AIOS"] > li').filter({ hasText: TEKST_A_NIEUW }).getByRole('button', { name: /^Kies / }).click();
        await expect(dialoog.getByTestId('aios-toelichting-zeker')).toContainText(TEKST_A_NIEUW);
        await dialoog.getByRole('button', { name: 'Annuleren' }).click();
      }
      // Whoever has the nights of these days would have two diensten a day: said with the dienst, and asked twice.
      const dubbel = dialoog.locator('ul[aria-label="AIOS"] > li').filter({ hasText: 'al een andere dienst' });
      if (await dubbel.count()) {
        dubbelGezien++;
        await expect(dubbel.first()).toContainText('Een AIOS kan maar één dienst per dag doen.');
        await dubbel.first().getByRole('button', { name: /^Kies / }).click();
        await expect(dialoog.getByTestId('aios-twee-op-een-dag')).toContainText('Is dit echt de bedoeling?');
        await expect(dialoog.getByRole('button', { name: 'Ja, dit is echt de bedoeling' })).toBeVisible();
        await dialoog.getByRole('button', { name: 'Annuleren' }).click();
      }
      await dialoog.getByRole('button', { name: 'Sluiten' }).click();
    }
    expect(gezien).toBeGreaterThan(0);
    expect(dubbelGezien).toBeGreaterThan(0);

    // An empty night block to someone: what is still empty drops, now and after a refresh.
    await page.getByRole('button', { name: /^Nachtblok .*: leeg\. Wijzigen$/ }).first().click();
    const dialoog = page.getByTestId('aios-wijzigen');
    await dialoog.getByRole('button', { name: /^Kies / }).first().click();
    const toch = dialoog.getByRole('button', { name: 'Ja, toch indelen' });
    const klaar = page.getByTestId('aios-laatste-wijziging');
    await expect(klaar.or(toch)).toBeVisible();
    if (await toch.isVisible()) await toch.click();
    await expect(klaar).toBeVisible();
    // The card above reads the roster again after the change: wait for the new number.
    const nogLeegNu = async () => Number(((await page.getByTestId('aios-nog-leeg').textContent()) ?? '').match(/(\d+)/)?.[1] ?? '0');
    await expect.poll(nogLeegNu).toBeLessThan(leeg);
    const nu = await nogLeegNu();
    await page.reload();
    const naVerversen = ((await page.getByTestId('aios-nog-leeg').textContent()) ?? '').match(/(\d+)/)?.[1];
    expect(Number(naVerversen)).toBe(nu);
  });

  await test.step('back to open with a made roster: refused, and it says to remove the roster first', async () => {
    await status.getByRole('button', { name: /Terug naar open/ }).click();
    await expect(page.getByTestId('aios-eerst-verwijderen')).toContainText(/verwijder/i);
    await expect(status).toContainText('Status: Gegenereerd');
    expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(ids.period) as { status: string }).status).toBe('GEGENEREERD');
    // The same through the API: refused.
    const res = await page.request.post(`${getBaseUrl()}/api/aios/periode/${ids.period}/heropenen`, { data: {} });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  await test.step('follow what it says: remove the roster, the message about empty diensten goes with it, then open again', async () => {
    const paneel = page.getByTestId('aios-rooster-maken');
    await paneel.getByRole('button', { name: 'Rooster verwijderen' }).click();
    await paneel.getByRole('button', { name: 'Ja, rooster verwijderen' }).click();
    await expect(paneel.getByRole('button', { name: 'Rooster maken' })).toBeVisible();
    await expect(page.getByTestId('aios-lege-diensten')).toHaveCount(0);
    await expect(status).toContainText('Status: Gesloten');
    // The message about what comes first was for the roster that is gone: it does not stay beside a button that works now.
    await expect(page.getByTestId('aios-eerst-verwijderen')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('aios-lege-diensten')).toHaveCount(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_generatie WHERE period_id = ?').get(ids.period) as { n: number }).n).toBe(0);
    await open();
    await expect(status).toContainText('Status: Open');
  });
});

test('the planner of the AIOS: Exporteren & communicatie without the beheerder\'s buttons, closing and opening, and nothing of the achterwacht', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const planner = `auditplanner${stamp}`;
  const TIJDELIJK = 'Tijdelijk-Wachtwoord-7#';
  const EIGEN = 'Eigen-Wachtwoord-Lang-9!';
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/accounts`);
  await page.getByLabel('Codenaam').fill(planner);
  await page.getByLabel('Rol', { exact: true }).selectOption({ label: 'Planner' });
  await page.getByLabel('Dienst').selectOption({ label: 'AIOS' });
  await page.getByLabel('Tijdelijk wachtwoord', { exact: true }).fill(TIJDELIJK);
  await page.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(page.getByText(`${planner} is toegevoegd als planner voor de AIOS.`)).toBeVisible();

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${getBaseUrl()}/planner/login`);
  await p.getByLabel('Codenaam').fill(planner);
  await p.getByLabel('Wachtwoord', { exact: true }).fill(TIJDELIJK);
  await p.getByRole('button', { name: 'Inloggen' }).click();
  await p.getByLabel('Nieuw wachtwoord', { exact: true }).fill(EIGEN);
  await p.getByLabel('Nieuw wachtwoord herhalen').fill(EIGEN);
  await p.getByRole('button', { name: 'Wachtwoord opslaan en verder' }).click();
  await p.waitForURL(/\/planner\/?$/);

  await p.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
  await openAiosSectie(p, 'Exporteren & communicatie');
  const sectie = p.getByTestId('aios-exporteren');
  await expect(sectie.getByRole('link', { name: /Voorkeurenoverzicht downloaden/ })).toBeVisible();
  await expect(sectie.getByRole('link', { name: /Statusrapport downloaden/ })).toBeVisible();
  // The planner's own voorkeurenoverzicht has no toelichting: only the beheerder's file, the back-up, has them.
  const bestand = await p.request.get(`${getBaseUrl()}/api/aios/periode/${ids.period}/download-voorkeuren`);
  expect(bestand.status()).toBe(200);
  const plannerRijen = readFirstSheet(Buffer.from(await bestand.body()));
  expect(plannerRijen.flat().some((cel) => String(cel).includes(TEKST_A_NIEUW) || String(cel).includes(TEKST_B))).toBe(false);
  expect(plannerRijen.flat().some((cel) => String(cel).startsWith('geblokkeerd'))).toBe(true);
  // The beheerder's: the mail settings and the import.
  await expect(p.getByRole('button', { name: /Mailinstellingen/ })).toHaveCount(0);
  await expect(p.getByRole('button', { name: /Voorkeuren importeren/ })).toHaveCount(0);
  // The links of the period and revoking them are the beheerder's too (0.802.0).
  await expect(p.getByRole('heading', { name: 'Persoonlijke links' })).toHaveCount(0);
  const linksLijst = await p.request.get(`${getBaseUrl()}/api/aios/periode/${ids.period}/toegangslinks`);
  expect([401, 403]).toContain(linksLijst.status());
  const import_ = await p.request.post(`${getBaseUrl()}/api/aios/periode/${ids.period}/voorkeuren-import`, { data: { bestand: '', toepassen: false } });
  expect([401, 403]).toContain(import_.status());

  // Closing and opening, as the achterwacht's planner can; each change in the audit log.
  const status = p.getByTestId('aios-periode-status');
  await expect(status).toContainText('Status: Open');
  await status.getByRole('button', { name: /Periode sluiten/ }).click();
  await status.getByRole('button', { name: /Zeker weten/ }).click();
  await expect(status).toContainText('Status: Gesloten');
  await status.getByRole('button', { name: /Terug naar open/ }).click();
  await status.getByRole('button', { name: /Zeker weten/ }).click();
  await expect(status).toContainText('Status: Open');
  const acties = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dienstrooster_audit_log a JOIN dienstrooster_person pe ON pe.id = a.actor_id
       WHERE pe.codenaam = ? AND a.entiteit = 'period' AND a.entiteit_id = ?`
    )
    .get(planner, ids.period) as { n: number };
  expect(acties.n).toBe(2);
  await ctx.close();

  // The achterwacht's planner: not this period, not its routes.
  const ctx2 = await browser.newContext();
  const achterwacht = await ctx2.newPage();
  await loginAsPlanner(achterwacht);
  for (const pad of ['sluiten', 'heropenen']) {
    const res = await achterwacht.request.post(`${getBaseUrl()}/api/aios/periode/${ids.period}/${pad}`, { data: {} });
    expect([403, 404]).toContain(res.status());
  }
  const download = await achterwacht.request.get(`${getBaseUrl()}/api/aios/periode/${ids.period}/download-voorkeuren`);
  expect([403, 404]).toContain(download.status());
  expect((await download.text()).includes(TEKST_B)).toBe(false);
  await ctx2.close();
});

test('the dialogs of the AIOS period fit a phone: inside the screen, scrolling inside themselves, the page not sideways', async ({ browser }) => {
  // A small, narrow screen: the tallest content has to scroll in the dialog, never past the edge.
  const BREEDTE = 375;
  const HOOGTE = 480;
  const ctx = await browser.newContext({ viewport: { width: BREEDTE, height: HOOGTE } });
  const page = await ctx.newPage();
  try {
    await loginAsBeheerder(page);
    await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
    await openAiosSectie(page, 'Exporteren & communicatie');

    const binnenScherm = async (kaart: ReturnType<Page['locator']>) => {
      const box = (await kaart.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(BREEDTE);
      expect(box.y + box.height).toBeLessThanOrEqual(HOOGTE);
      // The dialog itself does not scroll sideways, and the page behind it does not either.
      expect(await kaart.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    };

    await page.getByRole('button', { name: /Uitnodigingen en herinneringen/ }).click();
    const exporteren = page.getByRole('dialog', { name: 'Exporteren' });
    await expect(exporteren).toBeVisible();
    await binnenScherm(exporteren.locator('> div'));
    // Whatever does not fit is reached by scrolling inside the dialog.
    const sluiten = exporteren.getByRole('button', { name: 'Sluiten' });
    await sluiten.scrollIntoViewIfNeeded();
    await expect(sluiten).toBeInViewport();
    await sluiten.click();
    await expect(exporteren).toHaveCount(0);

    await page.getByRole('button', { name: /Voorkeuren importeren \(test\)/ }).click();
    const importeren = page.getByRole('dialog', { name: 'Voorkeuren van de AIOS importeren' });
    await expect(importeren).toBeVisible();
    await binnenScherm(importeren.locator('> div'));
    const annuleren = importeren.getByRole('button', { name: 'Annuleren' });
    await annuleren.scrollIntoViewIfNeeded();
    await expect(annuleren).toBeInViewport();
    await annuleren.click();
    await expect(importeren).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('Persoonlijke links: the beheerder sees the links of the period, revokes one, and that link no longer logs in', async ({ page }) => {
  const [A, B] = ids.mensen;
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${ids.period}`);
  await openAiosSectie(page, 'Persoonlijke links');
  const sectie = page.getByTestId('toegangslinks');
  const rijA = sectie.getByTestId('toegangslink').filter({ hasText: A.codenaam });
  const rijB = sectie.getByTestId('toegangslink').filter({ hasText: B.codenaam });
  await expect(rijA).toContainText('Werkt');
  await expect(rijB).toContainText('Werkt');
  expect(await page.content()).not.toContain(ids.tokenA);

  await rijA.getByRole('button', { name: 'Intrekken' }).click();
  await expect(rijA.getByRole('alertdialog')).toContainText('Weet je zeker');
  await rijA.getByRole('button', { name: 'Ja, intrekken' }).click();
  await expect(sectie.getByRole('status')).toContainText(`De link van ${A.codenaam} is ingetrokken`);
  await expect(rijA).toContainText('Ingetrokken op');
  expect((await page.request.get(`${getBaseUrl()}/api/auth/verify-link?token=${ids.tokenA}`)).status()).toBe(401);
  expect((await page.request.get(`${getBaseUrl()}/api/auth/verify-link?token=${ids.tokenB}`)).status()).toBe(200);
  await expect(rijB).toContainText('Werkt');
});

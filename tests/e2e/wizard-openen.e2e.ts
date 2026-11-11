import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * Step 7 of "Periode instellen" opens the period on what it shows (1.6.0,
 * components/wizardControles.ts).
 *
 * The wizard read its data per step. A planner who came back later and went
 * straight to step 7 read "0 actief" with everyone active and could not
 * open; after a look at step 2 the period opened on the range the code
 * started with, 7 or 8 avonddiensten whatever the period, and everyone's
 * invitation promised that (audit per role, R-01).
 *
 * And the other way round (the planner's wish): with nobody active the
 * button is off and says why, and it comes on once someone is added after
 * all, or once the period is moved to dates the staff is there for. The
 * period then opens with them in it.
 *
 * A pool of its own: twenty members from 1 June 2096, the achterwacht's
 * kinds of shift, and one period per test.
 */

const tag = uuid().slice(0, 6);
const LEDEN = 20;
// Mondays, twelve weeks each.
const VOOR_DE_LEDEN_1 = { start: '2096-01-02', eind: '2096-03-25' };
const VOOR_DE_LEDEN_2 = { start: '2096-04-02', eind: '2096-05-27' };
const MET_DE_LEDEN = { start: '2096-07-02', eind: '2096-09-23' };
const LATER = { start: '2097-01-07', eind: '2097-03-31' };
let poolId = '';
let snapshot: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function periode(naam: string, vak: { start: string; eind: string }): string {
  const id = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, '2095-12-15T12:00', 'CONCEPT', datetime('now'))`
  ).run(id, poolId, `${naam} ${tag}`, vak.start, vak.eind);
  return id;
}

const opgeslagen = (id: string) =>
  db.prepare('SELECT status, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(id) as {
    status: string;
    start_datum: string;
    eind_datum: string;
    bevroren_ruleset_json: string | null;
  };

/** The streefbereik the server proposes for these dates, as step 3 asks for it. */
async function voorstel(page: Page, id: string, vak: { start: string; eind: string }) {
  const res = await page.request.get(
    `${getBaseUrl()}/api/periods/${id}/capacity?window_weeks=2&distribution_mode=GELIJK&start_datum=${vak.start}&eind_datum=${vak.eind}`
  );
  return (await res.json()).data.suggested_band as Record<'AVOND' | 'WEEKEND' | 'FEESTDAG', [number, number]>;
}

const openKnop = (page: Page) => page.getByRole('button', { name: 'Periode openen' });
const controles = (page: Page) => page.getByTestId('stap7-controles');

test.beforeAll(() => {
  snapshot = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const rulesetId = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'E2E-Wizard-openen', '{}', datetime('now'))`).run(rulesetId);
  poolId = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(poolId, `E2E-Openen-${tag}`, rulesetId);
  const achterwacht = db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'ACHTERWACHT' ORDER BY rowid LIMIT 1`).get() as { id: string };
  for (const t of db.prepare('SELECT naam, teller, start_tijd, eind_tijd FROM dienstrooster_shift_type WHERE pool_id = ?').all(achterwacht.id) as Array<{
    naam: string;
    teller: string;
    start_tijd: string | null;
    eind_tijd: string | null;
  }>) {
    db.prepare('INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller, start_tijd, eind_tijd) VALUES (?, ?, ?, ?, ?, ?)').run(
      uuid(),
      poolId,
      t.naam,
      t.teller,
      t.start_tijd,
      t.eind_tijd
    );
  }
  for (let i = 1; i <= LEDEN; i++) {
    const id = uuid();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(
      id,
      `Open-${String(i).padStart(2, '0')}-${tag}`
    );
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, '2096-06-01', '2099-12-31')`
    ).run(uuid(), id, poolId);
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

test('back in the wizard and straight to step 7: the staff, the streefbereik of this period, and it opens on that', async ({ page }) => {
  await loginAsPlanner(page);
  const id = periode('Later', LATER);
  const band = await voorstel(page, id, LATER);
  // The range the code started with was 7 or 8 avonddiensten: this period's own proposal is another.
  expect(band.AVOND).not.toEqual([7, 8]);

  await page.goto(`${getBaseUrl()}/planner/setup/${id}`);
  await page.getByRole('button', { name: '7. Bevestigen' }).click();

  await expect(controles(page)).toContainText('Klaar om te openen');
  await expect(controles(page)).toContainText(`Personeel: ${LEDEN} actief in deze periode`);
  await expect(controles(page)).toContainText('Streefbereik: het voorstel dat bij deze periode en dit aantal mensen past');
  await expect(page.getByText('Nog niemand actief')).toHaveCount(0);
  // In words, never "2-3" or "[2,3]".
  const regel = page.getByTestId('stap7-streefbereik');
  await expect(regel).toContainText(/Streefbereik per persoon: .*avonddienst.*weekenddienst.* en .*feestdagdienst/);
  await expect(regel).not.toContainText(/\d+\s*-\s*\d+|\[/);
  await expect(openKnop(page)).toBeEnabled();

  await openKnop(page).click();
  await expect.poll(() => opgeslagen(id).status).toBe('OPEN');
  const ruleset = JSON.parse(opgeslagen(id).bevroren_ruleset_json!);
  expect(ruleset.bandAvond).toEqual(band.AVOND);
  expect(ruleset.bandWeekend).toEqual(band.WEEKEND);
  expect(ruleset.bandFeestdag).toEqual(band.FEESTDAG);
});

test('nobody active: the button is off and says why; someone added after all turns it on and is in the period', async ({ page }) => {
  await loginAsPlanner(page);
  // The later of the two ranges before the members: whoever is added here from its start is not there yet in the other test's.
  const id = periode('Zonder leden', VOOR_DE_LEDEN_2);

  await page.goto(`${getBaseUrl()}/planner/setup/${id}`);
  await page.getByRole('button', { name: '7. Bevestigen' }).click();
  await expect(controles(page)).toContainText('Nog niet klaar om te openen');
  await expect(controles(page)).toContainText('Personeel: niemand actief in deze periode. Voeg iemand toe of zet iemand actief (stap 2)');
  await expect(openKnop(page)).toBeDisabled();

  // Added after all, in step 2: from the start of this period.
  const nieuw = `Erbij-${tag}`;
  await page.getByRole('button', { name: '2. Personeel' }).click();
  await page.locator('#nieuw-lid-codenaam').fill(nieuw);
  await page.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(page.getByRole('cell', { name: nieuw })).toBeVisible();

  await page.getByRole('button', { name: '7. Bevestigen' }).click();
  await expect(controles(page)).toContainText('Personeel: 1 actief in deze periode');
  await expect(controles(page)).toContainText('Klaar om te openen');
  await expect(openKnop(page)).toBeEnabled();

  await openKnop(page).click();
  await expect.poll(() => opgeslagen(id).status).toBe('OPEN');
  // In the period: the new member gets a personal link for it (the wizard makes the links right after opening).
  const links = () =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM dienstrooster_person_access_link l JOIN dienstrooster_person p ON p.id = l.person_id
           WHERE l.geldt_voor_periode_id = ? AND p.codenaam = ?`
        )
        .get(id, nieuw) as { n: number }
    ).n;
  await expect.poll(links, { timeout: 15000 }).toBe(1);
});

test('nobody active: the period moved to dates the staff is there for turns the button on, and it opens on those dates', async ({ page }) => {
  await loginAsPlanner(page);
  const id = periode('Verschoven', VOOR_DE_LEDEN_1);

  await page.goto(`${getBaseUrl()}/planner/setup/${id}`);
  await page.getByRole('button', { name: '7. Bevestigen' }).click();
  await expect(controles(page)).toContainText('niemand actief in deze periode');
  await expect(controles(page)).toContainText('Of pas de datums van de periode aan (stap 1)');
  await expect(openKnop(page)).toBeDisabled();

  // The period adjusted in step 1, then straight back to step 7.
  await page.getByRole('button', { name: '1. Periode' }).click();
  await page.getByLabel('Startdatum').fill('02-07-2096');
  await page.getByLabel('Einddatum').fill('23-09-2096');
  await page.getByRole('button', { name: '7. Bevestigen' }).click();

  // The twenty, and whoever another test added to this pool with an open end.
  const actief = (
    db
      .prepare(`SELECT COUNT(DISTINCT person_id) AS n FROM dienstrooster_pool_membership WHERE pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`)
      .get(poolId, MET_DE_LEDEN.eind, MET_DE_LEDEN.start) as { n: number }
  ).n;
  expect(actief).toBeGreaterThanOrEqual(LEDEN);
  await expect(controles(page)).toContainText(`Personeel: ${actief} actief in deze periode`);
  await expect(controles(page)).toContainText('Klaar om te openen');
  await expect(openKnop(page)).toBeEnabled();

  await openKnop(page).click();
  await expect.poll(() => opgeslagen(id).status).toBe('OPEN');
  const nu = opgeslagen(id);
  expect([nu.start_datum, nu.eind_datum]).toEqual([MET_DE_LEDEN.start, MET_DE_LEDEN.eind]);
  // On the proposal of the new dates, not of the dates the wizard opened with.
  expect(JSON.parse(nu.bevroren_ruleset_json!).bandAvond).toEqual((await voorstel(page, id, MET_DE_LEDEN)).AVOND);
  // Everyone active on the new dates is in it: each gets a personal link (made right after opening).
  const uitgenodigd = () =>
    (db.prepare('SELECT COUNT(DISTINCT person_id) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').get(id) as { n: number }).n;
  await expect.poll(uitgenodigd, { timeout: 30000 }).toBe(actief);
});

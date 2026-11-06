import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * Stap 2 "Personeel" of the setup wizard keeps what the planner set (1.1.3).
 *
 * The planner's report: "bij het instellen van een nieuwe periode ben ik de
 * begin- en einddata van stafleden aan het aanpassen, maar die data worden
 * niet opgeslagen". Loading the step widened every membership that did not
 * cover the whole period, at every new page load: a Geldig tot inside the
 * period and an unticked "Actief" were undone the next time the wizard
 * opened, someone who had left was taken in again and an open end was cut to
 * the period's end. A change that reaches a period with a roster was refused
 * (409, it needs a yes) with the refusal above the list, out of sight, and no
 * way to say yes.
 *
 * A pool of its own: 34 members with an open end, one who left when the
 * published period ended, the published period and the new one after it.
 */

const tag = uuid().slice(0, 6);
const persons: string[] = [];
let poolId = '';
let rulesetId = '';
let gepubliceerdId = '';
let nieuwId = '';
const lid = (i: number) => `Wiz-${String(i).padStart(2, '0')}-${tag}`;
const WEG = `Wiz-weg-${tag}`;

function persoon(codenaam: string, vanaf: string, tot: string): void {
  const id = uuid();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(id, codenaam);
  persons.push(id);
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, ?, ?)`
  ).run(uuid(), id, poolId, vanaf, tot);
}

function periode(naam: string, start: string, eind: string, status: string): string {
  const id = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(id, poolId, naam, start, eind, '2097-12-15T12:00', status);
  return id;
}

const lidmaatschap = (codenaam: string) =>
  db
    .prepare(
      `SELECT pm.geldig_vanaf, pm.geldig_tot FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id WHERE p.codenaam = ? AND pm.pool_id = ?`
    )
    .get(codenaam, poolId) as { geldig_vanaf: string; geldig_tot: string };

test.beforeAll(() => {
  rulesetId = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'E2E-Wizard-personeel', '{}', datetime('now'))`).run(rulesetId);
  poolId = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(poolId, `E2E-Wizard-${tag}`, rulesetId);
  for (let i = 1; i <= 34; i++) persoon(lid(i), '2098-01-05', '2099-12-31');
  // Left when the published period ended: not part of the new one.
  persoon(WEG, '2098-01-05', '2098-02-01');
  gepubliceerdId = periode(`E2E gepubliceerd ${tag}`, '2098-01-05', '2098-02-01', 'GEPUBLICEERD');
  nieuwId = periode(`E2E nieuw ${tag}`, '2098-02-02', '2098-03-01', 'CONCEPT');
});

test.afterAll(() => {
  db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
  for (const id of persons) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  for (const id of [gepubliceerdId, nieuwId]) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
  db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(rulesetId);
});

/** A new page load of the wizard, then step 2: what the planner does when coming back to it. */
async function openPersoneel(page: Page) {
  await page.goto(`${getBaseUrl()}/planner/setup/${nieuwId}`);
  await page.getByRole('button', { name: '2. Personeel' }).click();
  await expect(page.getByText(lid(34), { exact: true })).toBeVisible();
}

const rij = (page: Page, codenaam: string) => page.locator('tr', { has: page.getByText(codenaam, { exact: true }) }).first();

test('what the planner changes in stap 2 stays when the wizard is opened again', async ({ page }) => {
  await loginAsPlanner(page);
  await openPersoneel(page);

  // Someone who leaves halfway the new period.
  await rij(page, lid(3)).getByRole('button', { name: 'Bewerken' }).click();
  await page.getByLabel(`Geldig tot van ${lid(3)}`).fill('2098-02-15');
  await rij(page, lid(3)).getByRole('button', { name: 'Opslaan' }).click();
  await expect(rij(page, lid(3))).toContainText('2098-02-15');

  // Someone who does not take part this time.
  await rij(page, lid(4)).getByRole('checkbox').click();
  await expect(rij(page, lid(4))).toContainText('Niet actief');

  // Coming back to the wizard later: nothing is undone.
  await openPersoneel(page);
  await expect(rij(page, lid(3))).toContainText('2098-02-15');
  await expect(rij(page, lid(4))).toContainText('Niet actief');
  await expect(rij(page, WEG)).toContainText('Niet actief');
  expect(lidmaatschap(lid(3))).toEqual({ geldig_vanaf: '2098-01-05', geldig_tot: '2098-02-15' });
  expect(lidmaatschap(lid(4))).toEqual({ geldig_vanaf: '2098-01-05', geldig_tot: '2098-02-01' });
  // Untouched: the open end is not cut to the period's end, and who left is not taken in again.
  expect(lidmaatschap(lid(5))).toEqual({ geldig_vanaf: '2098-01-05', geldig_tot: '2099-12-31' });
  expect(lidmaatschap(WEG)).toEqual({ geldig_vanaf: '2098-01-05', geldig_tot: '2098-02-01' });
  await expect(page.getByTestId('niet-actief-uitleg')).toContainText('2 mensen doen niet mee in deze periode');
});

test('a change that reaches a period with a roster is asked in the row, and saved after Toch doorgaan', async ({ page }) => {
  await loginAsPlanner(page);
  await openPersoneel(page);

  // A later start takes days out of the published period: that needs a yes.
  await rij(page, lid(31)).getByRole('button', { name: 'Bewerken' }).click();
  await page.getByLabel(`Geldig vanaf van ${lid(31)}`).fill('2098-02-09');
  await rij(page, lid(31)).getByRole('button', { name: 'Opslaan' }).click();

  const vraag = page.getByTestId('rooster-bevestiging');
  await expect(vraag).toContainText('Dit raakt een periode met een rooster');
  await expect(vraag).toContainText(`E2E gepubliceerd ${tag}`);
  // In sight under the row, not above a list of 35 people.
  await expect(vraag).toBeInViewport();
  expect(lidmaatschap(lid(31)).geldig_vanaf).toBe('2098-01-05');

  await vraag.getByRole('button', { name: 'Toch doorgaan' }).click();
  await expect(rij(page, lid(31))).toContainText('2098-02-09');
  expect(lidmaatschap(lid(31))).toEqual({ geldig_vanaf: '2098-02-09', geldig_tot: '2099-12-31' });
  await expect(page.getByTestId('rooster-bevestiging')).toHaveCount(0);
});

test('a member added in the wizard gets the open end', async ({ page }) => {
  await loginAsPlanner(page);
  await openPersoneel(page);
  const nieuw = `Wiz-nieuw-${tag}`;
  const formulier = page.locator('div', { has: page.getByText('Nieuw personeelslid toevoegen', { exact: true }) }).last();
  await formulier.locator('input[type="text"]').fill(nieuw);
  const datums = formulier.locator('input[type="date"]');
  await expect(datums.nth(0)).toHaveValue('2098-02-02');
  await expect(datums.nth(1)).toHaveValue('2099-12-31');
  await formulier.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(rij(page, nieuw)).toContainText('2099-12-31');
  const id = (db.prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?').get(nieuw) as { id: string }).id;
  persons.push(id);
  expect(lidmaatschap(nieuw)).toEqual({ geldig_vanaf: '2098-02-02', geldig_tot: '2099-12-31' });
});

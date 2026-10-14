import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * A mistake on Personeel beheren is told where it was made: under
 * Toevoegen for a new member, under the row for a change or a removal.
 *
 * Every error showed above the list, and under a list of 30 or 40 people
 * that is out of sight: the planner pressed Toevoegen, saw nothing happen
 * and had to scroll up to find "Deze persoon heeft in deze pool al een
 * lidmaatschap dat deze periode overlapt" (the planner's report).
 *
 * A pool of its own with 40 members, so the list is as long as a ward's.
 */

const OVERLAP = 'Deze persoon heeft in deze pool al een lidmaatschap dat deze periode overlapt';
const tag = uuid().slice(0, 6);
const persons: string[] = [];
let poolId = '';
let rulesetId = '';

function person(codenaam: string, memberships: Array<[string, string]>): void {
  const id = uuid();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`).run(id, codenaam);
  persons.push(id);
  for (const [vanaf, tot] of memberships) {
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, ?, ?)`
    ).run(uuid(), id, poolId, vanaf, tot);
  }
}

test.beforeAll(() => {
  rulesetId = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'E2E-Fouten', '{}', datetime('now'))`).run(rulesetId);
  poolId = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(poolId, `E2E-Fouten-${tag}`, rulesetId);
  for (let i = 1; i <= 38; i++) person(`Lid-${String(i).padStart(2, '0')}-${tag}`, [['2099-01-05', '2099-08-30']]);
  person(`Dubbel-${tag}`, [['2099-03-02', '2099-08-30']]);
  // Last in the list (sorted by codenaam): two memberships, one after the other.
  person(`Zz-Twee-${tag}`, [
    ['2099-01-05', '2099-02-28'],
    ['2099-03-02', '2099-08-30'],
  ]);
});

test.afterAll(() => {
  db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
  for (const id of persons) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
  db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(rulesetId);
});

async function openStaff(page: Page) {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/pool/${poolId}/staff`);
  await expect(page.getByText(`Zz-Twee-${tag}`).first()).toBeVisible();
}

test('adding someone twice says so under Toevoegen, in sight', async ({ page }) => {
  await openStaff(page);
  const form = page.locator('div', { has: page.getByText('Nieuw personeelslid toevoegen') }).last();
  await form.getByPlaceholder('bijv. Persoon-32').fill(`Dubbel-${tag}`);
  const dates = form.locator('input[type="date"]');
  await dates.nth(0).fill('2099-04-01');
  await dates.nth(1).fill('2099-05-01');
  await form.getByRole('button', { name: 'Toevoegen' }).click();

  const fout = page.getByTestId('toevoegen-fout');
  await expect(fout).toHaveText(OVERLAP);
  await expect(fout).toBeInViewport();
  // Right below the button, in the same part of the page, and nowhere else.
  await expect(form.getByTestId('toevoegen-fout')).toHaveCount(1);
  await expect(page.getByTestId('rij-fout')).toHaveCount(0);
});

test('a change that overlaps says so under its own row, in sight', async ({ page }) => {
  await openStaff(page);
  const row = page.locator('tr', { hasText: `Zz-Twee-${tag}` }).filter({ hasText: '2099-02-28' });
  await row.getByRole('button', { name: 'Bewerken' }).click();
  const editing = page.locator('tr', { hasText: `Zz-Twee-${tag}` }).filter({ has: page.locator('input[type="date"]') });
  await editing.locator('input[type="date"]').nth(1).fill('2099-05-01');
  await editing.getByRole('button', { name: 'Opslaan' }).click();

  const fout = page.getByTestId('rij-fout');
  await expect(fout).toHaveText(OVERLAP);
  await expect(fout).toBeInViewport();
  // The row right above the message is the one being changed.
  await expect(page.locator('tr', { has: fout }).locator('xpath=preceding-sibling::tr[1]')).toContainText(`Zz-Twee-${tag}`);
  await expect(page.getByTestId('rij-fout')).toHaveCount(1);
  await expect(page.getByTestId('toevoegen-fout')).toHaveCount(0);

  // Cancelling the change takes the message with it.
  await editing.getByRole('button', { name: 'Annuleren' }).click();
  await expect(page.getByTestId('rij-fout')).toHaveCount(0);
});

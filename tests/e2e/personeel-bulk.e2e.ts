import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * Personeel beheren, several at once (0.901.0), the whole way through the
 * browser: a reeks aios01 tot en met aios05 with one skipped, and new Geldig
 * tot for a selection. A pool of its own, so other test files' periods and
 * members don't decide the outcome.
 */

const tag = uuid().slice(0, 4);
const pools: string[] = [];
const rulesets: string[] = [];

function pool(): string {
  const ruleset = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'E2E-bulk', '{}', datetime('now'))`).run(ruleset);
  rulesets.push(ruleset);
  const id = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(id, `E2E-bulk-${id.slice(0, 6)}`, ruleset);
  pools.push(id);
  return id;
}

const leden = (poolId: string) =>
  db
    .prepare(
      `SELECT p.codenaam, pm.geldig_vanaf, pm.geldig_tot FROM dienstrooster_pool_membership pm JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? ORDER BY p.codenaam`
    )
    .all(poolId) as Array<{ codenaam: string; geldig_vanaf: string; geldig_tot: string }>;

test.afterAll(() => {
  for (const id of pools) {
    const mensen = db.prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?').all(id) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(id);
    for (const { person_id } of mensen) {
      db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit = ? AND nieuw_json LIKE ?').run('pool_membership', `%${person_id}%`);
      db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(person_id);
    }
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  }
  for (const id of rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
});

test('a reeks adds everyone but who is there already, and a selection gets one new Geldig tot', async ({ page }) => {
  const id = pool();
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/pool/${id}/staff`);
  await expect(page.getByText('Nieuw personeelslid toevoegen')).toBeVisible();

  // One added by hand first: the reeks skips it.
  await page.getByLabel('Codenaam', { exact: true }).fill(`b${tag}03`);
  await page.getByRole('button', { name: 'Toevoegen', exact: true }).click();
  await expect(page.getByRole('cell', { name: `b${tag}03`, exact: true })).toBeVisible();

  const reeks = page.getByTestId('reeks');
  await reeks.getByLabel('Van codenaam').fill(`b${tag}01`);
  await reeks.getByLabel('Tot en met codenaam').fill(`b${tag}05`);
  await expect(reeks.getByTestId('reeks-voorbeeld')).toContainText(`5 codenamen: b${tag}01, b${tag}02 … b${tag}04, b${tag}05`);
  await reeks.getByRole('button', { name: 'Voeg de reeks toe' }).click();
  const uitkomst = reeks.getByTestId('reeks-uitkomst');
  await expect(uitkomst).toContainText('4 personen toegevoegd.');
  await expect(uitkomst).toContainText(`b${tag}03: Deze persoon heeft in deze pool al een lidmaatschap dat deze periode overlapt`);
  expect(leden(id).map((l) => [l.codenaam, l.geldig_tot])).toEqual(['01', '02', '03', '04', '05'].map((n) => [`b${tag}${n}`, '2099-12-31']));

  // A backwards reeks says so before anything is sent.
  await reeks.getByLabel('Van codenaam').fill(`b${tag}09`);
  await reeks.getByLabel('Tot en met codenaam').fill(`b${tag}06`);
  await expect(reeks.getByTestId('reeks-voorbeeld')).toHaveText('Het tweede nummer is lager dan het eerste. Draai ze om.');
  await expect(reeks.getByRole('button', { name: 'Voeg de reeks toe' })).toBeDisabled();

  // Everyone selected, then two taken off again: the other three get the new Geldig tot.
  await page.getByLabel('Iedereen selecteren').check();
  await page.getByLabel(`b${tag}01 selecteren`).uncheck();
  await page.getByLabel(`b${tag}05 selecteren`).uncheck();
  const balk = page.getByTestId('selectie-balk');
  await expect(balk).toContainText('3 personen geselecteerd');
  await balk.getByLabel('Nieuwe Geldig tot').fill('2027-12-31');
  await balk.getByRole('button', { name: 'Toepassen op selectie' }).click();
  await expect(page.getByRole('status').filter({ hasText: '3 lidmaatschappen gewijzigd.' })).toBeVisible();
  expect(leden(id).map((l) => l.geldig_tot)).toEqual(['2099-12-31', '2027-12-31', '2027-12-31', '2027-12-31', '2099-12-31']);
  await expect(page.getByTestId('selectie-balk')).toHaveCount(0);
});

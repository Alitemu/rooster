import { test, expect, type Page } from '@playwright/test';
import { db } from '@/db/client';
import { getBaseUrl, loginAsBeheerder } from './setup';

/**
 * The beheerder deletes an account (1.10.0, the beheerder's wish): one made to try something could only
 * be switched off and stayed in the list for good. Only an account that has left no trace in a roster
 * or its history: for any other the page offers no Verwijderen, and says why. The rules are in
 * app/api/admin/accounts/route.test.ts.
 */
const naam = (soort: string) => `E2E-${soort}-${Date.now().toString(36)}`;
const gemaakt: string[] = [];

/** As the beheerder does it: a name, a temporary password the page makes, Toevoegen. */
async function voegToe(page: Page, codenaam: string) {
  gemaakt.push(codenaam);
  await page.getByLabel('Codenaam').fill(codenaam);
  await page.getByRole('button', { name: 'Maak er een' }).click();
  await page.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(page.getByRole('row', { name: new RegExp(codenaam) })).toBeVisible();
}

test.afterAll(() => {
  for (const codenaam of gemaakt) {
    const p = db.prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?').get(codenaam) as { id: string } | undefined;
    if (!p) continue;
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE gewijzigd_door = ?').run(p.id);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ? OR entiteit_id = ?').run(p.id, p.id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(p.id);
  }
});

test('an account made to try something is deleted, after a question', async ({ page }) => {
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/accounts`);
  const proef = naam('proef');
  await voegToe(page, proef);
  const rij = page.getByRole('row', { name: new RegExp(proef) });

  // The first click asks, and Annuleren leaves the account.
  await rij.getByRole('button', { name: 'Verwijderen' }).click();
  await expect(rij.getByRole('alert')).toContainText(`${proef} verwijderen? Dit kan niet ongedaan worden gemaakt.`);
  await rij.getByRole('button', { name: 'Annuleren' }).click();
  await expect(rij).toBeVisible();
  expect(db.prepare('SELECT 1 FROM dienstrooster_person WHERE codenaam = ?').get(proef)).toBeTruthy();

  await rij.getByRole('button', { name: 'Verwijderen' }).click();
  await rij.getByRole('button', { name: 'Ja, verwijderen' }).click();
  await expect(page.getByText(`${proef} is verwijderd.`)).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(proef) })).toHaveCount(0);
  expect(db.prepare('SELECT 1 FROM dienstrooster_person WHERE codenaam = ?').get(proef)).toBeUndefined();

  // The name is free again.
  await voegToe(page, proef);
});

test('an account the history names has no Verwijderen, and the page says why', async ({ page }) => {
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/accounts`);
  const gebruikt = naam('gebruikt');
  await voegToe(page, gebruikt);
  await expect(page.getByRole('row', { name: new RegExp(gebruikt) }).getByRole('button', { name: 'Verwijderen' })).toBeVisible();

  // It changes a setting: from then on the history names it.
  const p = db.prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?').get(gebruikt) as { id: string };
  db.prepare(`INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door) VALUES (?, 'x', datetime('now'), ?)`).run(`e2e-${p.id}`, p.id);
  await page.reload();
  const rij = page.getByRole('row', { name: new RegExp(gebruikt) });
  await expect(rij.getByRole('button', { name: 'Uitschakelen' })).toBeVisible();
  await expect(rij.getByRole('button', { name: 'Verwijderen' })).toHaveCount(0);
  await expect(page.getByTestId('uitleg-verwijderen')).toContainText('Verwijderen kan alleen bij een account dat nog niets in een rooster of in de instellingen heeft gewijzigd.');

  // A request that skips the page is refused, in Dutch.
  const res = await page.request.delete(`${getBaseUrl()}/api/admin/accounts/${p.id}`);
  expect(res.status()).toBe(409);
  expect((await res.json()).error.message).toContain('Schakel het uit.');
});

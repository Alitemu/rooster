import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { getBaseUrl, loginAsBeheerder } from './setup';

/**
 * Accounts beheren leaves switched-off accounts out until the beheerder asks for them (1.11.0, the
 * beheerder's wish): an account the history names can't be deleted, so the list only grew. The rules
 * are in app/planner/accounts/zichtbareAccounts.test.ts.
 */
const codenaam = `E2E-uit-${Date.now().toString(36)}`;

test.afterAll(() => {
  const p = db.prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?').get(codenaam) as { id: string } | undefined;
  if (!p) return;
  db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ? OR entiteit_id = ?').run(p.id, p.id);
  db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(p.id);
});

test('a switched-off account leaves the list, and comes back with Toon uitgeschakelde accounts', async ({ page }) => {
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/accounts`);
  await page.getByLabel('Codenaam').fill(codenaam);
  await page.getByRole('button', { name: 'Maak er een' }).click();
  await page.getByRole('button', { name: 'Toevoegen' }).click();
  const rij = page.getByRole('row', { name: new RegExp(codenaam) });
  await expect(rij).toBeVisible();

  // Switched off: the row is gone, and the page says where it went.
  await rij.getByRole('button', { name: 'Uitschakelen' }).click();
  await expect(page.getByRole('status')).toContainText(
    `${codenaam} is uitgeschakeld en kan niet meer inloggen. Het account staat nu bij de uitgeschakelde accounts.`
  );
  await expect(rij).toHaveCount(0);
  const vinkje = page.getByTestId('toon-uitgeschakeld');
  await expect(vinkje).not.toBeChecked();
  const uit = (db.prepare(`SELECT COUNT(*) n FROM dienstrooster_person WHERE rol IN ('ADMIN', 'PLANNER') AND actief = 0`).get() as { n: number }).n;
  await expect(page.getByText(`Toon uitgeschakelde accounts (${uit})`)).toBeVisible();

  // Asked for: there it is, with Inschakelen.
  await vinkje.check();
  await expect(rij).toBeVisible();
  await expect(rij).toContainText('Uitgeschakeld');
  await expect(rij.getByRole('button', { name: 'Inschakelen' })).toBeVisible();

  // Opened again the page is tidy: the choice is not remembered.
  await page.reload();
  await expect(page.getByTestId('toon-uitgeschakeld')).not.toBeChecked();
  await expect(rij).toHaveCount(0);
  // Every account in use is still there.
  await expect(page.getByRole('row', { name: /\(jij\)/ })).toBeVisible();

  // Switched on again it is back in the list without the switch.
  await page.getByTestId('toon-uitgeschakeld').check();
  await rij.getByRole('button', { name: 'Inschakelen' }).click();
  await expect(page.getByRole('status')).toContainText(`${codenaam} kan weer inloggen.`);
  await page.reload();
  await expect(rij).toBeVisible();
  await expect(rij.getByRole('button', { name: 'Uitschakelen' })).toBeVisible();
});

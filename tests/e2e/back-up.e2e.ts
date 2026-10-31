import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from '@/db/client';
import { maakBackupBestand } from '../../lib/dbBackupBestand';
import { getBaseUrl, loginAsBeheerder, loginAsPlanner } from './setup';

/**
 * "Back-up" on the period list, the whole way through the browser: the
 * beheerder picks a backup file, types its password and the word, and the
 * running app's database becomes the one in the file.
 *
 * The file is made larger than 10 MB on purpose: Next buffers the body of
 * every /api request for proxy.ts and quietly cuts it off past
 * proxyClientMaxBodySize (10 MB unless next.config.js says otherwise). Cut
 * off, the restore would only say "Kies eerst een back-upbestand."
 *
 * The backup is made from the database as it is at the start of the test,
 * so restoring it changes nothing else for the tests that follow.
 */

const WACHTWOORD = 'e2e back-up wachtwoord';
const APP_VERSIE = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
const markerWaarde = (sleutel: string) =>
  (db.prepare('SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = ?').get(sleutel) as { waarde: string } | undefined)?.waarde;

function backupVanNu(opvullen: boolean): Buffer {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-backup-'));
  try {
    const pad = path.join(map, 'kopie.db');
    db.prepare('VACUUM INTO ?').run(pad);
    if (opvullen) {
      // Random bytes do not compress: 12 MB in the file, 16 MB as base64 in the request.
      const kopie = new Database(pad);
      kopie.exec('CREATE TABLE e2e_opvulling (blok BLOB)');
      const zet = kopie.prepare('INSERT INTO e2e_opvulling (blok) VALUES (?)');
      for (let i = 0; i < 12; i++) zet.run(crypto.randomBytes(1024 * 1024));
      kopie.close();
    }
    return maakBackupBestand(fs.readFileSync(pad), WACHTWOORD, { app_versie: APP_VERSIE, gemaakt_op: new Date().toISOString() });
  } finally {
    fs.rmSync(map, { recursive: true, force: true });
  }
}

async function openBackup(page: import('@playwright/test').Page) {
  await page.goto(`${getBaseUrl()}/planner`);
  await page.getByRole('button', { name: 'Back-up', exact: true }).click();
  return page.getByRole('dialog', { name: 'Back-up' });
}

test('a planner has no Back-up button', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner`);
  await expect(page.getByRole('heading', { name: 'Periodes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back-up', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('backup-waarschuwing')).toHaveCount(0);
});

test('the beheerder restores a backup of more than 10 MB in the browser, and a wrong password changes nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const sleutel = `e2e.backup.${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op) VALUES (?, 'in-de-backup', ?)`).run(sleutel, new Date().toISOString());
  const bestand = backupVanNu(true);
  expect(bestand.length).toBeGreaterThan(10 * 1024 * 1024);
  // After the backup: gone once it is restored.
  const later = `${sleutel}.later`;
  db.prepare(`INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op) VALUES (?, 'na-de-backup', ?)`).run(later, new Date().toISOString());

  try {
    await loginAsBeheerder(page);
    const dialoog = await openBackup(page);
    await expect(dialoog.getByRole('heading', { name: 'Back-up terugzetten' })).toBeVisible();
    await dialoog.getByLabel('Back-upbestand (.drbackup)').setInputFiles({ name: 'dienstrooster-backup.drbackup', mimeType: 'application/octet-stream', buffer: bestand });

    // The button waits for the typed word.
    const knop = dialoog.getByRole('button', { name: 'Back-up terugzetten' });
    await dialoog.getByLabel('Back-upwachtwoord van dat bestand').fill('niet het goede wachtwoord');
    await expect(knop).toBeDisabled();
    await dialoog.getByLabel('Typ TERUGZETTEN om te bevestigen').fill('TERUGZETTEN');
    await knop.click();
    await expect(dialoog.getByRole('alert')).toHaveText('Het wachtwoord klopt niet of het bestand is beschadigd. Let op hoofdletters en kleine letters.');
    expect(markerWaarde(later)).toBe('na-de-backup');

    // 0.904.0: what was typed can be shown, and a field the browser could fill starts empty.
    const veld = dialoog.getByLabel('Back-upwachtwoord van dat bestand');
    await expect(veld).toHaveAttribute('type', 'password');
    await expect(veld).toHaveAttribute('autocomplete', 'new-password');
    await dialoog.getByRole('button', { name: 'Toon wachtwoord' }).nth(1).click();
    await expect(veld).toHaveAttribute('type', 'text');
    await expect(veld).toHaveValue('niet het goede wachtwoord');
    await dialoog.getByRole('button', { name: 'Verberg wachtwoord' }).click();
    await expect(veld).toHaveAttribute('type', 'password');
    // Caps Lock on: said beside the field. Headless Chromium does not toggle it on a key press, so the key event
    // carries it as a real keyboard's does.
    await veld.dispatchEvent('keydown', { key: 'A', modifierCapsLock: true });
    await expect(dialoog.getByText('Caps Lock staat aan. Let op hoofdletters en kleine letters.')).toBeVisible();
    await veld.dispatchEvent('keydown', { key: 'a', modifierCapsLock: false });
    await expect(dialoog.getByText('Caps Lock staat aan. Let op hoofdletters en kleine letters.')).toHaveCount(0);

    // Something in front of the app refuses the size with an empty 413 (an old docker-compose.yml): said so, not
    // "Dat is niet gelukt.".
    await page.route('**/api/admin/back-up/terugzetten', (route) => route.fulfill({ status: 413, body: '' }));
    await knop.click();
    await expect(dialoog.getByRole('alert')).toHaveText(
      'De server weigert dit bestand, omdat het te groot is. Neem het nieuwe docker-compose.yml over (README, bij versie 0.904.0) en probeer het opnieuw.'
    );
    await page.unroute('**/api/admin/back-up/terugzetten');

    await dialoog.getByLabel('Back-upwachtwoord van dat bestand').fill(WACHTWOORD);
    await knop.click();
    await expect(dialoog.getByRole('status')).toContainText('is teruggezet.', { timeout: 60_000 });
    expect(markerWaarde(sleutel)).toBe('in-de-backup');
    expect(markerWaarde(later)).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM e2e_opvulling`).get()).toEqual({ n: 12 });

    // The app still works on the restored database: reload, still logged in, the period list is there.
    await dialoog.getByRole('button', { name: 'Pagina opnieuw laden' }).click();
    await expect(page.getByRole('heading', { name: 'Periodes' })).toBeVisible();
  } finally {
    db.exec('DROP TABLE IF EXISTS e2e_opvulling');
    db.prepare('DELETE FROM dienstrooster_app_setting WHERE sleutel IN (?, ?)').run(sleutel, later);
  }
});

test('the beheerder sets up the backup and sees how it stands', async ({ page }) => {
  await loginAsBeheerder(page);
  // 0.905.0: not set up is said above the period list, not only in the dialog, and the button opens it.
  db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel IN ('backup.aan', 'backup.wachtwoord')`).run();
  await page.goto(`${getBaseUrl()}/planner`);
  const waarschuwing = page.getByTestId('backup-waarschuwing');
  await expect(waarschuwing).toContainText('Back-up: Er gaan nog geen back-ups buiten de server.');
  await waarschuwing.getByRole('button', { name: 'Back-up openen' }).click();
  const dialoog = page.getByRole('dialog', { name: 'Back-up' });
  try {
    await dialoog.getByLabel('Back-up sturen naar').fill('beheerder@example.test');
    await dialoog.getByLabel('Back-upwachtwoord', { exact: true }).fill('te kort');
    await expect(dialoog.getByText('Minstens 12 tekens.')).toBeVisible();
    await expect(dialoog.getByRole('button', { name: 'Opslaan' })).toBeDisabled();
    await dialoog.getByLabel('Back-upwachtwoord', { exact: true }).fill(WACHTWOORD);
    await dialoog.getByRole('button', { name: 'Opslaan' }).click();
    await expect(dialoog.getByText('Opgeslagen. Vanaf nu gaat er elke nacht een back-up uit als er iets veranderd is.')).toBeVisible();
    await expect(dialoog.getByLabel('Back-upwachtwoord', { exact: true })).toHaveAttribute('placeholder', 'Opgeslagen. Laat leeg om het te houden.');
    await expect(dialoog.getByRole('button', { name: 'Nu een back-up versturen' })).toBeVisible();
    // Set up now: closing the dialog reads the state again, and "not set up" is gone.
    await dialoog.getByRole('button', { name: 'Sluiten' }).click();
    await expect(page.getByText('Er gaan nog geen back-ups buiten de server.')).toHaveCount(0);
  } finally {
    db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel IN ('backup.aan', 'backup.wachtwoord')`).run();
  }
});

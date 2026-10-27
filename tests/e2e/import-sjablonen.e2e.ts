import { test, expect } from '@playwright/test';
import { db } from '@/db/client';
import { buildXlsx } from '../fixtures/buildXlsx';
import { SALDO_KOP, EERDERE_KOP } from '@/lib/importSjablonen';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * The achterwacht's two imports of old data take a workbook only, in the
 * layout of a sjabloon that can be downloaded next to the file field: a CSV
 * and a workbook with other columns are refused in Dutch, before a row is
 * read (lib/importSjablonen.ts, lib/sheetUpload.ts).
 */

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let periodId = '';

test.afterAll(() => {
  if (!periodId) return;
  db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
});

test.beforeEach(async ({ page }) => {
  await loginAsPlanner(page);
  if (periodId) return;
  const pool = db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'ACHTERWACHT' ORDER BY rowid LIMIT 1`).get() as { id: string };
  const created = await page.request.post(`${getBaseUrl()}/api/planner/periods`, {
    data: { naam: `Sjablonen ${Date.now()}`, pool_id: pool.id, start_datum: '2033-01-03', eind_datum: '2033-03-27', deadline: '2032-12-15T12:00' },
  });
  periodId = (await created.json()).data.id;
});

const xlsxBestand = (rows: Array<Array<string | number | null>>, naam = 'bestand.xlsx') => ({ name: naam, mimeType: XLSX, buffer: buildXlsx(rows) });

test('beginsaldo: the sjabloon is there, a CSV and a wrong layout are refused, the sjabloon\'s layout previews', async ({ page }) => {
  await page.goto(`${getBaseUrl()}/planner/setup/${periodId}`);
  await page.getByRole('button', { name: '5. Saldi' }).click();
  await expect(page.getByRole('heading', { name: 'Beginsaldi importeren' })).toBeVisible();

  // The sjabloon: a workbook with the header and a row per person.
  const link = page.getByRole('link', { name: 'Sjabloon downloaden (Excel)' });
  await expect(link).toBeVisible();
  // The href already holds the app's sub-folder, if there is one.
  const download = await page.request.get(new URL((await link.getAttribute('href'))!, getBaseUrl()).toString());
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toBe(XLSX);

  const kies = page.getByLabel('Beginsaldo als Excel-bestand');
  // A CSV is refused.
  await kies.setInputFiles({ name: 'saldo.csv', mimeType: 'text/csv', buffer: Buffer.from('codenaam,AVOND_delta,WEEKEND_delta\nPersoon-01,-1,0') });
  await expect(page.getByText('Alleen Excel-bestanden (.xlsx) kunnen worden ingelezen')).toBeVisible();
  await expect(page.getByText(/records klaar om te importeren/)).toHaveCount(0);

  // A workbook with other columns is refused, naming the right ones.
  await kies.setInputFiles(xlsxBestand([['codenaam', 'AVOND_delta', 'WEEKEND_delta'], ['Persoon-01', -1, 0]]));
  await expect(page.getByText(/niet de kolommen van het sjabloon \(Codenaam, Avonddiensten \(saldo\), Weekenddiensten \(saldo\)\)/)).toBeVisible();
  await expect(page.getByText(/records klaar om te importeren/)).toHaveCount(0);

  // The sjabloon's layout goes through.
  await kies.setInputFiles(xlsxBestand([[...SALDO_KOP], ['Persoon-01', -1, 0], ['Persoon-02', null, 2]]));
  await expect(page.getByText('2 records klaar om te importeren')).toBeVisible();
  await expect(page.getByText(/niet de kolommen/)).toHaveCount(0);
});

test('beginsaldo: a saldo that is there already is said first, and only replaced after a yes', async ({ page }) => {
  const lid = db
    .prepare(
      `SELECT p.codenaam FROM dienstrooster_person p JOIN dienstrooster_pool_membership pm ON pm.person_id = p.id
       JOIN dienstrooster_schedule_period sp ON sp.pool_id = pm.pool_id
       WHERE sp.id = ? AND p.actief = 1 AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum ORDER BY p.codenaam LIMIT 1`
    )
    .get(periodId) as { codenaam: string };
  const eerste = await page.request.post(`${getBaseUrl()}/api/planner/period/${periodId}/import-balances`, {
    data: { rows: [{ codenaam: lid.codenaam, AVOND_delta: 2, WEEKEND_delta: 1 }] },
  });
  expect(eerste.status()).toBe(200);

  await page.goto(`${getBaseUrl()}/planner/setup/${periodId}`);
  await page.getByRole('button', { name: '5. Saldi' }).click();
  const kies = page.getByLabel('Beginsaldo als Excel-bestand');
  await kies.setInputFiles(xlsxBestand([[...SALDO_KOP], [lid.codenaam, 5, null]]));

  // Said first; nothing waits to be imported yet.
  const vraag = page.getByTestId('saldo-overschrijven');
  await expect(vraag).toContainText('Voor 1 persoon staat al een beginsaldo');
  await expect(vraag).toContainText('ook als een vakje in het bestand leeg is');
  await expect(vraag).toContainText(lid.codenaam);
  await expect(page.getByText(/records klaar om te importeren/)).toHaveCount(0);

  // No: nothing is taken along.
  await vraag.getByRole('button', { name: 'Annuleren' }).click();
  await expect(vraag).toHaveCount(0);
  await expect(page.getByText(/records klaar om te importeren/)).toHaveCount(0);

  // Yes: the rows are ready.
  await kies.setInputFiles(xlsxBestand([[...SALDO_KOP], [lid.codenaam, 5, null]]));
  await page.getByTestId('saldo-overschrijven').getByRole('button', { name: 'Ja, overschrijven' }).click();
  await expect(page.getByText('1 records klaar om te importeren')).toBeVisible();
  await expect(page.getByTestId('saldo-overschrijven')).toHaveCount(0);

  // A person with nothing yet is not asked about.
  await kies.setInputFiles(xlsxBestand([[...SALDO_KOP], ['Niemand-heeft-deze-naam', 1, 1]]));
  await expect(page.getByText('1 records klaar om te importeren')).toBeVisible();
  await expect(page.getByTestId('saldo-overschrijven')).toHaveCount(0);
});

test('eerdere toewijzingen: the sjabloon is there, a CSV and a wrong layout are refused, rows without a codenaam are left out', async ({ page }) => {
  await page.goto(`${getBaseUrl()}/planner/period/${periodId}/prior-assignments`);
  const link = page.getByRole('link', { name: 'Sjabloon downloaden (Excel)' });
  await expect(link).toBeVisible();

  const kies = page.getByLabel('Rooster als Excel-bestand');
  await kies.setInputFiles({ name: 'rooster.csv', mimeType: 'text/csv', buffer: Buffer.from('Datum,Week,Diensttype,Codenaam\n2032-12-30,52,Avond,A') });
  await expect(page.getByText('Alleen Excel-bestanden (.xlsx) kunnen worden ingelezen')).toBeVisible();

  await kies.setInputFiles(xlsxBestand([['Dag', 'Soort', 'Wie'], ['2032-12-30', 'Avond', 'A']]));
  await expect(page.getByText(/niet de kolommen van het sjabloon \(Datum, Week, Diensttype, Codenaam\)/)).toBeVisible();

  // The window the page names; one filled-in row inside it, one empty row of the sjabloon, one outside.
  const venster = (await (await page.request.get(`${getBaseUrl()}/api/periods/${periodId}/prior-assignments`)).json()).data.date_range as [string, string];
  await kies.setInputFiles(
    xlsxBestand([
      [...EERDERE_KOP],
      [venster[0], 1, 'Avond', 'Persoon-01'],
      [venster[1], 1, 'Avond', ''],
      ['1999-01-01', 1, 'Avond', 'Persoon-02'],
    ])
  );
  await expect(page.getByText('1 regel binnen het overloopvenster gevonden, 1 daarbuiten genegeerd')).toBeVisible();
});

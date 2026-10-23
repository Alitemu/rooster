import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';
import { createTestPeriod, createTestUsers, cleanupTestData, getBaseUrl } from './setup';

/**
 * "Voorkeuren importeren (test)" says one number for one import: the
 * changes "Controleren" counts are the ones "Toepassen" makes, and nothing
 * on the screen reads as another total.
 *
 * The list shows the first 50 changes. Under it stood "En nog 3442
 * wijzigingen." for an import of 3492, which read as the total: the count
 * looked wrong until Toepassen said 3492 (the planner's report, a file of
 * 31 people over 252 days).
 *
 * 7 days and 8 people: 56 changes, more than the list shows.
 */

let testData: ReturnType<typeof createTestPeriod>;
let people: Array<{ id: string; codenaam: string }> = [];

test.beforeAll(() => {
  testData = createTestPeriod('OPEN');
  const pool = (db.prepare('SELECT pool_id FROM dienstrooster_schedule_period WHERE id = ?').get(testData.period.id) as { pool_id: string }).pool_id;
  const extra = createTestUsers(3, testData.period.id);
  for (const user of extra) {
    db.prepare(`INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2030-12-31')`).run(uuid(), user.id, pool);
  }
  people = [...testData.users, ...extra];
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, people.map((p) => p.id));
});

async function loginAsAdmin(page: Page) {
  const res = await page.request.post(`${getBaseUrl()}/api/auth/staff-login`, {
    data: { codenaam: process.env.E2E_ADMIN_CODENAAM || 'admin', password: process.env.E2E_ADMIN_PASSWORD || 'Password123!' },
  });
  expect(res.ok(), 'run npm run seed: the import is for the beheerder only').toBe(true);
}

/** Every person blocked on every day, as a filled-in overview. */
function workbook(): Buffer {
  const serial = (datum: string) => (Date.parse(`${datum}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;
  return buildXlsx(
    [
      ['Datum', 'Dag', 'Week', 'Dienst', ...people.map((p) => p.codenaam)],
      ...testData.slots.map((s, i) => [
        serial(s.datum),
        'maandag',
        i + 1,
        s.type === 'WEEKEND' ? 'weekenddienst' : 'avonddienst',
        ...people.map(() => 'geblokkeerd'),
      ]),
    ],
    { deflate: true }
  );
}

test('checking and applying say the same number, and the list says it shows a part', async ({ page }) => {
  await loginAsAdmin(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await page.locator('h2:has-text("Exporteren & communicatie") > button').first().click();
  await page.getByRole('button', { name: /Voorkeuren importeren \(test\)/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Voorkeuren importeren' });

  await dialog.getByLabel('Excel-bestand met voorkeuren').setInputFiles({
    name: 'voorkeuren.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: workbook(),
  });
  await dialog.getByRole('button', { name: /^Controleren/ }).click();

  const result = dialog.getByTestId('import-resultaat');
  await expect(result).toContainText('56 keuzes veranderen bij 8 personen.');
  await expect(dialog.getByTestId('import-lijst-uitleg')).toHaveText('Hieronder de eerste 50 van de 56 wijzigingen.');
  await expect(dialog.getByTestId('import-lijst-rest')).toHaveText('De andere 6 staan niet in deze lijst. Toepassen voert alle 56 wijzigingen door.');
  await expect(result.locator('tbody tr')).toHaveCount(50);
  // No number on screen that reads as another total.
  await expect(result).not.toContainText('En nog');

  await dialog.getByRole('button', { name: 'Toepassen (56 wijzigingen)' }).click();
  await expect(result).toContainText('Klaar. 56 keuzes aangepast bij 8 personen.');
  const written = db
    .prepare(
      `SELECT COUNT(*) n FROM dienstrooster_availability a JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       WHERE s.period_id = ? AND a.blocking_level = 'ABSOLUUT' AND a.source = 'MANUAL'`
    )
    .get(testData.period.id) as { n: number };
  expect(written.n).toBe(56);
});

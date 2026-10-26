import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, getPersonalLinkUrl, loginAsPlanner, openSecties } from './setup';

/**
 * Front-end faults of the 0.805.0 audit, each in the browser:
 * - the swap panel keeps its list when a background refresh fails;
 * - approving a swap twice by a double click sends one request;
 * - two notifications marked read one after the other both stay read, and the counter follows;
 * - the codenaam filter of the assignments list keeps focus while the list reloads.
 */

test.describe.configure({ mode: 'serial' });

let testData: ReturnType<typeof createTestPeriod>;
let swapId: string;

test.beforeAll(() => {
  testData = createTestPeriod('GEPUBLICEERD');
  const [a, b] = testData.users;
  const slot = (persoon: string) =>
    (db.prepare('SELECT slot_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND person_id = ? LIMIT 1').get(testData.period.id, persoon) as { slot_id: string }).slot_id;
  swapId = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_swap_request (id, periode_id, aanvrager_person_id, aangeboden_slot_id, gevraagde_slot_id, respondent_person_id, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))`
  ).run(swapId, testData.period.id, a.id, slot(a.id), slot(b.id), b.id);
  for (const n of [1, 2]) {
    db.prepare(
      `INSERT INTO dienstrooster_notification (id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op)
       VALUES (?, ?, ?, 'RUILVERZOEK', ?, 'inhoud', datetime('now'))`
    ).run(uuid(), b.id, testData.period.id, `Melding ${n}`);
  }
});

test.afterAll(() => {
  db.prepare('DELETE FROM dienstrooster_swap_request WHERE id = ?').run(swapId);
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

const ontvangen = (page: import('@playwright/test').Page) => page.getByTestId('swap-ontvangen');

test('the swap panel keeps its list when a background refresh fails, and recovers by itself', async ({ page }) => {
  let falen = false;
  let mislukt = 0;
  await page.route(/\/swap-requests\?period_id=/, (route) => {
    if (!falen) return route.continue();
    mislukt++;
    return route.abort();
  });
  await page.goto(getPersonalLinkUrl(testData.users[1].token));
  await openSecties(page);
  await page.getByRole('button', { name: 'Ruilverzoeken bekijken' }).click();
  const kaart = ontvangen(page).locator('[data-status="PENDING"]');
  await expect(kaart).toHaveCount(1);

  falen = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => mislukt).toBeGreaterThan(0);
  await expect(kaart).toHaveCount(1);
  await expect(page.getByText('Laden van ruilverzoeken mislukt')).toHaveCount(0);

  falen = false;
  const voor = mislukt;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(kaart).toHaveCount(1);
  expect(mislukt).toBe(voor);
});

test('a double click on Goedkeuren sends one request and shows no error beside the success', async ({ page }) => {
  let aanroepen = 0;
  await page.route(/\/swap-requests\/[^/]+\/approve/, async (route) => {
    aanroepen++;
    await new Promise((klaar) => setTimeout(klaar, 600));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { afgesloten: [] } }) });
  });
  await page.goto(getPersonalLinkUrl(testData.users[1].token));
  await openSecties(page);
  await page.getByRole('button', { name: 'Ruilverzoeken bekijken' }).click();
  await ontvangen(page).getByRole('button', { name: 'Goedkeuren' }).dblclick();
  await expect(page.getByText('Ruil goedgekeurd', { exact: true })).toBeVisible();
  expect(aanroepen).toBe(1);
  await expect(page.getByRole('button', { name: 'Sluiten' })).toHaveCount(0);
});

test('two notifications marked read in a row both stay read, and the counter ends at zero', async ({ page }) => {
  await page.route(/\/notifications\/[^/]+\/read/, async (route) => {
    await new Promise((klaar) => setTimeout(klaar, 500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
  });
  await page.goto(getPersonalLinkUrl(testData.users[1].token));
  await page.getByRole('button', { name: /Meldingen/ }).click();
  await expect(page.getByTestId('unread-count')).toHaveText('2');
  const markeer = page.getByRole('button', { name: 'Markeer als gelezen' });
  await expect(markeer).toHaveCount(2);
  // Both requests are under way at once (each answers after half a second): the second click must not undo the first.
  await markeer.nth(0).click();
  await markeer.nth(1).click();
  await expect(page.getByTestId('unread-count')).toHaveText('0');
  await expect(markeer).toHaveCount(0);
});

test('the codenaam filter keeps focus while the list reloads', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.getByRole('heading', { name: /^Dienstrooster \(/ }).getByRole('button').click();
  await page.getByRole('button', { name: '📋 Lijst' }).click();
  const filter = page.getByLabel('Filter op codenaam');
  await expect(filter).toBeVisible();
  await filter.click();
  await page.keyboard.type('E2E', { delay: 120 });
  // Wait for the debounced reload to run and finish, then type on: the field is still the one with focus.
  await page.waitForResponse(/assignments\?page=1&codenaam=E2E/);
  await expect(filter).toBeFocused();
  await page.keyboard.type('Test');
  await expect(filter).toHaveValue('E2ETest');
  await expect(filter).toBeFocused();
});

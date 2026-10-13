import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsPlanner } from './setup';

/**
 * The planner's screens at phone width (CLAUDE.md: readable at 375px), the
 * ones that changed since audit 8: the period header with "Rooster
 * verwijderen" open, and Personeel beheren with its new date defaults.
 * Plus the date those defaults start at: today in the Netherlands, not in
 * UTC (audit 9).
 */

let testData: ReturnType<typeof createTestPeriod>;
const pools: string[] = [];
const rulesets: string[] = [];

test.beforeAll(() => {
  testData = createTestPeriod('GEGENEREERD');
  const ruleset = uuid();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'Mobiel', '{}', datetime('now'))`).run(ruleset);
  rulesets.push(ruleset);
  const pool = uuid();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(pool, `Mobiel-${pool.slice(0, 6)}`, ruleset);
  pools.push(pool);
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  for (const id of pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
});

const overflow = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('at 375px', () => {
  test.use({ viewport: { width: 375, height: 740 } });

  // Audit 9: the header puts the title and the status column side by side
  // without wrapping - 28px too wide already, 167px with the "Rooster
  // verwijderen" panel open (its buttons sit in a row past the edge).
  test('the period page with "Rooster verwijderen" open does not scroll sideways', async ({ page }) => {
    test.fail();
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.getByRole('button', { name: /Rooster verwijderen/ }).click();
    await expect(page.getByTestId('rooster-verwijderen')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test('Personeel beheren does not scroll sideways', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/pool/${pools[0]}/staff`);
    await expect(page.getByText('Nieuw personeelslid toevoegen')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe('in the Netherlands, just after midnight', () => {
  test.use({ timezoneId: 'Europe/Amsterdam' });

  // Audit 9: the page takes today from toISOString() (UTC), so at 00:30
  // Dutch time a new member starts yesterday.
  test('a new member starts today, Dutch time', async ({ page }) => {
    test.fail();
    await loginAsPlanner(page);
    await page.clock.setFixedTime(new Date('2026-10-13T22:30:00Z'));
    await page.goto(`${getBaseUrl()}/planner/pool/${pools[0]}/staff`);
    await expect(page.getByText('Nieuw personeelslid toevoegen')).toBeVisible();
    await expect(page.locator('input[type="date"]').nth(0)).toHaveValue('2026-10-14');
  });
});

import { test, expect } from '@playwright/test';
import { getBaseUrl, loginAsPlanner } from './setup';

/**
 * Accounts beheren is for the beheerder only (requireAdminAccess). A planner
 * who opens the page sees that and nothing else: the list and the
 * "Nieuw account" form that showed below the notice could only be refused.
 * A list that couldn't be loaded at all left the page on "Accounts laden..."
 * for good (audit 16).
 */

test('a planner sees only that accounts are for the beheerder', async ({ page }) => {
  // The seeded 'planner' is a PLANNER, not an ADMIN (scripts/seed.ts).
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/accounts`);

  await expect(page.getByText('Alleen een beheerder kan accounts beheren.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accounts beheren' })).toBeVisible();
  // exact: the introduction speaks of "Een nieuw account" itself.
  await expect(page.getByText('Nieuw account', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Codenaam' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Toevoegen' })).toHaveCount(0);
});

test('a list that does not load says so instead of loading for good', async ({ page }) => {
  await loginAsPlanner(page);
  await page.route('**/api/admin/accounts', (route) => route.abort());
  await page.goto(`${getBaseUrl()}/planner/accounts`);

  await expect(page.getByText('Laden van accounts mislukt')).toBeVisible();
  await expect(page.getByText('Accounts laden...')).toHaveCount(0);
});

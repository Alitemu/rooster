import { test, expect, type Page } from '@playwright/test';
import { createTestPeriod, cleanupTestData, getBaseUrl, loginAsBeheerder, loginAsPlanner } from './setup';

/**
 * "Persoonlijke links" on the achterwacht's period page (0.802.0): only the
 * beheerder has the section; it lists the links of the period, and revoking
 * one (after a question) makes that link refuse to log in.
 */

let testData: ReturnType<typeof createTestPeriod>;

test.beforeAll(() => {
  testData = createTestPeriod('GEPUBLICEERD');
});

test.afterAll(() => {
  cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

const sectie = (page: Page) => page.locator('div.card', { has: page.getByRole('heading', { name: 'Persoonlijke links' }) }).first();

test('the planner has no section Persoonlijke links, and no way to the list', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await expect(page.getByRole('heading', { name: 'Exporteren & communicatie' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Persoonlijke links' })).toHaveCount(0);
  const res = await page.request.get(`${getBaseUrl()}/api/planner/period/${testData.period.id}/toegangslinks`);
  expect([401, 403]).toContain(res.status());
});

test('the beheerder sees the links, revokes one after the question, and that link no longer logs in', async ({ page }) => {
  const user = testData.users[0];
  await loginAsBeheerder(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await sectie(page).getByRole('heading').getByRole('button').click();
  const rijen = sectie(page).getByTestId('toegangslink');
  await expect(rijen).toHaveCount(testData.users.length);
  const rij = rijen.filter({ hasText: user.codenaam });
  await expect(rij).toContainText('Werkt');
  await expect(rij).toContainText('Nog niet gebruikt');
  // Nothing of the link itself on the page.
  expect(await page.content()).not.toContain(user.token);

  // Asking is not revoking.
  await rij.getByRole('button', { name: 'Intrekken' }).click();
  await expect(rij.getByRole('alertdialog')).toContainText('Weet je zeker');
  await rij.getByRole('button', { name: 'Annuleren' }).click();
  await expect(rij).toContainText('Werkt');
  expect((await page.request.get(`${getBaseUrl()}/api/auth/verify-link?token=${user.token}`)).status()).toBe(200);

  await rij.getByRole('button', { name: 'Intrekken' }).click();
  await rij.getByRole('button', { name: 'Ja, intrekken' }).click();
  await expect(sectie(page).getByRole('status')).toContainText(`De link van ${user.codenaam} is ingetrokken`);
  await expect(rij).toContainText('Ingetrokken op');
  await expect(rij.getByRole('button', { name: 'Intrekken' })).toHaveCount(0);
  const nu = await page.request.get(`${getBaseUrl()}/api/auth/verify-link?token=${user.token}`);
  expect(nu.status()).toBe(401);
  // The others still work.
  expect((await page.request.get(`${getBaseUrl()}/api/auth/verify-link?token=${testData.users[1].token}`)).status()).toBe(200);
});

test.describe('at 375px', () => {
  test.use({ viewport: { width: 375, height: 740 } });

  test('the open section does not scroll the page sideways', async ({ page }) => {
    await loginAsBeheerder(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await sectie(page).getByRole('heading').getByRole('button').click();
    await expect(sectie(page).getByTestId('toegangslink').first()).toBeVisible();
    await sectie(page).getByRole('button', { name: /^Link van .* intrekken$/ }).nth(1).click();
    await expect(sectie(page).getByRole('alertdialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, getBaseUrl, demoDatum, isoJaarWeek } from './setup';

/**
 * The new layout of the period page (1.9.0, ?indeling=nieuw while the accordion is the default): the
 * sections as a list on the left, one on the right, each with its own address; on a phone the list first.
 * Every other browser test still sees the accordion, which must stay as it was. The rules are in
 * lib/periodeIndeling.test.ts.
 */
let testData: ReturnType<typeof createTestPeriod>;
test.beforeEach(() => {
  testData = createTestPeriod('OPEN');
  db.prepare('UPDATE dienstrooster_schedule_period SET uitgenodigd_op = ? WHERE id = ?').run(new Date().toISOString(), testData.period.id);
});
test.afterEach(() => {
  if (testData) cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

const adres = (extra = '') => `${getBaseUrl()}/planner/period/${testData.period.id}?indeling=nieuw${extra}`;
const lijst = (page: Page) => page.getByRole('navigation', { name: 'Onderdelen van de periode' });

test('a list on the left, one section on the right, an address per section and the back button', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');

  // Opens where the work is: before closing, the preferences.
  await expect(lijst(page).getByRole('link', { name: /^Status voorkeuren/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
  for (const groep of ['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']) await expect(lijst(page).getByText(groep, { exact: true })).toBeVisible();
  // No accordion in the new layout.
  await expect(page.locator('h2 button[aria-expanded]')).toHaveCount(0);

  // Every item shows its own section, and only that one.
  const items = await lijst(page).getByRole('link').all();
  expect(items.length).toBeGreaterThanOrEqual(6);
  for (const item of items) {
    const naam = (await item.locator('span.block.font-medium').innerText()).trim();
    await item.click();
    await expect(page.getByRole('heading', { level: 2, name: naam })).toBeVisible();
    await expect(page.locator('[data-testid^="onderdeel-"]')).toHaveCount(1);
  }

  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await expect(page).toHaveURL(/onderdeel=personeel-beheren/);
  await lijst(page).getByRole('link', { name: /^Exporteren & communicatie/ }).click();
  await expect(page.getByTestId('onderdeel-exporteren')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('onderdeel-personeel-beheren')).toBeVisible();

  // A link to a section opens that section.
  await page.goto(adres('&onderdeel=eerdere-toewijzingen'));
  await expect(page.getByTestId('onderdeel-eerdere-toewijzingen')).toBeVisible();
});

test('a made roster with an empty dienst opens on it, and Volgende stap goes there', async ({ page }) => {
  db.prepare("UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?").run(testData.period.id);
  const avond = db
    .prepare(`SELECT st.id FROM dienstrooster_shift_type st JOIN dienstrooster_schedule_period sp ON sp.pool_id = st.pool_id WHERE sp.id = ? AND st.teller = 'AVOND' LIMIT 1`)
    .get(testData.period.id) as { id: string };
  const datum = demoDatum('2027-01-13');
  db.prepare(`INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id) VALUES (?, ?, ?, ?, ?, ?)`).run(uuid(), testData.period.id, datum, ...isoJaarWeek(datum), avond.id);

  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('volgende-stap')).toContainText('1 dienst is nog leeg.');
  await expect(page.getByTestId('onderdeel-vooraf-invullen')).toBeVisible();
  await expect(page.getByTestId('onderdeel-vooraf-invullen').getByRole('heading', { level: 2 })).toHaveText('Lege diensten aanvullen');

  // From another section, the button of Volgende stap shows the section and gives its button the focus.
  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await page.getByTestId('volgende-stap').getByRole('button', { name: 'Naar Lege diensten aanvullen' }).click();
  await expect(page).toHaveURL(/onderdeel=vooraf-invullen/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('knop-lege-diensten');
});

test('on a phone: the list first, a tap opens the section, Alle onderdelen goes back', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');
  await expect(lijst(page)).toBeVisible();
  await expect(page.locator('[data-testid^="onderdeel-"]')).toBeHidden();

  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await expect(page.getByTestId('onderdeel-personeel-beheren')).toBeVisible();
  await expect(lijst(page)).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  await page.getByRole('link', { name: '‹ Alle onderdelen' }).click();
  await expect(lijst(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('without ?indeling=nieuw the page is the accordion it was', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await expect(lijst(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Status voorkeuren' }).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
});

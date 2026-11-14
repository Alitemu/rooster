import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, getBaseUrl, demoDatum, isoJaarWeek, openDienstrooster } from './setup';

/**
 * A roster that is made but has empty diensten (1.7.0), as the planner meets it:
 * - F-03: the tab Lijst shows an empty dienst as its own row with "nog niemand", in the order of the
 *   days, and "Iemand toewijzen" fills it. It used to be a missing row.
 * - F-05: the screen to fill them is called "Lege diensten aanvullen" once the roster is made.
 * - F-02: on a phone that screen keeps the date of a dienst on one line, the list of names under it.
 *
 * The period of createTestPeriod has a dienst every Monday, all taken. Two empty avonddiensten are added
 * on a Wednesday, in weeks 2 and 5: the list of candidates for them is never empty.
 */
let testData: ReturnType<typeof createTestPeriod>;
const LEEG = [demoDatum('2027-01-13'), demoDatum('2027-02-03')];
const leegSlots: string[] = [];

test.beforeAll(() => {
  testData = createTestPeriod('GEGENEREERD');
  const avond = db
    .prepare(`SELECT st.id FROM dienstrooster_shift_type st JOIN dienstrooster_schedule_period sp ON sp.pool_id = st.pool_id WHERE sp.id = ? AND st.teller = 'AVOND' LIMIT 1`)
    .get(testData.period.id) as { id: string };
  for (const datum of LEEG) {
    const id = uuid();
    db.prepare(`INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id) VALUES (?, ?, ?, ?, ?, ?)`).run(
      id,
      testData.period.id,
      datum,
      ...isoJaarWeek(datum),
      avond.id
    );
    leegSlots.push(id);
  }
});

test.afterAll(() => {
  if (testData) cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

/** dd-mm-jjjj, as every date in a list reads (CLAUDE.md, Calendar/UI Constraints). */
const toon = (iso: string) => iso.split('-').reverse().join('-');

async function openLijst(page: Page) {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await openDienstrooster(page);
  await page.getByRole('button', { name: /Lijst/ }).first().click();
  await page.waitForLoadState('networkidle');
}

test('the list shows an empty dienst as its own row, by day, and fills it', async ({ page }) => {
  await openLijst(page);
  const leeg = page.getByTestId('lijst-lege-dienst');
  await expect(leeg).toHaveCount(2);
  await expect(leeg.first()).toContainText(toon(LEEG[0]));
  await expect(leeg.first()).toContainText('nog niemand');
  await expect(leeg.first()).toContainText('Leeg');

  // In the order of the days: the empty Wednesday stands between the Mondays around it.
  const datums = (await page.locator('tbody tr td:first-child').allInnerTexts()).map((d) => d.trim().split('-').reverse().join('-'));
  expect(datums).toEqual([...datums].sort());
  expect(datums).toContain(LEEG[0]);

  await leeg.first().getByRole('button', { name: 'Iemand toewijzen' }).click();
  const kies = leeg.first().getByLabel('Kies iemand voor deze dienst');
  await expect(kies).toBeVisible();
  await kies.selectOption({ index: 1 });

  await expect(page.getByTestId('lijst-lege-dienst')).toHaveCount(1);
  const gevuld = db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?').get(testData.period.id, leegSlots[0]) as
    | { person_id: string }
    | undefined;
  expect(gevuld?.person_id).toBeTruthy();
});

test('once the roster is made the screen is called Lege diensten aanvullen', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: /Lege diensten aanvullen/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Rooster vooraf invullen/ })).toHaveCount(0);
});

test('on a phone the date of a dienst stays on one line, the names under it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}/fill-gaps`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Lege diensten aanvullen' })).toBeVisible();

  const dienst = page.getByTestId('vooraf-dienst').first();
  await expect(dienst).toBeVisible();
  const regels = await dienst.getByTestId('vooraf-dienst-datum').evaluate((el) => {
    const hoogte = el.getBoundingClientRect().height;
    const regel = parseFloat(getComputedStyle(el).lineHeight);
    return hoogte / regel;
  });
  expect(regels).toBeLessThan(1.5);

  const kies = dienst.getByLabel('Kies iemand voor deze dienst');
  const vak = await kies.boundingBox();
  expect(vak).not.toBeNull();
  expect(vak!.x + vak!.width).toBeLessThanOrEqual(375);
  // The list is under the dienst, not next to it.
  const datumVak = await dienst.getByTestId('vooraf-dienst-datum').boundingBox();
  expect(vak!.y).toBeGreaterThan(datumVak!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

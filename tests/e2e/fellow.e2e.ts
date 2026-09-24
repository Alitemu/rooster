import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, getPersonalLinkUrl, cleanupTestData, loginAsPlanner, getBaseUrl } from './setup';

/**
 * "Ik ben fellow" (lib/fellows.ts) from both sides: the participant ticks
 * it on the preferences step and their Saturday is blocked for that
 * reason; the planner sees the "Fellow" label in "Status voorkeuren",
 * with the fellows at the bottom of the list.
 */

test.describe('Fellows', () => {
  let testData: ReturnType<typeof createTestPeriod>;
  const saturday = '2027-01-09';

  test.beforeAll(() => {
    testData = createTestPeriod('OPEN');
    // The fixture only has Mondays; a fellow needs a weekend day to block.
    const weekend = db.prepare(`SELECT id FROM dienstrooster_shift_type WHERE teller = 'WEEKEND' LIMIT 1`).get() as {
      id: string;
    };
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id)
       VALUES (?, ?, ?, 2027, 1, ?)`
    ).run(uuid(), testData.period.id, saturday, weekend.id);
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test('the participant ticks it and their Saturday is blocked, the planner sees the label at the bottom', async ({ page }) => {
    const user = testData.users[0];
    await page.goto(getPersonalLinkUrl(user.token));
    await page.waitForLoadState('networkidle');
    const calendarTab = page.getByRole('button', { name: /Voorkeuren/ }).first();
    if (await calendarTab.count()) {
      await calendarTab.click();
      await page.waitForLoadState('networkidle');
    }

    const checkbox = page.getByRole('checkbox', { name: /Ik ben fellow/ });
    await expect(checkbox).toBeVisible();
    await expect(page.getByText(/ondersteunen bij de voorwacht/)).toBeVisible();
    await checkbox.check();
    await expect(page.locator('button[title*="geblokkeerd omdat je fellow bent"]').first()).toBeVisible();

    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
    const section = page.getByRole('button', { name: /Status voorkeuren/ }).first();
    const rows = page.locator('tr', { has: page.locator(`a[href$="/person/${user.id}"]`) });
    if (!(await rows.first().isVisible())) await section.click();

    const row = rows.first();
    await expect(row).toBeVisible();
    await expect(row.getByText('Fellow', { exact: true })).toBeVisible();
    await expect(row.getByRole('checkbox')).toBeChecked();

    // The fixture's users are the only ones in this row set with that
    // prefix; the fellow is listed after every one of them.
    const codenamen = await page
      .locator('tbody tr td:first-child a')
      .allTextContents();
    const index = codenamen.indexOf(user.codenaam);
    const others = testData.users.slice(1).map((u) => codenamen.indexOf(u.codenaam));
    expect(others.every((i) => i >= 0 && i < index)).toBe(true);
  });
});

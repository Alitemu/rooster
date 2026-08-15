import { test, expect } from '@playwright/test';
import { createTestPeriod, getBaseUrl, cleanupTestData, loginAsPlanner } from './setup';
import { db } from '@/db/client';

/**
 * Roster publication, end to end through the real UI.
 *
 * Every assertion here runs unconditionally. The previous version wrapped
 * each one in `if (await locator.isVisible(...))`, so when an element was
 * missing the body was skipped and the test passed having checked nothing -
 * and the elements were in fact always missing, because the fixture created
 * an already-GEPUBLICEERD period while the tests looked for the "Publish
 * Roster" button that only a GEGENEREERD period shows. They also targeted
 * markup that does not exist (a "Roster Publication" heading, a
 * validation-checks test id, a "Confirm" button).
 *
 * Tests run in declaration order within a describe, and publishing is a
 * one-way transition, so the ordering below is deliberate: everything that
 * needs GEGENEREERD comes before the publish, and the published-state
 * checks come after.
 */

test.describe('Roster Publication Workflow - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    testData = createTestPeriod('GEGENEREERD');
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test.beforeEach(async ({ page }) => {
    await loginAsPlanner(page);
  });

  const gotoPlanner = async (page: import('@playwright/test').Page) => {
    await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
    await page.waitForLoadState('networkidle');
  };

  test('planner sees the publish button for a generated period', async ({ page }) => {
    await gotoPlanner(page);

    const publishButton = page.getByRole('button', { name: /Publish Roster/i });
    await expect(publishButton).toBeVisible();
    await expect(publishButton).toBeEnabled();
  });

  test('publication dialog reports the roster is ready and lists its checks', async ({ page }) => {
    await gotoPlanner(page);
    await page.getByRole('button', { name: /Publish Roster/i }).click();

    const dialogHeading = page.getByRole('heading', { name: 'Publish Roster' });
    await expect(dialogHeading).toBeVisible();

    // The fixture is a complete roster: 7 slots, 7 assignments, no blocks.
    await expect(page.getByText('Ready to Publish')).toBeVisible();

    // Coverage tiles must report the real counts, not placeholders. Scope to
    // the tile's own container: a bare getByText('Slots Filled') also matches
    // the "All slots filled" check label further down.
    const tile = (label: string) =>
      page.locator('div.text-center', { has: page.getByText(label, { exact: true }) });

    await expect(tile('Slots Filled')).toContainText('7');
    await expect(tile('Total Slots')).toContainText('7');

    // All three validation checks are listed, and none is marked failed.
    // Substring, not exact: each label's text node starts with its own
    // status glyph, e.g. "✓All slots filled".
    await expect(page.getByText('All slots filled')).toBeVisible();
    await expect(page.getByText('No hard blocking violations')).toBeVisible();
    await expect(page.getByText('Band compliance')).toBeVisible();
    await expect(page.getByText('✗', { exact: true })).toHaveCount(0);
  });

  test('publish is blocked while the roster still has an unfilled slot', async ({ page }) => {
    // Free one slot, so publication-check must fail on coverage.
    const removed = db
      .prepare(
        `SELECT id, person_id, slot_id FROM dienstrooster_assignment
         WHERE schedule_version_id = ? LIMIT 1`
      )
      .get(testData.period.id) as { id: string; person_id: string; slot_id: string };
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(removed.id);

    try {
      await gotoPlanner(page);
      await page.getByRole('button', { name: /Publish Roster/i }).click();

      await expect(page.getByText('Issues Found')).toBeVisible();
      await expect(page.getByText(/Only 6 of 7 slots are filled/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Publish Now' })).toBeDisabled();

      // The disabled button is convenience only - the API has to refuse it
      // too, or a direct POST publishes an incomplete roster and notifies
      // every member that it is final.
      const res = await page.request.post(
        `${getBaseUrl()}/api/planner/period/${testData.period.id}/publish`
      );
      expect(res.status()).toBe(400);
      expect(String((await res.json()).error)).toMatch(/not ready to publish/i);

      const stillGenerated = db
        .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
        .get(testData.period.id) as { status: string };
      expect(stillGenerated.status).toBe('GEGENEREERD');
    } finally {
      db.prepare(
        `INSERT INTO dienstrooster_assignment
           (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
         VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
      ).run(removed.id, testData.period.id, removed.person_id, removed.slot_id);
    }
  });

  test('publishing flips the period and notifies every pool member', async ({ page }) => {
    const notifiedBefore = (
      db
        .prepare('SELECT COUNT(*) as c FROM dienstrooster_notification WHERE periode_id = ?')
        .get(testData.period.id) as { c: number }
    ).c;

    await gotoPlanner(page);
    await page.getByRole('button', { name: /Publish Roster/i }).click();

    const publishNow = page.getByRole('button', { name: 'Publish Now' });
    await expect(publishNow).toBeEnabled();
    await publishNow.click();

    // The dialog closes and BOTH the dashboard's status line and the page's
    // own header badge reflect the new state - they hold separate copies of
    // the period, so a stale badge after publishing is a real regression.
    await expect(page.getByText('✅ Published')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Status: GEPUBLICEERD')).toBeVisible();

    const period = db
      .prepare(
        'SELECT status, gepubliceerd_op, gepubliceerd_door_person_id FROM dienstrooster_schedule_period WHERE id = ?'
      )
      .get(testData.period.id) as {
      status: string;
      gepubliceerd_op: string | null;
      gepubliceerd_door_person_id: string | null;
    };

    expect(period.status).toBe('GEPUBLICEERD');
    expect(period.gepubliceerd_op).toBeTruthy();
    expect(period.gepubliceerd_door_person_id).toBeTruthy();

    const notifiedAfter = (
      db
        .prepare('SELECT COUNT(*) as c FROM dienstrooster_notification WHERE periode_id = ?')
        .get(testData.period.id) as { c: number }
    ).c;
    expect(notifiedAfter).toBeGreaterThan(notifiedBefore);
  });

  test('the publish button is gone once the period is published', async ({ page }) => {
    await gotoPlanner(page);

    await expect(page.getByText('GEPUBLICEERD').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Publish Roster/i })).toHaveCount(0);
  });

  test('republishing a published period is refused by the API', async ({ page }) => {
    const res = await page.request.post(
      `${getBaseUrl()}/api/planner/period/${testData.period.id}/publish`
    );

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toMatch(/GEPUBLICEERD/);
  });

  test('staff see their own shifts on a published roster', async ({ browser }) => {
    // users[0] holds two of the fixture's assignments.
    const user = testData.users[0];
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${getBaseUrl()}/person/${user.token}`);
      await page.waitForLoadState('networkidle');

      await expect(page.getByRole('heading', { name: 'Your Roster' })).toBeVisible();

      const expected = (
        db
          .prepare(
            'SELECT COUNT(*) as c FROM dienstrooster_assignment WHERE schedule_version_id = ? AND person_id = ?'
          )
          .get(testData.period.id, user.id) as { c: number }
      ).c;
      expect(expected).toBeGreaterThan(0);

      // Balance summary is rendered in words, never as a raw signed number.
      const summary = page.getByText(/shifts assigned/i).first();
      await expect(summary).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('staff receive a publication notification', async ({ browser }) => {
    const user = testData.users[1];
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`${getBaseUrl()}/person/${user.token}`);
      await page.waitForLoadState('networkidle');

      const stored = db
        .prepare(
          `SELECT onderwerp FROM dienstrooster_notification
           WHERE periode_id = ? AND person_id = ?`
        )
        .all(testData.period.id, user.id) as Array<{ onderwerp: string }>;
      expect(stored.length).toBeGreaterThan(0);

      await page.getByRole('button', { name: /Notifications/i }).click();
      await expect(page.getByText(stored[0].onderwerp).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

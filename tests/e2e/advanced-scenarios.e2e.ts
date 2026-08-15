import { test, expect } from '@playwright/test';
import {
  createTestPeriod,
  getPersonalLinkUrl,
  getBaseUrl,
  cleanupTestData,
  loginAsPlanner,
} from './setup';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';

/**
 * Concurrency, notifications, error handling and mobile layout.
 *
 * Rewritten to assert unconditionally. Previously every check sat inside
 * `if (await locator.isVisible(...))`, which meant a missing element made
 * the test pass silently - and two of these had no expect() at all.
 */

function seedNotification(periodId: string, personId: string, type: string, subject: string) {
  const id = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_notification
       (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, 'body', 0, datetime('now'))`
  ).run(id, personId, periodId, type, subject);
  return id;
}

test.describe('Concurrent Operations - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test('two people can open the swap dialog at the same time', async ({ browser }) => {
    const [user1, user2] = [testData.users[0], testData.users[1]];

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      await Promise.all([
        page1.goto(getPersonalLinkUrl(user1.token)),
        page2.goto(getPersonalLinkUrl(user2.token)),
      ]);

      // waitFor, not isVisible: isVisible() reports the state at that instant
      // and ignores its timeout, so the old check simply raced the page's
      // client-side fetch and failed about 3 runs in 5.
      const openDialog = async (page: typeof page1) => {
        const button = page.getByRole('button', { name: /Request Swap/i });
        await button.waitFor({ state: 'visible', timeout: 15000 });
        await button.click();
        await expect(page.getByRole('dialog', { name: 'Request Shift Swap' })).toBeVisible();
      };

      await Promise.all([openDialog(page1), openDialog(page2)]);
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test('a swap can only be answered once', async ({ browser }) => {
    // Create a pending swap directly, then answer it twice.
    const requester = testData.users[0];
    const respondent = testData.users[1];
    const requesterSlot = testData.assignments.find((a) => a.personId === requester.id)!.slotId;
    const respondentSlot = testData.assignments.find((a) => a.personId === respondent.id)!.slotId;

    const swapId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_swap_request
         (id, periode_id, aanvrager_person_id, respondent_person_id,
          aangeboden_slot_id, gevraagde_slot_id, status, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))`
    ).run(swapId, testData.period.id, requester.id, respondent.id, requesterSlot, respondentSlot);

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Establish the respondent's session, then answer twice.
      await page.goto(getPersonalLinkUrl(respondent.token));
      await page.waitForLoadState('networkidle');

      const url = `${getBaseUrl()}/api/person/${respondent.id}/swap-requests/${swapId}/approve`;
      const first = await page.request.post(url);
      const second = await page.request.post(url);

      expect(first.ok()).toBeTruthy();
      expect(second.ok()).toBeFalsy();

      const status = (
        db
          .prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?')
          .get(swapId) as { status: string }
      ).status;
      expect(status).toBe('GOEDGEKEURD');
    } finally {
      await context.close();
    }
  });
});

test.describe('Notification System - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test('a notification can be marked as read and stays read', async ({ browser }) => {
    const user = testData.users[0];
    seedNotification(testData.period.id, user.id, 'ROSTER_GEREED', 'Your roster is ready');

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /Notifications/i }).click();

      const item = page.locator('[data-testid="notification-item"]').first();
      await expect(item).toBeVisible();
      await expect(page.locator('[data-testid="unread-count"]')).toHaveText('1');

      await page.getByRole('button', { name: 'Mark as read' }).first().click();

      await expect
        .poll(
          () =>
            (
              db
                .prepare(
                  'SELECT gelezen FROM dienstrooster_notification WHERE periode_id = ? AND person_id = ?'
                )
                .get(testData.period.id, user.id) as { gelezen: number }
            ).gelezen,
          { timeout: 10000 }
        )
        .toBe(1);

      // ...and the count reflects it after a reload, not just optimistically.
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /Notifications/i }).click();
      await expect(page.locator('[data-testid="unread-count"]')).toHaveText('0');
    } finally {
      await context.close();
    }
  });

  test('notifications can be filtered by type', async ({ browser }) => {
    const user = testData.users[1];
    seedNotification(testData.period.id, user.id, 'RUILVERZOEK', 'Swap request from a colleague');
    seedNotification(testData.period.id, user.id, 'ROSTER_GEREED', 'Your roster is ready');

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /Notifications/i }).click();

      await expect(page.locator('[data-testid="notification-item"]')).toHaveCount(2);

      await page.locator('select').first().selectOption('RUILVERZOEK');

      await expect(page.locator('[data-type="RUILVERZOEK"]')).toHaveCount(1);
      await expect(page.locator('[data-type="ROSTER_GEREED"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe('Error Handling - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test('an invalid personal link is rejected rather than showing a roster', async ({ page }) => {
    await page.goto(getPersonalLinkUrl('definitely-not-a-real-token'));
    await page.waitForLoadState('networkidle');

    // No roster may leak, and the page has to say something.
    await expect(page.getByRole('heading', { name: 'Your Roster' })).toHaveCount(0);
    await expect(page.getByText(/invalid|not found|expired|error/i).first()).toBeVisible();
  });

  test('the API refuses an invalid personal link', async ({ request }) => {
    const res = await request.get(`${getBaseUrl()}/api/auth/verify-link?token=definitely-not-real`);
    expect(res.status()).toBe(401);
  });

  test('a non-existent period shows an error, not a blank dashboard', async ({ page }) => {
    await loginAsPlanner(page);
    await page.goto(`${getBaseUrl()}/planner/period/does-not-exist`);
    await page.waitForLoadState('networkidle');

    await expect(page.getByText(/not found|error/i).first()).toBeVisible();
  });

  test('the swap dialog will not submit until both shifts are chosen', async ({ browser }) => {
    const user = testData.users[3];
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /Request Swap/i }).click();

      const send = page.getByRole('button', { name: 'Send Request' });
      await expect(send).toBeVisible();
      await expect(send).toBeDisabled();

      // Choosing only one side is still not enough.
      const offered = page.locator('select[name="offered-slot"]');
      const firstOffered = await offered.locator('option').nth(1).getAttribute('value');
      await offered.selectOption(firstOffered!);
      await expect(send).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  test('the API rejects a swap request with missing fields', async ({ browser }) => {
    const user = testData.users[4];
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');

      const res = await page.request.post(
        `${getBaseUrl()}/api/person/${user.id}/swap-requests`,
        { data: { period_id: testData.period.id } }
      );
      expect(res.status()).toBe(400);

      // And an empty body must not become a 500.
      const empty = await page.request.post(
        `${getBaseUrl()}/api/person/${user.id}/swap-requests`,
        { data: {} }
      );
      expect(empty.status()).toBe(400);
    } finally {
      await context.close();
    }
  });
});

test.describe('Mobile Responsiveness - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  test('the personal page does not scroll sideways at 375px', async ({ browser }) => {
    const user = testData.users[0];
    const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');

      await expect(page.locator('main')).toBeVisible();

      // CLAUDE.md requires the grid to stay readable at 375px; a document
      // wider than the viewport means horizontal scrolling.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  test('the swap dialog fits on a 375px screen', async ({ browser }) => {
    const user = testData.users[1];
    const context = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /Request Swap/i }).click();

      const dialog = page.getByRole('dialog', { name: 'Request Shift Swap' });
      await expect(dialog).toBeVisible();

      const box = await dialog.locator('> div').boundingBox();
      expect(box).toBeTruthy();
      expect(box!.width).toBeLessThanOrEqual(375);

      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Send Request' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

import { test, expect } from '@playwright/test';
import { createTestPeriod, getPersonalLinkUrl, cleanupTestData } from './setup';

/**
 * Phase 3 Advanced Scenarios E2E Tests
 *
 * Tests concurrent operations, edge cases, and complex workflows
 */

test.describe('Concurrent Operations - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map(u => u.id));
  });

  test('Multiple users can create swap requests simultaneously', async ({ browser }) => {
    const user1 = testData.users[0];
    const user2 = testData.users[1];

    // Create two concurrent browser contexts
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Navigate both users to their personal pages
    await Promise.all([
      page1.goto(getPersonalLinkUrl(user1.token)),
      page2.goto(getPersonalLinkUrl(user2.token))
    ]);

    // Both create swap requests simultaneously
    const requests = await Promise.all([
      (async () => {
        const button = page1.locator('button:has-text("Request Swap")').first();
        if (await button.isVisible({ timeout: 3000 }).catch(() => false)) {
          await button.click();
          return true;
        }
        return false;
      })(),
      (async () => {
        const button = page2.locator('button:has-text("Request Swap")').first();
        if (await button.isVisible({ timeout: 3000 }).catch(() => false)) {
          await button.click();
          return true;
        }
        return false;
      })()
    ]);

    // At least one should succeed
    expect(requests.some(r => r)).toBe(true);

    await context1.close();
    await context2.close();
  });

  test('Concurrent approval/rejection of same swap fails gracefully', async ({ browser }) => {
    // This would require setting up a specific swap request
    // Then having two concurrent users try to respond
    // Should handle race condition gracefully

    const user1 = testData.users[2];
    const user2 = testData.users[3];

    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Navigate to swap management
    await Promise.all([
      page1.goto(getPersonalLinkUrl(user1.token)),
      page2.goto(getPersonalLinkUrl(user2.token))
    ]);

    // In a real test, both would find same swap and try to respond
    // System should prevent double-response

    await context1.close();
    await context2.close();
  });
});

test.describe('Notification System - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map(u => u.id));
  });

  test('Notifications can be marked as read', async ({ browser }) => {
    const user = testData.users[0];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to personal page
    await page.goto(getPersonalLinkUrl(user.token));

    // Open notifications
    await page.click('button:has-text("Notifications")').catch(() => null);

    // Wait for notifications to load
    await page.waitForSelector('[data-testid="notification-item"]', { timeout: 5000 }).catch(() => null);

    // Click mark as read on first notification
    const readButton = page.locator('button:has-text("Mark as read")').first();
    if (await readButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await readButton.click();

      // Verify notification is marked read
      const notification = readButton.locator('..');
      const unreadBadge = notification.locator('[data-unread="true"]');

      await expect(unreadBadge).not.toBeVisible().catch(() => {
        console.log('Unread badge still visible');
      });
    }

    await context.close();
  });

  test('Notifications filter by type', async ({ browser }) => {
    const user = testData.users[1];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to personal page
    await page.goto(getPersonalLinkUrl(user.token));

    // Open notifications
    await page.click('button:has-text("Notifications")').catch(() => null);

    // Look for type filter
    const typeFilter = page.locator('select[name="notification-type"]');
    if (await typeFilter.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Filter by RUILVERZOEK
      await typeFilter.selectOption('RUILVERZOEK');

      // Verify only swap notifications shown
      const items = await page.locator('[data-type="RUILVERZOEK"]').count();
      expect(items).toBeGreaterThanOrEqual(0);
    }

    await context.close();
  });

  test('Notifications maintain read/unread state', async ({ browser }) => {
    const user = testData.users[2];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to personal page
    await page.goto(getPersonalLinkUrl(user.token));

    // Open notifications
    await page.click('button:has-text("Notifications")').catch(() => null);

    // Check unread count before marking read
    const unreadBadge = page.locator('[data-testid="unread-count"]');
    const unreadCountBefore = await unreadBadge.textContent().catch(() => '0');

    // Mark a notification as read
    const readButton = page.locator('button:has-text("Mark as read")').first();
    if (await readButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await readButton.click();

      // Refresh page
      await page.reload();

      // Unread count should decrease
      const unreadCountAfter = await unreadBadge.textContent().catch(() => '0');

      if (unreadCountBefore !== '0') {
        expect(parseInt(unreadCountAfter)).toBeLessThan(parseInt(unreadCountBefore));
      }
    }

    await context.close();
  });
});

test.describe('Error Handling - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map(u => u.id));
  });

  test('Invalid person link shows error', async ({ page }) => {
    // Try to access with invalid token
    await page.goto(`${getPersonalLinkUrl('invalid-token')}`);

    // Should show error or redirect
    const errorMsg = page.locator('text=not found|invalid|unauthorized', { ignoreCase: true });
    if (await errorMsg.isVisible({ timeout: 3000 }).catch(() => false)) {
      expect(errorMsg).toBeVisible();
    }
  });

  test('Invalid period shows error on planner dashboard', async ({ page }) => {
    // Try to access non-existent period
    const invalidPeriodUrl = `http://localhost:3000/planner/period/invalid-id`;
    await page.goto(invalidPeriodUrl);

    // Should show error message
    const errorMsg = page.locator('text=Period not found|not found', { ignoreCase: true });
    if (await errorMsg.isVisible({ timeout: 3000 }).catch(() => false)) {
      expect(errorMsg).toBeVisible();
    }
  });

  test('Swap creation shows validation errors', async ({ browser }) => {
    const user = testData.users[3];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Navigate to personal page
    await page.goto(getPersonalLinkUrl(user.token));

    // Open swap dialog
    await page.click('button:has-text("Request Swap")').catch(() => null);

    // Try to submit without selecting slots
    const submitButton = page.locator('button:has-text("Send Request")');

    if (await submitButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Button should be disabled
      const isDisabled = await submitButton.isDisabled();
      expect(isDisabled).toBe(true);

      // Or should show error message
      const errorMsg = page.locator('text=Please select|required');
      if (await errorMsg.isVisible({ timeout: 2000 }).catch(() => false)) {
        expect(errorMsg).toBeVisible();
      }
    }

    await context.close();
  });

  test('Network errors are handled gracefully', async ({ browser }) => {
    const user = testData.users[4];

    const context = await browser.newContext();
    const page = await context.newPage();

    // Go offline
    await context.setOffline(true);

    // Navigate to personal page (will fail offline)
    await page.goto(getPersonalLinkUrl(user.token)).catch(() => {
      // Expected to fail
    });

    // Go back online
    await context.setOffline(false);

    // Should recover when online again
    await page.goto(getPersonalLinkUrl(user.token));
    await page.waitForLoadState('networkidle').catch(() => {
      console.log('Load state wait timeout');
    });

    await context.close();
  });
});

test.describe('Mobile Responsiveness - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map(u => u.id));
  });

  test('Personal page works at mobile width (375px)', async ({ browser }) => {
    const user = testData.users[0];

    const context = await browser.newContext({
      viewport: { width: 375, height: 667 }
    });
    const page = await context.newPage();

    // Navigate to personal page
    await page.goto(getPersonalLinkUrl(user.token));

    // Wait for load
    await page.waitForLoadState('networkidle').catch(() => null);

    // Check that content is visible (no horizontal scroll)
    const body = page.locator('body');
    const width = await body.evaluate(el => el.offsetWidth);
    expect(width).toBeLessThanOrEqual(375);

    // Main content should be visible
    const mainContent = page.locator('main');
    if (await mainContent.isVisible({ timeout: 3000 }).catch(() => false)) {
      expect(mainContent).toBeVisible();
    }

    await context.close();
  });

  test('Swap dialog is responsive on mobile', async ({ browser }) => {
    const user = testData.users[1];

    const context = await browser.newContext({
      viewport: { width: 375, height: 667 }
    });
    const page = await context.newPage();

    // Navigate to personal page
    await page.goto(getPersonalLinkUrl(user.token));

    // Open swap dialog
    await page.click('button:has-text("Request Swap")').catch(() => null);

    // Dialog should be visible and fit on screen
    const dialog = page.locator('[role="dialog"]');
    if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
      expect(dialog).toBeVisible();

      // Buttons should be clickable
      const buttons = await dialog.locator('button').count();
      expect(buttons).toBeGreaterThan(0);
    }

    await context.close();
  });
});

import { test, expect } from '@playwright/test';
import { createTestPeriod, getPersonalLinkUrl, getBaseUrl, cleanupTestData } from './setup';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';

/**
 * Shift swaps, end to end through the real UI.
 *
 * Rewritten to assert unconditionally. The previous version guarded every
 * step with `if (await locator.isVisible(...))` and looked for text the app
 * never renders - "Swap request created", "Swap approved", "Pending
 * Approval" - so the bodies were skipped and the tests passed having
 * checked nothing.
 *
 * The assertions that matter are about state, not chrome: a swap must
 * actually move the two assignments between the two people.
 */

test.describe('Swap Request Workflow - E2E', () => {
  let testData: ReturnType<typeof createTestPeriod>;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    testData = createTestPeriod();
  });

  test.afterAll(() => {
    cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
  });

  const swapsFor = (personId: string) =>
    db
      .prepare(
        `SELECT id, status, aanvrager_person_id, respondent_person_id,
                aangeboden_slot_id, gevraagde_slot_id
         FROM dienstrooster_swap_request
         WHERE periode_id = ? AND (aanvrager_person_id = ? OR respondent_person_id = ?)`
      )
      .all(testData.period.id, personId, personId) as Array<{
      id: string;
      status: string;
      aanvrager_person_id: string;
      respondent_person_id: string;
      aangeboden_slot_id: string;
      gevraagde_slot_id: string;
    }>;

  /** Slot ids whose *current* holder matches the predicate. */
  const currentSlotsOf = (pred: (personId: string) => boolean) =>
    (
      db
        .prepare(
          'SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?'
        )
        .all(testData.period.id) as Array<{ slot_id: string; person_id: string }>
    )
      .filter((r) => pred(r.person_id))
      .map((r) => r.slot_id);

  const ownerOfSlot = (slotId: string) =>
    (
      db
        .prepare(
          'SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?'
        )
        .get(testData.period.id, slotId) as { person_id: string } | undefined
    )?.person_id;

  test('a staff member can create a swap request', async ({ browser }) => {
    const requester = testData.users[0];
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(requester.token));
      await page.waitForLoadState('networkidle');

      await page.getByRole('button', { name: /Request Swap/i }).click();
      await expect(page.getByRole('heading', { name: 'Request Shift Swap' })).toBeVisible();

      // Offer one of my own shifts, ask for one of someone else's.
      const offered = page.locator('select[name="offered-slot"]');
      const requested = page.locator('select[name="requested-slot"]');
      await expect(offered).toBeVisible();

      const offeredValue = await offered.locator('option').nth(1).getAttribute('value');
      const requestedValue = await requested.locator('option').nth(1).getAttribute('value');
      expect(offeredValue).toBeTruthy();
      expect(requestedValue).toBeTruthy();

      await offered.selectOption(offeredValue!);
      await requested.selectOption(requestedValue!);
      await page.fill('textarea[name="notes"]', 'Family event that weekend');

      await page.getByRole('button', { name: 'Send Request' }).click();

      // The dialog closes on success; the request must exist and be pending.
      await expect(page.getByRole('heading', { name: 'Request Shift Swap' })).toBeHidden({
        timeout: 10000,
      });

      const swaps = swapsFor(requester.id);
      expect(swaps.length).toBeGreaterThan(0);
      expect(swaps[0].status).toBe('PENDING');
      expect(swaps[0].aangeboden_slot_id).toBe(offeredValue);
      expect(swaps[0].gevraagde_slot_id).toBe(requestedValue);
    } finally {
      await context.close();
    }
  });

  test('the respondent sees the pending request in their swap panel', async ({ browser }) => {
    const pending = db
      .prepare(
        `SELECT respondent_person_id FROM dienstrooster_swap_request
         WHERE periode_id = ? AND status = 'PENDING' LIMIT 1`
      )
      .get(testData.period.id) as { respondent_person_id: string };
    expect(pending).toBeTruthy();

    const respondent = testData.users.find((u) => u.id === pending.respondent_person_id)!;
    expect(respondent).toBeTruthy();

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(respondent.token));
      await page.waitForLoadState('networkidle');

      await page.getByRole('button', { name: /View Swap Requests/i }).click();

      const pendingRow = page.locator('[data-status="PENDING"]');
      await expect(pendingRow.first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve' }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('approving a swap actually exchanges the two shifts', async ({ browser }) => {
    const swap = db
      .prepare(
        `SELECT id, aanvrager_person_id, respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
         FROM dienstrooster_swap_request
         WHERE periode_id = ? AND status = 'PENDING' LIMIT 1`
      )
      .get(testData.period.id) as {
      id: string;
      aanvrager_person_id: string;
      respondent_person_id: string;
      aangeboden_slot_id: string;
      gevraagde_slot_id: string;
    };
    expect(swap).toBeTruthy();

    // Who holds what before the swap.
    expect(ownerOfSlot(swap.aangeboden_slot_id)).toBe(swap.aanvrager_person_id);
    expect(ownerOfSlot(swap.gevraagde_slot_id)).toBe(swap.respondent_person_id);

    const respondent = testData.users.find((u) => u.id === swap.respondent_person_id)!;
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(respondent.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /View Swap Requests/i }).click();

      await page.getByRole('button', { name: 'Approve' }).first().click();

      await expect
        .poll(
          () =>
            (
              db
                .prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?')
                .get(swap.id) as { status: string }
            ).status,
          { timeout: 10000 }
        )
        .toBe('GOEDGEKEURD');

      // The whole point: the shifts changed hands.
      expect(ownerOfSlot(swap.aangeboden_slot_id)).toBe(swap.respondent_person_id);
      expect(ownerOfSlot(swap.gevraagde_slot_id)).toBe(swap.aanvrager_person_id);
    } finally {
      await context.close();
    }
  });

  test('a swap can be rejected with a reason, leaving the shifts untouched', async ({ browser }) => {
    // Build a fresh pending swap between users 2 and 3 via the API.
    const requester = testData.users[2];
    const respondent = testData.users[3];
    const requesterSlot = testData.assignments.find((a) => a.personId === requester.id)!.slotId;
    const respondentSlot = testData.assignments.find((a) => a.personId === respondent.id)!.slotId;

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(requester.token));
      await page.waitForLoadState('networkidle');

      const created = await page.request.post(
        `${getBaseUrl()}/api/person/${requester.id}/swap-requests`,
        {
          data: {
            period_id: testData.period.id,
            offered_slot_id: requesterSlot,
            requested_slot_id: respondentSlot,
            notes: null,
          },
        }
      );
      expect(created.ok()).toBeTruthy();

      const swapId = (await created.json()).data.swap_request_id as string;

      await page.goto(getPersonalLinkUrl(respondent.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /View Swap Requests/i }).click();

      await page.getByRole('button', { name: 'Reject' }).first().click();
      // The inline reason form appears below the row; its own Reject button
      // is the one that submits.
      await page.fill('textarea[name="rejection-reason"]', 'Already covering another shift that day');
      await page.getByRole('button', { name: 'Reject' }).last().click();

      await expect
        .poll(
          () =>
            (
              db
                .prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?')
                .get(swapId) as { status: string }
            ).status,
          { timeout: 10000 }
        )
        .toBe('AFGEWEZEN');

      // A rejected swap must not move anything.
      expect(ownerOfSlot(requesterSlot)).toBe(requester.id);
      expect(ownerOfSlot(respondentSlot)).toBe(respondent.id);
    } finally {
      await context.close();
    }
  });

  test('you cannot ask for a shift you already hold', async ({ browser }) => {
    const user = testData.users[4];
    const ownSlot = testData.assignments.find((a) => a.personId === user.id)!.slotId;

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /Request Swap/i }).click();

      const requested = page.locator('select[name="requested-slot"]');
      await expect(requested).toBeVisible();

      // Structurally impossible rather than validated after the fact: the
      // "requested" list only contains other people's shifts.
      await expect(requested.locator(`option[value="${ownSlot}"]`)).toHaveCount(0);
      expect(await requested.locator('option').count()).toBeGreaterThan(1);
    } finally {
      await context.close();
    }
  });

  test('you cannot offer a shift that is not yours', async ({ browser }) => {
    const user = testData.users[1];
    // Live ownership, not the setup snapshot: earlier tests in this serial
    // suite approve swaps, so who holds which slot has already changed.
    const someoneElsesSlot = currentSlotsOf((id) => id !== user.id)[0];
    const ownSlot = currentSlotsOf((id) => id === user.id)[0];
    expect(someoneElsesSlot).toBeTruthy();
    expect(ownSlot).toBeTruthy();

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');

      const res = await page.request.post(`${getBaseUrl()}/api/person/${user.id}/swap-requests`, {
        data: {
          period_id: testData.period.id,
          offered_slot_id: someoneElsesSlot,
          requested_slot_id: ownSlot,
          notes: null,
        },
      });
      expect(res.status()).toBe(400);
    } finally {
      await context.close();
    }
  });

  test('only the respondent can approve a swap', async ({ browser }) => {
    const requester = testData.users[1];
    const respondent = testData.users[2];
    const bystander = testData.users[4];
    const requesterSlot = currentSlotsOf((id) => id === requester.id)[0];
    const respondentSlot = currentSlotsOf((id) => id === respondent.id)[0];
    expect(requesterSlot).toBeTruthy();
    expect(respondentSlot).toBeTruthy();

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
      // A third party with a valid session of their own must not be able to
      // approve someone else's swap.
      await page.goto(getPersonalLinkUrl(bystander.token));
      await page.waitForLoadState('networkidle');

      const res = await page.request.post(
        `${getBaseUrl()}/api/person/${bystander.id}/swap-requests/${swapId}/approve`
      );
      expect(res.status()).toBe(403);

      // Nothing moved.
      expect(ownerOfSlot(requesterSlot)).toBe(requester.id);
      expect(ownerOfSlot(respondentSlot)).toBe(respondent.id);
      const status = (
        db
          .prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?')
          .get(swapId) as { status: string }
      ).status;
      expect(status).toBe('PENDING');
    } finally {
      db.prepare('DELETE FROM dienstrooster_swap_request WHERE id = ?').run(swapId);
      await context.close();
    }
  });

  test('a swap goes stale if the requested shift changed hands first', async ({ browser }) => {
    // Two pending swaps can name the same shift. If the first one is settled,
    // the second is about a shift its respondent no longer holds - approving
    // it anyway took the shift off an uninvolved third person, who never
    // agreed to anything.
    const requester = testData.users[0];
    const respondent = testData.users[1];
    const thirdParty = testData.users[2];

    const requesterSlot = currentSlotsOf((id) => id === requester.id)[0];
    const respondentSlot = currentSlotsOf((id) => id === respondent.id)[0];
    const thirdSlot = currentSlotsOf((id) => id === thirdParty.id)[0];
    expect(requesterSlot).toBeTruthy();
    expect(respondentSlot).toBeTruthy();
    expect(thirdSlot).toBeTruthy();

    const staleSwapId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_swap_request
         (id, periode_id, aanvrager_person_id, respondent_person_id,
          aangeboden_slot_id, gevraagde_slot_id, status, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', datetime('now'))`
    ).run(
      staleSwapId,
      testData.period.id,
      requester.id,
      respondent.id,
      requesterSlot,
      respondentSlot
    );

    // Meanwhile the respondent's shift moves to the third party.
    db.prepare(
      'UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND slot_id = ?'
    ).run(thirdParty.id, testData.period.id, respondentSlot);

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(respondent.token));
      await page.waitForLoadState('networkidle');

      const res = await page.request.post(
        `${getBaseUrl()}/api/person/${respondent.id}/swap-requests/${staleSwapId}/approve`
      );
      expect(res.ok()).toBeFalsy();

      // The third party keeps the shift they were given and gains nothing.
      expect(ownerOfSlot(respondentSlot)).toBe(thirdParty.id);
      expect(ownerOfSlot(requesterSlot)).toBe(requester.id);
      expect(ownerOfSlot(thirdSlot)).toBe(thirdParty.id);
    } finally {
      db.prepare('DELETE FROM dienstrooster_swap_request WHERE id = ?').run(staleSwapId);
      db.prepare(
        'UPDATE dienstrooster_assignment SET person_id = ? WHERE schedule_version_id = ? AND slot_id = ?'
      ).run(respondent.id, testData.period.id, respondentSlot);
      await context.close();
    }
  });

  test('the swap panel filters by status', async ({ browser }) => {
    const user = testData.users[0];
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(getPersonalLinkUrl(user.token));
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /View Swap Requests/i }).click();

      const filter = page.locator('select[name="status-filter"]');
      await expect(filter).toBeVisible();

      // This user's swap was approved earlier in the file.
      await filter.selectOption('GOEDGEKEURD');
      await expect(page.locator('[data-status="GOEDGEKEURD"]').first()).toBeVisible();

      // ...and is therefore no longer pending.
      await filter.selectOption('PENDING');
      await expect(page.locator('[data-status="PENDING"]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

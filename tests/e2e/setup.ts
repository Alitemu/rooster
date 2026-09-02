/**
 * E2E Test Setup Utilities
 *
 * Provides seeded data, authentication tokens, and URL helpers for E2E tests
 */

import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import type { Page } from '@playwright/test';
import { generateAccessToken, hashToken, hashPassword } from '@/lib/auth';

interface TestUser {
  id: string;
  codenaam: string;
  token: string;
}

interface TestData {
  period: { id: string; name: string; status: string };
  users: TestUser[];
  slots: Array<{ id: string; datum: string; type: string }>;
  assignments: Array<{ id: string; personId: string; slotId: string }>;
}

/**
 * Create test users and return working personal access link tokens.
 * When periodId is given, each link is scoped to that period (matching how
 * real invitation links are created) so /api/auth/verify-link resolves it
 * directly instead of falling back to auto-detecting an OPEN period.
 */
export function createTestUsers(count: number = 5, periodId?: string): TestUser[] {
  const users: TestUser[] = [];

  for (let i = 0; i < count; i++) {
    const id = uuid();
    const codenaam = `E2ETest-${Date.now()}-${i}`;
    const token = generateAccessToken();

    db.prepare(`
      INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))
    `).run(id, codenaam);

    db.prepare(`
      INSERT INTO dienstrooster_person_access_link
        (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(uuid(), id, periodId ?? null, hashToken(token));

    users.push({ id, codenaam, token });
  }

  return users;
}

/**
 * Create a test period with slots and assignments.
 *
 * `status` matters: the planner dashboard only offers "Publish Roster" for a
 * GEGENEREERD period, so publication tests have to start there. Defaults to
 * GEPUBLICEERD, which is what the staff-facing tests need.
 */
export function createTestPeriod(status: string = 'GEPUBLICEERD'): TestData {
  const periodId = uuid();
  const timestamp = Date.now();

  // Get existing pool ID from database
  const pool = db.prepare(`SELECT id FROM dienstrooster_pool LIMIT 1`).get() as any;
  if (!pool) {
    throw new Error('No pool found in database. Run npm run seed first.');
  }

  // Create period
  db.prepare(`
    INSERT INTO dienstrooster_schedule_period (
      id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(periodId, pool.id, `E2E-Period-${timestamp}`, status,
    '2027-01-04', '2027-01-10', '2026-12-31T23:59:59Z');

  // Create test users
  const users = createTestUsers(5, periodId);

  // Put them in the pool: anything scoped to pool membership (the planner
  // dashboard's progress list, band compliance in publication-check) skips
  // people who aren't members, which would make those views silently empty.
  for (const user of users) {
    db.prepare(`
      INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
      VALUES (?, ?, ?, '2020-01-01', '2030-12-31')
    `).run(uuid(), user.id, pool.id);
  }

  // Get shift type IDs
  const shiftTypes = db.prepare(`SELECT id, teller FROM dienstrooster_shift_type`).all() as Array<{ id: string; teller: string }>;
  const eveningShiftType = shiftTypes.find(s => s.teller === 'AVOND') || shiftTypes[0];
  const weekendShiftType = shiftTypes.find(s => s.teller === 'WEEKEND') || shiftTypes[1];

  // Create slots
  const slots: Array<{ id: string; datum: string; type: string }> = [];
  for (let i = 0; i < 7; i++) {
    const slotId = uuid();
    const datum = `2027-01-${String(4 + i).padStart(2, '0')}`;
    const shiftTypeId = i % 3 === 0 ? weekendShiftType.id : eveningShiftType.id;

    db.prepare(`
      INSERT INTO dienstrooster_shift_slot (
        id, period_id, datum, iso_jaar, iso_week, shift_type_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(slotId, periodId, datum, 2027, 1, shiftTypeId);

    slots.push({ id: slotId, datum, type: i % 3 === 0 ? 'WEEKEND' : 'AVOND' });
  }

  // Create assignments
  const assignments: Array<{ id: string; personId: string; slotId: string }> = [];
  for (let i = 0; i < slots.length; i++) {
    const assignmentId = uuid();
    const personId = users[i % users.length].id;
    const slotId = slots[i].id;

    db.prepare(`
      INSERT INTO dienstrooster_assignment (
        id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(assignmentId, periodId, personId, slotId, 'SOLVER', 1);

    assignments.push({ id: assignmentId, personId, slotId });
  }

  return {
    period: { id: periodId, name: `E2E-Period-${timestamp}`, status },
    users,
    slots,
    assignments
  };
}

/**
 * Get base URL for E2E tests
 */
export function getBaseUrl(): string {
  return process.env.E2E_BASE_URL || 'http://localhost:3000';
}

/**
 * Log in as the seeded PLANNER account (see scripts/seed.ts) so the page's
 * browser context carries a valid staff session cookie. Planner pages are
 * protected by middleware.ts and their data comes from routes gated by
 * requirePlannerAccess, so tests that visit /planner/* must call this first.
 */
export async function loginAsPlanner(page: Page): Promise<void> {
  const codenaam = process.env.E2E_PLANNER_CODENAAM || 'PLANNER';
  // Must match DEFAULT_TEST_PASSWORD in scripts/seed.ts, which PLANNER is
  // seeded with directly.
  const password = process.env.E2E_PLANNER_PASSWORD || 'Password123!';

  // Fallback only - PLANNER is normally already seeded with the password
  // above (scripts/seed.ts). This just covers a database that predates
  // that (wachtwoord_hash still NULL), writing the hash straight into the
  // DB rather than calling the first-run-setup API, which keeps this fast
  // and skips the setup UI entirely - that flow gets its own coverage in
  // scripts/full-check.mjs.
  const existing = db
    .prepare(`SELECT wachtwoord_hash FROM dienstrooster_person WHERE codenaam = ?`)
    .get(codenaam) as { wachtwoord_hash: string | null } | undefined;
  if (existing && existing.wachtwoord_hash === null) {
    const hash = await hashPassword(password);
    db.prepare(`UPDATE dienstrooster_person SET wachtwoord_hash = ? WHERE codenaam = ?`).run(hash, codenaam);
  }

  const res = await page.request.post(`${getBaseUrl()}/api/auth/staff-login`, {
    data: { codenaam, password },
  });

  if (!res.ok()) {
    throw new Error(
      `E2E staff login failed (${res.status()}): run npm run seed, or set E2E_PLANNER_CODENAAM/E2E_PLANNER_PASSWORD`
    );
  }
}

/**
 * Get personal link URL for a user
 */
export function getPersonalLinkUrl(token: string): string {
  return `${getBaseUrl()}/person/${token}`;
}

/**
 * Clean up test data
 */
export function cleanupTestData(periodId: string, userIds: string[]): void {
  // Delete all Phase 3 related data
  db.prepare('DELETE FROM dienstrooster_swap_request WHERE periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);

  // Delete test users (access links and audit log entries first - approving
  // or rejecting a swap writes an audit_log row with actor_id = the acting
  // user, which would otherwise block the person delete below)
  for (const userId of userIds) {
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE person_id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(userId);
  }

  db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
}

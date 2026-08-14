/**
 * E2E Test Setup Utilities
 *
 * Provides seeded data, authentication tokens, and URL helpers for E2E tests
 */

import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';

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
 * Create test users and return authentication tokens
 */
export function createTestUsers(count: number = 5): TestUser[] {
  const users: TestUser[] = [];

  for (let i = 0; i < count; i++) {
    const id = uuid();
    const codenaam = `E2ETest-${Date.now()}-${i}`;
    const token = uuid(); // In real setup, would generate proper token

    db.prepare(`
      INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))
    `).run(id, codenaam);

    users.push({ id, codenaam, token });
  }

  return users;
}

/**
 * Create a test period with slots and assignments
 */
export function createTestPeriod(): TestData {
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
  `).run(periodId, pool.id, `E2E-Period-${timestamp}`, 'GEPUBLICEERD',
    '2027-01-04', '2027-01-10', '2026-12-31T23:59:59Z');

  // Create test users
  const users = createTestUsers(5);

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
    period: { id: periodId, name: `E2E-Period-${timestamp}`, status: 'GEPUBLICEERD' },
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
  db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);

  // Delete test users
  for (const userId of userIds) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(userId);
  }
}

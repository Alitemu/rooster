/**
 * Phase 3 Database Setup
 *
 * Ensures all Phase 3 tables and columns exist
 * Runs on test setup to ensure schema is complete
 */

import { db } from '@/db/client';

export function setupPhase3Tables() {
  try {
    // Verify swap_request table exists
    db.prepare(`
      CREATE TABLE IF NOT EXISTS dienstrooster_swap_request (
        id TEXT PRIMARY KEY,
        periode_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN')),
        aangemaakt_op TEXT NOT NULL,
        aanvrager_person_id TEXT NOT NULL,
        respondent_person_id TEXT NOT NULL,
        aangeboden_slot_id TEXT NOT NULL,
        gevraagde_slot_id TEXT NOT NULL,
        beantwoord_op TEXT,
        afgehandeld_door_person_id TEXT,
        opmerkingen TEXT,
        FOREIGN KEY (periode_id) REFERENCES dienstrooster_schedule_period(id),
        FOREIGN KEY (aanvrager_person_id) REFERENCES dienstrooster_person(id),
        FOREIGN KEY (respondent_person_id) REFERENCES dienstrooster_person(id),
        FOREIGN KEY (aangeboden_slot_id) REFERENCES dienstrooster_shift_slot(id),
        FOREIGN KEY (gevraagde_slot_id) REFERENCES dienstrooster_shift_slot(id)
      )
    `).run();

    // Verify notification table exists
    db.prepare(`
      CREATE TABLE IF NOT EXISTS dienstrooster_notification (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        periode_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'PUBLICATIE_BERICHT')),
        onderwerp TEXT NOT NULL,
        inhoud TEXT NOT NULL,
        gelezen INTEGER NOT NULL DEFAULT 0,
        aangemaakt_op TEXT NOT NULL,
        FOREIGN KEY (person_id) REFERENCES dienstrooster_person(id),
        FOREIGN KEY (periode_id) REFERENCES dienstrooster_schedule_period(id)
      )
    `).run();

    // Verify assignment_edit table exists
    db.prepare(`
      CREATE TABLE IF NOT EXISTS dienstrooster_assignment_edit (
        id TEXT PRIMARY KEY,
        toewijzing_id TEXT NOT NULL,
        periode_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        edit_type TEXT NOT NULL CHECK (edit_type IN ('HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE')),
        reden TEXT,
        bewerkt_door_person_id TEXT NOT NULL,
        aangemaakt_op TEXT NOT NULL,
        row_version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (periode_id) REFERENCES dienstrooster_schedule_period(id),
        FOREIGN KEY (person_id) REFERENCES dienstrooster_person(id),
        FOREIGN KEY (slot_id) REFERENCES dienstrooster_shift_slot(id)
      )
    `).run();

    // Verify schedule_period has publication columns
    const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
    const hasGepubliceerdOp = periodInfo.some(col => col.name === 'gepubliceerd_op');
    const hasGepubliceerdDoor = periodInfo.some(col => col.name === 'gepubliceerd_door_person_id');

    if (!hasGepubliceerdOp) {
      db.prepare(`
        ALTER TABLE dienstrooster_schedule_period ADD COLUMN gepubliceerd_op TEXT
      `).run();
    }

    if (!hasGepubliceerdDoor) {
      db.prepare(`
        ALTER TABLE dienstrooster_schedule_period ADD COLUMN gepubliceerd_door_person_id TEXT
      `).run();
    }

    return { success: true, message: 'Phase 3 tables verified/created' };
  } catch (error) {
    console.error('Phase 3 database setup error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Verify all Phase 3 tables exist and are ready
 */
export function verifyPhase3Schema(): {
  valid: boolean;
  tables: { [key: string]: boolean };
  messages: string[];
} {
  const messages: string[] = [];
  const tables: { [key: string]: boolean } = {};

  try {
    // Check swap_request table
    const swapTableCheck = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_swap_request'
    `).get();
    tables['swap_request'] = Boolean(swapTableCheck);
    if (!swapTableCheck) messages.push('❌ swap_request table missing');

    // Check notification table
    const notifTableCheck = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_notification'
    `).get();
    tables['notification'] = Boolean(notifTableCheck);
    if (!notifTableCheck) messages.push('❌ notification table missing');

    // Check assignment_edit table
    const editTableCheck = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_assignment_edit'
    `).get();
    tables['assignment_edit'] = Boolean(editTableCheck);
    if (!editTableCheck) messages.push('❌ assignment_edit table missing');

    // Check period columns
    const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
    const hasGepubliceerdOp = periodInfo.some(col => col.name === 'gepubliceerd_op');
    const hasGepubliceerdDoor = periodInfo.some(col => col.name === 'gepubliceerd_door_person_id');

    tables['period_gepubliceerd_op'] = hasGepubliceerdOp;
    tables['period_gepubliceerd_door'] = hasGepubliceerdDoor;

    if (!hasGepubliceerdOp) messages.push('❌ period.gepubliceerd_op column missing');
    if (!hasGepubliceerdDoor) messages.push('❌ period.gepubliceerd_door_person_id column missing');

    const valid = Object.values(tables).every(Boolean);

    if (valid) {
      messages.push('✅ All Phase 3 tables and columns verified');
    }

    return { valid, tables, messages };
  } catch (error) {
    return {
      valid: false,
      tables,
      messages: [...messages, `❌ Verification error: ${String(error)}`],
    };
  }
}

/**
 * Clean up test Phase 3 data (for test isolation)
 */
export function cleanupPhase3TestData(periodId?: string, personIds?: string[]) {
  try {
    if (periodId) {
      // Clean specific period's Phase 3 data and related test records
      db.prepare('DELETE FROM dienstrooster_swap_request WHERE periode_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
    } else {
      // Clean all Phase 3 data
      db.prepare('DELETE FROM dienstrooster_swap_request').run();
      db.prepare('DELETE FROM dienstrooster_notification').run();
      db.prepare('DELETE FROM dienstrooster_assignment_edit').run();
    }

    // Clean test person records if provided
    if (personIds && personIds.length > 0) {
      for (const personId of personIds) {
        db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Cleanup error:', error);
    return { success: false, error: String(error) };
  }
}

/**
 * Clean up Phase 3 workflow data only (keep period/slots/people intact)
 * Used for test isolation when multiple tests share common setup
 */
export function cleanupPhase3WorkflowData(periodId: string) {
  try {
    db.prepare('DELETE FROM dienstrooster_swap_request WHERE periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);

    // Reset period status to GEGENEREERD for next test
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = 'GEGENEREERD', gepubliceerd_op = NULL, gepubliceerd_door_person_id = NULL
       WHERE id = ?`
    ).run(periodId);

    return { success: true };
  } catch (error) {
    console.error('Workflow cleanup error:', error);
    return { success: false, error: String(error) };
  }
}

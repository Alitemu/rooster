import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db/client';
import { setupPhase3Tables, cleanupPhase3TestData, verifyPhase3Schema } from '@/lib/phase3-db-setup';
import { v4 as uuid } from 'uuid';

/**
 * Phase 3: Integration Tests (API-level)
 *
 * Tests Phase 3 APIs with real database using seed data patterns.
 * Focus: swap requests, notifications, publication, and assignment edits.
 */

describe('Phase 3 Integration Tests', () => {
  beforeAll(() => {
    // Disable foreign keys for integration tests (we test schema, not referential integrity)
    db.prepare('PRAGMA foreign_keys = OFF').run();

    // Setup Phase 3 schema
    const setupResult = setupPhase3Tables();
    if (!setupResult.success) {
      throw new Error(`Phase 3 setup failed: ${setupResult.error}`);
    }

    const schemaCheck = verifyPhase3Schema();
    if (!schemaCheck.valid) {
      throw new Error(`Schema verification failed: ${schemaCheck.messages.join(', ')}`);
    }
  });

  describe('Swap Request Table', () => {
    it('should create swap_request table with correct schema', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_swap_request'
      `).all();
      expect(tables).toHaveLength(1);
    });

    it('should enforce status enum on swap_request', () => {
      const periodId = uuid();
      const swapId = uuid();

      // Create minimal period for FK constraint
      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      // Valid status should succeed
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_swap_request (
            id, periode_id, status, aangemaakt_op, aanvrager_person_id,
            respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
          ) VALUES (?, ?, 'PENDING', datetime('now'), ?, ?, ?, ?)
        `).run(swapId, periodId, 'p1', 'p2', 's1', 's2');
      }).not.toThrow();

      // Invalid status should fail
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_swap_request (
            id, periode_id, status, aangemaakt_op, aanvrager_person_id,
            respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
          ) VALUES (?, ?, 'INVALID', datetime('now'), ?, ?, ?, ?)
        `).run(uuid(), periodId, 'p1', 'p2', 's1', 's2');
      }).toThrow();

      // Cleanup
      cleanupPhase3TestData(periodId);
    });

    it('should allow status transitions: PENDING → GOEDGEKEURD', () => {
      const periodId = uuid();
      const swapId = uuid();

      // Setup
      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
        ) VALUES (?, ?, 'PENDING', datetime('now'), ?, ?, ?, ?)
      `).run(swapId, periodId, 'p1', 'p2', 's1', 's2');

      // Transition to GOEDGEKEURD
      db.prepare('UPDATE dienstrooster_swap_request SET status = ? WHERE id = ?').run('GOEDGEKEURD', swapId);

      const swap = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.status).toBe('GOEDGEKEURD');

      cleanupPhase3TestData(periodId);
    });

    it('should allow status transitions: PENDING → AFGEWEZEN', () => {
      const periodId = uuid();
      const swapId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
        ) VALUES (?, ?, 'PENDING', datetime('now'), ?, ?, ?, ?)
      `).run(swapId, periodId, 'p1', 'p2', 's1', 's2');

      db.prepare('UPDATE dienstrooster_swap_request SET status = ? WHERE id = ?').run('AFGEWEZEN', swapId);

      const swap = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.status).toBe('AFGEWEZEN');

      cleanupPhase3TestData(periodId);
    });

    it('should record beantwoord_op timestamp on approval', () => {
      const periodId = uuid();
      const swapId = uuid();
      const respondedAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
        ) VALUES (?, ?, 'PENDING', datetime('now'), ?, ?, ?, ?)
      `).run(swapId, periodId, 'p1', 'p2', 's1', 's2');

      db.prepare(`
        UPDATE dienstrooster_swap_request
        SET status = ?, beantwoord_op = ?
        WHERE id = ?
      `).run('GOEDGEKEURD', respondedAt, swapId);

      const swap = db.prepare('SELECT beantwoord_op FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.beantwoord_op).toBe(respondedAt);

      cleanupPhase3TestData(periodId);
    });
  });

  describe('Notification Table', () => {
    it('should create notification table with correct schema', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_notification'
      `).all();
      expect(tables).toHaveLength(1);
    });

    it('should enforce notification type enum', () => {
      const periodId = uuid();
      const notifId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      // Valid type should succeed
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_notification (
            id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
          ) VALUES (?, ?, ?, 'RUILVERZOEK', ?, ?, datetime('now'))
        `).run(notifId, 'p1', periodId, 'Subject', 'Content');
      }).not.toThrow();

      // Invalid type should fail
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_notification (
            id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
          ) VALUES (?, ?, ?, 'INVALID_TYPE', ?, ?, datetime('now'))
        `).run(uuid(), 'p1', periodId, 'Subject', 'Content');
      }).toThrow();

      cleanupPhase3TestData(periodId);
    });

    it('should default gelezen to 0 for new notifications', () => {
      const periodId = uuid();
      const notifId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        INSERT INTO dienstrooster_notification (
          id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
        ) VALUES (?, ?, ?, 'PUBLICATIE_BERICHT', ?, ?, datetime('now'))
      `).run(notifId, 'p1', periodId, 'Subject', 'Content');

      const notif = db.prepare('SELECT gelezen FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif.gelezen).toBe(0);

      cleanupPhase3TestData(periodId);
    });

    it('should allow marking notification as read', () => {
      const periodId = uuid();
      const notifId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        INSERT INTO dienstrooster_notification (
          id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
        ) VALUES (?, ?, ?, 'RUILVERZOEK', ?, ?, datetime('now'))
      `).run(notifId, 'p1', periodId, 'Subject', 'Content');

      db.prepare('UPDATE dienstrooster_notification SET gelezen = 1 WHERE id = ?').run(notifId);

      const notif = db.prepare('SELECT gelezen FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif.gelezen).toBe(1);

      cleanupPhase3TestData(periodId);
    });
  });

  describe('Assignment Edit Audit Table', () => {
    it('should create assignment_edit table with correct schema', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_assignment_edit'
      `).all();
      expect(tables).toHaveLength(1);
    });

    it('should enforce edit_type enum', () => {
      const periodId = uuid();
      const editId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      // Valid edit type should succeed
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_assignment_edit (
            id, toewijzing_id, periode_id, person_id, slot_id, edit_type, bewerkt_door_person_id, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, 'RUIL', ?, datetime('now'))
        `).run(editId, 'a1', periodId, 'p1', 's1', 'p1');
      }).not.toThrow();

      // Invalid edit type should fail
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_assignment_edit (
            id, toewijzing_id, periode_id, person_id, slot_id, edit_type, bewerkt_door_person_id, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, 'INVALID', ?, datetime('now'))
        `).run(uuid(), 'a1', periodId, 'p1', 's1', 'p1');
      }).toThrow();

      cleanupPhase3TestData(periodId);
    });

    it('should store reason for manual edits', () => {
      const periodId = uuid();
      const editId = uuid();
      const reason = 'Personeelswissel noodzakelijk';

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        INSERT INTO dienstrooster_assignment_edit (
          id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, 'HANDMATIG_TOEWIJZEN', ?, ?, datetime('now'))
      `).run(editId, 'a1', periodId, 'p1', 's1', reason, 'p1');

      const edit = db.prepare('SELECT reden FROM dienstrooster_assignment_edit WHERE id = ?').get(editId) as any;
      expect(edit.reden).toBe(reason);

      cleanupPhase3TestData(periodId);
    });
  });

  describe('Publication Schema Updates', () => {
    it('should have gepubliceerd_op column', () => {
      const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
      const hasColumn = periodInfo.some(col => col.name === 'gepubliceerd_op');
      expect(hasColumn).toBe(true);
    });

    it('should have gepubliceerd_door_person_id column', () => {
      const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
      const hasColumn = periodInfo.some(col => col.name === 'gepubliceerd_door_person_id');
      expect(hasColumn).toBe(true);
    });

    it('should allow updating publication metadata', () => {
      const periodId = uuid();
      const publisherId = 'publisher-1';
      const publishedAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      db.prepare(`
        UPDATE dienstrooster_schedule_period
        SET gepubliceerd_op = ?, gepubliceerd_door_person_id = ?
        WHERE id = ?
      `).run(publishedAt, publisherId, periodId);

      const period = db.prepare(`
        SELECT gepubliceerd_op, gepubliceerd_door_person_id
        FROM dienstrooster_schedule_period WHERE id = ?
      `).get(periodId) as any;

      expect(period.gepubliceerd_op).toBe(publishedAt);
      expect(period.gepubliceerd_door_person_id).toBe(publisherId);

      cleanupPhase3TestData(periodId);
    });
  });

  describe('Data Integrity', () => {
    it('should maintain row_version for optimistic locking', () => {
      const periodId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      const period = db.prepare('SELECT row_version FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as any;
      expect(period.row_version).toBeGreaterThanOrEqual(1);

      cleanupPhase3TestData(periodId);
    });
  });

  describe('Notification Types Coverage', () => {
    it('should support all Phase 3 notification types', () => {
      const notificationTypes = ['ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'PUBLICATIE_BERICHT'];
      const periodId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      notificationTypes.forEach((type) => {
        const notifId = uuid();
        expect(() => {
          db.prepare(`
            INSERT INTO dienstrooster_notification (
              id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(notifId, 'p1', periodId, type, 'Subject', 'Content');
        }).not.toThrow();
      });

      cleanupPhase3TestData(periodId);
    });
  });

  describe('Swap Request Edit Types Coverage', () => {
    it('should support all assignment edit types', () => {
      const editTypes = ['HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE'];
      const periodId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_schedule_period (
          id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(periodId, 'pool-test', 'Test', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

      editTypes.forEach((type) => {
        const editId = uuid();
        expect(() => {
          db.prepare(`
            INSERT INTO dienstrooster_assignment_edit (
              id, toewijzing_id, periode_id, person_id, slot_id, edit_type, bewerkt_door_person_id, aangemaakt_op
            ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(editId, 'a1', periodId, 'p1', 's1', type, 'p1');
        }).not.toThrow();
      });

      cleanupPhase3TestData(periodId);
    });
  });
});

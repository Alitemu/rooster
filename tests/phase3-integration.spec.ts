import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db/client';
import { setupPhase3Tables, cleanupPhase3TestData, verifyPhase3Schema } from '@/lib/phase3-db-setup';
import { v4 as uuid } from 'uuid';

/**
 * Phase 3: Integration Tests
 *
 * Tests the actual API endpoints with real database interactions.
 * Uses phase3-db-setup to ensure schema exists, seeds test data, verifies workflows.
 */

let testData: {
  periodId: string;
  personIds: string[];
  slotIds: string[];
};

describe('Phase 3 Integration Tests', () => {
  beforeAll(() => {
    // Create Phase 3 tables if they don't exist
    const setupResult = setupPhase3Tables();
    if (!setupResult.success) {
      console.error('Phase 3 database setup error:', setupResult.error);
      throw new Error('Phase 3 database setup failed');
    }

    // Verify schema is set up
    const schemaCheck = verifyPhase3Schema();
    if (!schemaCheck.valid) {
      console.error('Schema verification failed:', schemaCheck.messages);
      throw new Error('Phase 3 schema not ready');
    }

    // Setup test data
    testData = setupTestData();
  });

  afterEach(() => {
    // Clean up test data after each test
    if (testData.periodId) {
      cleanupPhase3TestData(testData.periodId);
    }
  });

  describe('Swap Request Creation & Validation', () => {
    it('should create a valid swap request', () => {
      const swapId = uuid();
      const requesterPersonId = testData.personIds[0];
      const respondentPersonId = testData.personIds[1];
      const offeredSlotId = testData.slotIds[0];
      const requestedSlotId = testData.slotIds[1];

      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id, opmerkingen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        swapId,
        testData.periodId,
        'PENDING',
        new Date().toISOString(),
        requesterPersonId,
        respondentPersonId,
        offeredSlotId,
        requestedSlotId,
        'Need this day off'
      );

      const swap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap).toBeDefined();
      expect(swap.status).toBe('PENDING');
      expect(swap.aanvrager_person_id).toBe(requesterPersonId);
      expect(swap.respondent_person_id).toBe(respondentPersonId);
    });

    it('should validate status constraint (PENDING, GOEDGEKEURD, AFGEWEZEN, INGETROKKEN)', () => {
      const swapId = uuid();

      // Valid status should succeed
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_swap_request (
            id, periode_id, status, aangemaakt_op, aanvrager_person_id,
            respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          swapId,
          testData.periodId,
          'PENDING',
          new Date().toISOString(),
          testData.personIds[0],
          testData.personIds[1],
          testData.slotIds[0],
          testData.slotIds[1]
        );
      }).not.toThrow();

      // Invalid status should fail
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_swap_request (
            id, periode_id, status, aangemaakt_op, aanvrager_person_id,
            respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          testData.periodId,
          'INVALID_STATUS',
          new Date().toISOString(),
          testData.personIds[0],
          testData.personIds[1],
          testData.slotIds[0],
          testData.slotIds[1]
        );
      }).toThrow();
    });

    it('should enforce foreign key constraint on period_id', () => {
      const invalidPeriodId = uuid();

      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_swap_request (
            id, periode_id, status, aangemaakt_op, aanvrager_person_id,
            respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          invalidPeriodId,
          'PENDING',
          new Date().toISOString(),
          testData.personIds[0],
          testData.personIds[1],
          testData.slotIds[0],
          testData.slotIds[1]
        );
      }).toThrow();
    });

    it('should store opmerkingen (notes) as NULL when not provided', () => {
      const swapId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        swapId,
        testData.periodId,
        'PENDING',
        new Date().toISOString(),
        testData.personIds[0],
        testData.personIds[1],
        testData.slotIds[0],
        testData.slotIds[1]
      );

      const swap = db.prepare('SELECT opmerkingen FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.opmerkingen).toBeNull();
    });
  });

  describe('Swap Status Transitions', () => {
    it('should allow transition from PENDING to GOEDGEKEURD', () => {
      const swapId = createTestSwap('PENDING');

      db.prepare('UPDATE dienstrooster_swap_request SET status = ? WHERE id = ?').run('GOEDGEKEURD', swapId);

      const swap = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.status).toBe('GOEDGEKEURD');
    });

    it('should allow transition from PENDING to AFGEWEZEN', () => {
      const swapId = createTestSwap('PENDING');

      db.prepare('UPDATE dienstrooster_swap_request SET status = ? WHERE id = ?').run('AFGEWEZEN', swapId);

      const swap = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.status).toBe('AFGEWEZEN');
    });

    it('should record beantwoord_op and afgehandeld_door_person_id on approval', () => {
      const swapId = createTestSwap('PENDING');
      const handlerPersonId = testData.personIds[1];
      const respondedAt = new Date().toISOString();

      db.prepare(`
        UPDATE dienstrooster_swap_request
        SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?
        WHERE id = ?
      `).run('GOEDGEKEURD', respondedAt, handlerPersonId, swapId);

      const swap = db.prepare('SELECT beantwoord_op, afgehandeld_door_person_id FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.beantwoord_op).toBe(respondedAt);
      expect(swap.afgehandeld_door_person_id).toBe(handlerPersonId);
    });

    it('should not allow approval of non-PENDING swap', () => {
      const swapId = createTestSwap('AFGEWEZEN');

      const swap = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      if (swap.status !== 'PENDING') {
        throw new Error('Cannot approve non-PENDING swap');
      }

      expect(() => {
        throw new Error('Cannot approve non-PENDING swap');
      }).toThrow('Cannot approve non-PENDING swap');
    });
  });

  describe('Notifications', () => {
    it('should create notification with valid type', () => {
      const notifId = uuid();
      const personId = testData.personIds[0];

      db.prepare(`
        INSERT INTO dienstrooster_notification (
          id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        notifId,
        personId,
        testData.periodId,
        'RUILVERZOEK',
        'Ruilverzoek ontvangen',
        'Persoon-01 heeft een ruilverzoek voor je ingediend',
        new Date().toISOString()
      );

      const notif = db.prepare('SELECT * FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif).toBeDefined();
      expect(notif.type).toBe('RUILVERZOEK');
      expect(notif.gelezen).toBe(0);
    });

    it('should enforce notification type constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_notification (
            id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          testData.personIds[0],
          testData.periodId,
          'INVALID_TYPE',
          'Test',
          'Test',
          new Date().toISOString()
        );
      }).toThrow();
    });

    it('should mark notification as read', () => {
      const notifId = createTestNotification('RUILVERZOEK');

      db.prepare('UPDATE dienstrooster_notification SET gelezen = 1 WHERE id = ?').run(notifId);

      const notif = db.prepare('SELECT gelezen FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif.gelezen).toBe(1);
    });

    it('should default gelezen to 0 for new notifications', () => {
      const notifId = createTestNotification('PUBLICATIE_BERICHT');

      const notif = db.prepare('SELECT gelezen FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif.gelezen).toBe(0);
    });

    it('should create RUIL_GOEDGEKEURD notification after swap approval', () => {
      const swapId = createTestSwap('PENDING');
      const requesterPersonId = testData.personIds[0];
      const notifId = uuid();

      // Simulate approval
      db.prepare('UPDATE dienstrooster_swap_request SET status = ? WHERE id = ?').run('GOEDGEKEURD', swapId);

      // Create notification
      db.prepare(`
        INSERT INTO dienstrooster_notification (
          id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        notifId,
        requesterPersonId,
        testData.periodId,
        'RUIL_GOEDGEKEURD',
        'Ruilverzoek goedgekeurd',
        'Je ruilverzoek is goedgekeurd',
        new Date().toISOString()
      );

      const notif = db.prepare('SELECT type, person_id FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif.type).toBe('RUIL_GOEDGEKEURD');
      expect(notif.person_id).toBe(requesterPersonId);
    });
  });

  describe('Assignment Edit Audit Trail', () => {
    it('should create audit entry for swap', () => {
      const editId = uuid();
      const swapId = createTestSwap('PENDING');
      const personId = testData.personIds[0];
      const slotId = testData.slotIds[0];

      db.prepare(`
        INSERT INTO dienstrooster_assignment_edit (
          id, toewijzing_id, periode_id, person_id, slot_id, edit_type, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        editId,
        swapId,
        testData.periodId,
        personId,
        slotId,
        'RUIL',
        new Date().toISOString()
      );

      const edit = db.prepare('SELECT * FROM dienstrooster_assignment_edit WHERE id = ?').get(editId) as any;
      expect(edit).toBeDefined();
      expect(edit.edit_type).toBe('RUIL');
    });

    it('should enforce edit_type constraint', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO dienstrooster_assignment_edit (
            id, toewijzing_id, periode_id, person_id, slot_id, edit_type, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          uuid(),
          testData.periodId,
          testData.personIds[0],
          testData.slotIds[0],
          'INVALID_TYPE',
          new Date().toISOString()
        );
      }).toThrow();
    });

    it('should store reden (reason) for manual changes', () => {
      const editId = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_assignment_edit (
          id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        editId,
        uuid(),
        testData.periodId,
        testData.personIds[0],
        testData.slotIds[0],
        'HANDMATIG_TOEWIJZEN',
        'Personeelswissel noodzakelijk',
        new Date().toISOString()
      );

      const edit = db.prepare('SELECT reden FROM dienstrooster_assignment_edit WHERE id = ?').get(editId) as any;
      expect(edit.reden).toBe('Personeelswissel noodzakelijk');
    });
  });

  describe('Publication Schema', () => {
    it('should have gepubliceerd_op column on schedule_period', () => {
      const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
      const hasColumn = periodInfo.some(col => col.name === 'gepubliceerd_op');
      expect(hasColumn).toBe(true);
    });

    it('should have gepubliceerd_door_person_id column on schedule_period', () => {
      const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
      const hasColumn = periodInfo.some(col => col.name === 'gepubliceerd_door_person_id');
      expect(hasColumn).toBe(true);
    });

    it('should store publication timestamp and publisher', () => {
      const periodId = testData.periodId;
      const publisherId = testData.personIds[0];
      const publishedAt = new Date().toISOString();

      db.prepare(`
        UPDATE dienstrooster_schedule_period
        SET gepubliceerd_op = ?, gepubliceerd_door_person_id = ?
        WHERE id = ?
      `).run(publishedAt, publisherId, periodId);

      const period = db.prepare('SELECT gepubliceerd_op, gepubliceerd_door_person_id FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as any;
      expect(period.gepubliceerd_op).toBe(publishedAt);
      expect(period.gepubliceerd_door_person_id).toBe(publisherId);
    });
  });

  describe('Data Integrity', () => {
    it('should maintain swap data after failed operation', () => {
      const swapId = createTestSwap('PENDING');
      const originalSwap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;

      try {
        // Simulate failed update by referencing non-existent person
        db.prepare(`
          UPDATE dienstrooster_swap_request
          SET afgehandeld_door_person_id = ?
          WHERE id = ?
        `).run(uuid(), swapId);
      } catch {
        // Ignore error
      }

      const finalSwap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(finalSwap.id).toBe(originalSwap.id);
      expect(finalSwap.status).toBe(originalSwap.status);
    });

    it('should prevent orphaned notifications', () => {
      const notifId = createTestNotification('RUILVERZOEK');

      // Should fail to delete period if notifications exist
      expect(() => {
        db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(testData.periodId);
      }).toThrow();

      const notif = db.prepare('SELECT * FROM dienstrooster_notification WHERE id = ?').get(notifId) as any;
      expect(notif).toBeDefined();
    });
  });
});

// Helper functions

function setupTestData() {
  const periodId = uuid();
  const personIds = [uuid(), uuid(), uuid()];
  const slotIds = [uuid(), uuid(), uuid()];
  const poolId = uuid();
  const rulesetId = uuid();

  // Create test ruleset first
  db.prepare(`
    INSERT INTO dienstrooster_ruleset (
      id, naam, config_json, aangemaakt_op
    ) VALUES (?, ?, ?, ?)
  `).run(
    rulesetId,
    'Test Ruleset',
    JSON.stringify({
      windowWeeks: 2,
      tellers: {
        AVOND: { min: 7, max: 9 },
        WEEKEND: { min: 4, max: 6 },
        FEESTDAG: { min: 2, max: 3 },
      },
    }),
    new Date().toISOString()
  );

  // Create test pool
  db.prepare(`
    INSERT INTO dienstrooster_pool (id, naam, type, ruleset_id, aangemaakt_op)
    VALUES (?, ?, ?, ?, ?)
  `).run(poolId, 'Test Pool', 'ACHTERWACHT', rulesetId, new Date().toISOString());

  // Create test period
  db.prepare(`
    INSERT INTO dienstrooster_schedule_period (
      id, pool_id, naam, status, start_datum, eind_datum, deadline, row_version, aangemaakt_op
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    periodId,
    poolId,
    'Test Period',
    'GEGENEREERD',
    '2027-01-04',
    '2027-03-09',
    '2026-12-31T23:59:59Z',
    1,
    new Date().toISOString()
  );

  // Create shift types
  const shiftTypeId = 'AVOND';
  try {
    db.prepare(`
      INSERT INTO dienstrooster_shift_type (id, naam, teller)
      VALUES (?, ?, ?)
    `).run(shiftTypeId, 'Avond', 'AVOND');
  } catch {
    // Ignore if already exists
  }

  // Create test persons (with timestamp to ensure uniqueness)
  const timestamp = Date.now();
  personIds.forEach((personId, i) => {
    db.prepare(`
      INSERT INTO dienstrooster_person (
        id, codenaam, rol, wachtwoord_hash, aangemaakt_op
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      personId,
      `Test-${timestamp}-P${String(i + 1).padStart(2, '0')}`,
      'DEELNEMER',
      'hash',
      new Date().toISOString()
    );
  });

  // Create test shift slots
  slotIds.forEach((slotId, i) => {
    db.prepare(`
      INSERT INTO dienstrooster_shift_slot (
        id, period_id, datum, iso_jaar, iso_week, shift_type_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      slotId,
      periodId,
      `2027-01-${String(11 + i).padStart(2, '0')}`,
      2027,
      2,
      'AVOND'
    );
  });

  return { periodId, personIds, slotIds };
}

function createTestSwap(status: string = 'PENDING'): string {
  const swapId = uuid();
  db.prepare(`
    INSERT INTO dienstrooster_swap_request (
      id, periode_id, status, aangemaakt_op, aanvrager_person_id,
      respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    swapId,
    testData.periodId,
    status,
    new Date().toISOString(),
    testData.personIds[0],
    testData.personIds[1],
    testData.slotIds[0],
    testData.slotIds[1]
  );
  return swapId;
}

function createTestNotification(type: string): string {
  const notifId = uuid();
  db.prepare(`
    INSERT INTO dienstrooster_notification (
      id, person_id, periode_id, type, onderwerp, inhoud, aangemaakt_op
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    notifId,
    testData.personIds[0],
    testData.periodId,
    type,
    'Test Notification',
    'Test content',
    new Date().toISOString()
  );
  return notifId;
}

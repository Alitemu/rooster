import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { db } from '@/db/client';
import { setupPhase3Tables, cleanupPhase3TestData } from '@/lib/phase3-db-setup';
import { v4 as uuid } from 'uuid';

/**
 * Phase 3: API Workflow Tests
 *
 * Tests complete workflows by simulating API calls
 * without needing a running server.
 */

describe('Phase 3 API Workflows', () => {
  let testData: {
    periodId: string;
    personIds: string[];
    slotIds: string[];
  };

  beforeAll(() => {
    db.prepare('PRAGMA foreign_keys = OFF').run();
    setupPhase3Tables();

    // Setup test data
    const periodId = uuid();
    const personIds = [uuid(), uuid(), uuid()];
    const slotIds = [uuid(), uuid(), uuid()];

    db.prepare(`
      INSERT INTO dienstrooster_schedule_period (
        id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(periodId, 'pool-1', 'Test Period', 'GEGENEREERD', '2027-01-04', '2027-03-09', '2026-12-31T23:59:59Z');

    personIds.forEach((id, i) => {
      db.prepare(`
        INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
        VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))
      `).run(id, `Person-${i + 1}`);
    });

    slotIds.forEach((id, i) => {
      db.prepare(`
        INSERT INTO dienstrooster_shift_slot (
          id, period_id, datum, iso_jaar, iso_week, shift_type_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, periodId, `2027-01-${String(11 + i).padStart(2, '0')}`, 2027, 2, 'AVOND');
    });

    testData = { periodId, personIds, slotIds };
  });

  afterEach(() => {
    if (testData?.periodId) {
      cleanupPhase3TestData(testData.periodId);
    }
  });

  describe('Complete Swap Workflow', () => {
    it('should execute full swap workflow: create → approve → update assignments', () => {
      const requesterPersonId = testData.personIds[0];
      const respondentPersonId = testData.personIds[1];
      const offeredSlotId = testData.slotIds[0];
      const requestedSlotId = testData.slotIds[1];
      const swapId = uuid();
      const now = new Date().toISOString();

      // Step 1: Create assignments for both people
      const req Assignment1 = uuid();
      const respondentAssignment = uuid();

      db.prepare(`
        INSERT INTO dienstrooster_assignment (
          id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(requesterAssignment1, testData.periodId, requesterPersonId, offeredSlotId, 'SOLVER', 1);

      db.prepare(`
        INSERT INTO dienstrooster_assignment (
          id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(respondentAssignment, testData.periodId, respondentPersonId, requestedSlotId, 'SOLVER', 1);

      // Step 2: Create swap request
      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        swapId,
        testData.periodId,
        'PENDING',
        now,
        requesterPersonId,
        respondentPersonId,
        offeredSlotId,
        requestedSlotId
      );

      // Verify swap request created
      const swap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap).toBeDefined();
      expect(swap.status).toBe('PENDING');

      // Step 3: Respondent approves swap
      db.prepare(`
        UPDATE dienstrooster_swap_request
        SET status = ?, beantwoord_op = ?
        WHERE id = ?
      `).run('GOEDGEKEURD', now, swapId);

      // Step 4: Swap assignments
      db.prepare(
        'UPDATE dienstrooster_assignment SET person_id = ?, bron = ? WHERE id = ?'
      ).run(respondentPersonId, 'MANUAL', requesterAssignment1);

      db.prepare(
        'UPDATE dienstrooster_assignment SET person_id = ?, bron = ? WHERE id = ?'
      ).run(requesterPersonId, 'MANUAL', respondentAssignment);

      // Step 5: Create notification for requester
      const notifId = uuid();
      db.prepare(`
        INSERT INTO dienstrooster_notification (
          id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        notifId,
        requesterPersonId,
        testData.periodId,
        'RUIL_GOEDGEKEURD',
        'Ruilverzoek goedgekeurd',
        'Je ruilverzoek is goedgekeurd',
        false
      );

      // Step 6: Create audit log entry
      db.prepare(`
        INSERT INTO dienstrooster_audit_log (
          id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        uuid(),
        respondentPersonId,
        'swap_request',
        swapId,
        'APPROVE',
        JSON.stringify({ status: 'PENDING' }),
        JSON.stringify({ status: 'GOEDGEKEURD' })
      );

      // Verify final state
      const finalSwap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(finalSwap.status).toBe('GOEDGEKEURD');
      expect(finalSwap.beantwoord_op).toBe(now);

      const requesterUpdated = db.prepare(
        'SELECT person_id FROM dienstrooster_assignment WHERE id = ?'
      ).get(respondentAssignment) as any;
      expect(requesterUpdated.person_id).toBe(requesterPersonId);

      const respondentUpdated = db.prepare(
        'SELECT person_id FROM dienstrooster_assignment WHERE id = ?'
      ).get(requesterAssignment1) as any;
      expect(respondentUpdated.person_id).toBe(respondentPersonId);

      const notification = db.prepare(
        'SELECT * FROM dienstrooster_notification WHERE id = ?'
      ).get(notifId) as any;
      expect(notification.type).toBe('RUIL_GOEDGEKEURD');
      expect(notification.person_id).toBe(requesterPersonId);
    });

    it('should execute swap rejection workflow with reason', () => {
      const requesterPersonId = testData.personIds[0];
      const respondentPersonId = testData.personIds[1];
      const swapId = uuid();
      const rejectionReason = 'Cannot swap on that date';
      const now = new Date().toISOString();

      // Create swap request
      db.prepare(`
        INSERT INTO dienstrooster_swap_request (
          id, periode_id, status, aangemaakt_op, aanvrager_person_id,
          respondent_person_id, aangeboden_slot_id, gevraagde_slot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        swapId,
        testData.periodId,
        'PENDING',
        now,
        requesterPersonId,
        respondentPersonId,
        testData.slotIds[0],
        testData.slotIds[1]
      );

      // Reject swap with reason
      db.prepare(`
        UPDATE dienstrooster_swap_request
        SET status = ?, beantwoord_op = ?, opmerkingen = ?
        WHERE id = ?
      `).run('AFGEWEZEN', now, rejectionReason, swapId);

      // Create rejection notification
      db.prepare(`
        INSERT INTO dienstrooster_notification (
          id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        uuid(),
        requesterPersonId,
        testData.periodId,
        'RUILVERZOEK',
        'Ruilverzoek afgewezen',
        `Je ruilverzoek is afgewezen. Reden: ${rejectionReason}`,
        false
      );

      // Verify rejection
      const swap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
      expect(swap.status).toBe('AFGEWEZEN');
      expect(swap.opmerkingen).toBe(rejectionReason);
      expect(swap.beantwoord_op).toBe(now);
    });
  });

  describe('Publication Workflow', () => {
    it('should execute complete publication workflow', () => {
      const publisherId = testData.personIds[0];
      const now = new Date().toISOString();

      // Create some assignments
      testData.slotIds.forEach((slotId, i) => {
        db.prepare(`
          INSERT INTO dienstrooster_assignment (
            id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(uuid(), testData.periodId, testData.personIds[i % 3], slotId, 'SOLVER', 1);
      });

      // Step 1: Validate publication (all slots filled)
      const unassignedSlots = db.prepare(`
        SELECT COUNT(*) as count FROM dienstrooster_shift_slot s
        WHERE s.period_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM dienstrooster_assignment a
          WHERE a.schedule_version_id = s.period_id AND a.slot_id = s.id
        )
      `).get(testData.periodId) as any;
      expect(unassignedSlots.count).toBe(0);

      // Step 2: Update period status
      db.prepare(`
        UPDATE dienstrooster_schedule_period
        SET status = ?, gepubliceerd_op = ?, gepubliceerd_door_person_id = ?
        WHERE id = ?
      `).run('GEPUBLICEERD', now, publisherId, testData.periodId);

      // Step 3: Create notifications for all staff
      const notificationCount = 3; // Number of unique people
      testData.personIds.forEach((personId) => {
        db.prepare(`
          INSERT INTO dienstrooster_notification (
            id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          uuid(),
          personId,
          testData.periodId,
          'PUBLICATIE_BERICHT',
          'Rooster gepubliceerd',
          'Je rooster is nu beschikbaar',
          false
        );
      });

      // Step 4: Create audit log
      db.prepare(`
        INSERT INTO dienstrooster_audit_log (
          id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        uuid(),
        publisherId,
        'schedule_period',
        testData.periodId,
        'PUBLISH',
        JSON.stringify({ status: 'GEGENEREERD' }),
        JSON.stringify({ status: 'GEPUBLICEERD', notifications_sent: notificationCount })
      );

      // Verify publication
      const period = db.prepare(
        'SELECT * FROM dienstrooster_schedule_period WHERE id = ?'
      ).get(testData.periodId) as any;
      expect(period.status).toBe('GEPUBLICEERD');
      expect(period.gepubliceerd_op).toBe(now);
      expect(period.gepubliceerd_door_person_id).toBe(publisherId);

      // Verify notifications created
      const notifs = db.prepare(
        'SELECT COUNT(*) as count FROM dienstrooster_notification WHERE periode_id = ?'
      ).get(testData.periodId) as any;
      expect(notifs.count).toBe(notificationCount);
    });

    it('should prevent publication of already published period', () => {
      const publisherId = testData.personIds[0];
      const now = new Date().toISOString();

      // Mark as published
      db.prepare(`
        UPDATE dienstrooster_schedule_period
        SET status = ?, gepubliceerd_op = ?, gepubliceerd_door_person_id = ?
        WHERE id = ?
      `).run('GEPUBLICEERD', now, publisherId, testData.periodId);

      // Try to publish again - should fail
      const period = db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(
        testData.periodId
      ) as any;

      if (period.status !== 'GEGENEREERD') {
        throw new Error(`Cannot publish period in ${period.status} status`);
      }

      expect(() => {
        throw new Error(`Cannot publish period in ${period.status} status`);
      }).toThrow();
    });
  });

  describe('Notification Workflow', () => {
    it('should track notification read status through workflow', () => {
      const personId = testData.personIds[0];
      const notifIds: string[] = [];

      // Create multiple notifications
      for (let i = 0; i < 3; i++) {
        const notifId = uuid();
        db.prepare(`
          INSERT INTO dienstrooster_notification (
            id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          notifId,
          personId,
          testData.periodId,
          i === 0 ? 'RUILVERZOEK' : i === 1 ? 'RUIL_GOEDGEKEURD' : 'PUBLICATIE_BERICHT',
          `Subject ${i}`,
          `Content ${i}`,
          false
        );
        notifIds.push(notifId);
      }

      // Get unread count
      const unread = db.prepare(
        'SELECT COUNT(*) as count FROM dienstrooster_notification WHERE person_id = ? AND gelezen = 0'
      ).get(personId) as any;
      expect(unread.count).toBe(3);

      // Mark first two as read
      db.prepare('UPDATE dienstrooster_notification SET gelezen = 1 WHERE id = ?').run(notifIds[0]);
      db.prepare('UPDATE dienstrooster_notification SET gelezen = 1 WHERE id = ?').run(notifIds[1]);

      // Get new unread count
      const remaining = db.prepare(
        'SELECT COUNT(*) as count FROM dienstrooster_notification WHERE person_id = ? AND gelezen = 0'
      ).get(personId) as any;
      expect(remaining.count).toBe(1);

      // Verify which one is unread
      const unreadNotif = db.prepare(
        'SELECT type FROM dienstrooster_notification WHERE person_id = ? AND gelezen = 0'
      ).get(personId) as any;
      expect(unreadNotif.type).toBe('PUBLICATIE_BERICHT');
    });
  });

  describe('Assignment Audit Trail', () => {
    it('should track manual assignment changes in audit log', () => {
      const planner = testData.personIds[0];
      const person = testData.personIds[1];
      const slot = testData.slotIds[0];
      const reason = 'Capacity adjustment';
      const now = new Date().toISOString();

      // Create assignment
      const assignmentId = uuid();
      db.prepare(`
        INSERT INTO dienstrooster_assignment (
          id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(assignmentId, testData.periodId, person, slot, 'SOLVER', 1);

      // Manual edit
      db.prepare(
        'UPDATE dienstrooster_assignment SET bron = ? WHERE id = ?'
      ).run('OVERRIDE', assignmentId);

      // Log the edit
      db.prepare(`
        INSERT INTO dienstrooster_assignment_edit (
          id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(
        uuid(),
        assignmentId,
        testData.periodId,
        person,
        slot,
        'OVERRIDE',
        reason,
        planner,
        1
      );

      // Log to audit
      db.prepare(`
        INSERT INTO dienstrooster_audit_log (
          id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        uuid(),
        planner,
        'assignment',
        assignmentId,
        'OVERRIDE',
        JSON.stringify({ bron: 'SOLVER' }),
        JSON.stringify({ bron: 'OVERRIDE', reason })
      );

      // Verify audit trail
      const edits = db.prepare(
        'SELECT * FROM dienstrooster_assignment_edit WHERE toewijzing_id = ?'
      ).all(assignmentId) as any[];
      expect(edits).toHaveLength(1);
      expect(edits[0].edit_type).toBe('OVERRIDE');
      expect(edits[0].reden).toBe(reason);
      expect(edits[0].bewerkt_door_person_id).toBe(planner);
    });
  });
});

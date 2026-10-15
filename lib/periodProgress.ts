/**
 * "Status voorkeuren": per participant of a period how far they are with
 * their preferences. One query for the table on the period page (GET
 * /api/planner/period/[id]/progress) and the statusrapport download
 * (/api/exports/status-report), which each had their own and drifted
 * apart: the download counted a fellow's weekend blocks as some forty days
 * they blocked themselves (audit 16).
 *
 * Part-time counts only for a pattern that overlaps the period, like an
 * absence: any pattern ever made, also one that ended a year before, put a
 * tick under Deeltijd (audit 16).
 */

import { db } from '@/db/client';

export interface PeriodProgressRow {
  person_id: string;
  codenaam: string;
  submission_status: string | null;
  // When they confirmed their part-time and absence days (the Deeltijd step).
  deeltijd_gecontroleerd_op: string | null;
  submitted_at: string | null;
  has_parttime_patterns: number;
  blocked_days_count: number;
  has_absences: number;
  is_fellow: number;
}

/** The period's participants as loadPeriodMembers counts them, fellows last. */
export function loadPeriodProgress(periodId: string): PeriodProgressRow[] {
  return db
    .prepare(
      `SELECT
        p.id as person_id,
        p.codenaam,
        s.status as submission_status,
        s.deeltijd_gecontroleerd_op,
        s.ingediend_op as submitted_at,
        EXISTS (
          SELECT 1 FROM dienstrooster_parttime_pattern pp
          WHERE pp.person_id = p.id AND pp.geldig_vanaf <= sp.eind_datum AND pp.geldig_tot >= sp.start_datum
        ) as has_parttime_patterns,
        (SELECT COUNT(*) FROM dienstrooster_availability av
         JOIN dienstrooster_shift_slot sl ON sl.id = av.slot_id
         WHERE av.person_id = p.id AND sl.period_id = sp.id
         AND av.blocking_level = 'ABSOLUUT'
         -- A fellow's weekend blocks are shown as the "Fellow" label, not
         -- as some forty days they blocked themselves.
         AND av.fellow_blok = 0) as blocked_days_count,
        EXISTS (
          SELECT 1 FROM dienstrooster_period_fellow pf WHERE pf.person_id = p.id AND pf.period_id = sp.id
        ) as is_fellow,
        EXISTS (
          SELECT 1 FROM dienstrooster_absence a
          WHERE a.person_id = p.id AND a.van_datum <= sp.eind_datum AND a.tot_datum >= sp.start_datum
        ) as has_absences
      FROM dienstrooster_schedule_period sp
      JOIN dienstrooster_person p ON p.actief = 1
      LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = sp.id
      WHERE sp.id = ?
        AND p.id IN (
          SELECT pm.person_id FROM dienstrooster_pool_membership pm
          WHERE pm.pool_id = sp.pool_id
            AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum
        )
      -- Fellows together at the bottom instead of scattered among the rest.
      ORDER BY is_fellow ASC, p.codenaam ASC`
    )
    .all(periodId) as PeriodProgressRow[];
}

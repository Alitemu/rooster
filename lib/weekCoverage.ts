/**
 * Week coverage: per ISO week, how many pool members are still coverable
 * (not ABSOLUUT-blocked on every slot in that week).
 *
 * A person only counts as unavailable for a week if they blocked every
 * slot in it - blocking 6 of 7 days still leaves them coverable for the
 * remaining day. LIEVER_NIET (soft block) never affects this count.
 */

import { db } from '@/db/client';

export type CoverageStatus = 'red' | 'orange' | 'green';

export interface WeekCoverageEntry {
  iso_jaar: number;
  iso_week: number;
  pool_size: number;
  available_count: number;
  status: CoverageStatus;
}

export function getWeekCoverageStatus(availableCount: number): CoverageStatus {
  if (availableCount <= 7) return 'red';
  if (availableCount <= 10) return 'orange';
  return 'green';
}

export function getPoolSizeForPeriod(periodId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT pm.person_id) as count
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_schedule_period sp ON sp.pool_id = pm.pool_id
       WHERE sp.id = ?
         AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum`
    )
    .get(periodId) as { count: number } | undefined;
  return row?.count || 0;
}

export function computeCoverageByWeek(periodId: string, poolId: string): WeekCoverageEntry[] {
  const poolSize = getPoolSizeForPeriod(periodId);

  const weeks = db
    .prepare(
      `WITH week_slots AS (
         SELECT iso_jaar, iso_week, id AS slot_id
         FROM dienstrooster_shift_slot
         WHERE period_id = ?
       ),
       week_slot_counts AS (
         SELECT iso_jaar, iso_week, COUNT(*) AS slot_count
         FROM week_slots
         GROUP BY iso_jaar, iso_week
       ),
       person_week_blocks AS (
         SELECT ws.iso_jaar, ws.iso_week, a.person_id,
                COUNT(DISTINCT a.slot_id) AS blocked_count
         FROM week_slots ws
         JOIN dienstrooster_availability a
           ON a.slot_id = ws.slot_id AND a.blocking_level = 'ABSOLUUT'
         JOIN dienstrooster_pool_membership pm
           ON pm.person_id = a.person_id AND pm.pool_id = ?
         GROUP BY ws.iso_jaar, ws.iso_week, a.person_id
       ),
       fully_blocked AS (
         SELECT pwb.iso_jaar, pwb.iso_week, COUNT(*) AS fully_blocked_count
         FROM person_week_blocks pwb
         JOIN week_slot_counts wsc USING (iso_jaar, iso_week)
         WHERE pwb.blocked_count = wsc.slot_count
         GROUP BY pwb.iso_jaar, pwb.iso_week
       )
       SELECT wsc.iso_jaar, wsc.iso_week,
              COALESCE(fb.fully_blocked_count, 0) AS fully_blocked_count
       FROM week_slot_counts wsc
       LEFT JOIN fully_blocked fb USING (iso_jaar, iso_week)
       ORDER BY wsc.iso_jaar, wsc.iso_week`
    )
    .all(periodId, poolId) as Array<{ iso_jaar: number; iso_week: number; fully_blocked_count: number }>;

  return weeks.map((week) => {
    const availableCount = poolSize - week.fully_blocked_count;
    return {
      iso_jaar: week.iso_jaar,
      iso_week: week.iso_week,
      pool_size: poolSize,
      available_count: availableCount,
      status: getWeekCoverageStatus(availableCount),
    };
  });
}

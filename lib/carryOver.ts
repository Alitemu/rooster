/**
 * Carry-over between periods.
 *
 * The fairness promise of the whole application: someone who ended a
 * period below their target picks up the difference in the next one, and
 * someone who ended above it does correspondingly less. Nothing closed that
 * loop before - `CARRY_OVER` existed as a ledger category but no code ever
 * wrote one, so balances had to be worked out by hand and imported.
 *
 * Sign convention (db/schema.ts): delta < 0 = fewer shifts, > 0 = more.
 * The solver applies it as `band_min/max + delta` for the period the entry
 * is booked against, so a delta of +1 literally means "one extra shift in
 * that period".
 *
 * Timing: computed when a period is *opened*, looking back at the pool's
 * most recently published period - not at publish time. The destination
 * period has to exist to be booked against, and when you publish period N
 * period N+1 usually doesn't exist yet. CLAUDE.md says corrections target
 * the next un-generated period, which is exactly the one being opened.
 *
 * Debt compounds on its own: the target a person was held to in period N
 * already includes N's own carry-over, so anything still unmet rolls
 * forward without special handling.
 */

import { db } from '@/db/client';
import {
  TELLERS,
  countSlotsByTeller,
  resolveBands,
  resolveRulesetConfig,
  type Teller,
} from '@/lib/rosterBands';

export interface CarryOverEntry {
  person_id: string;
  teller: Teller;
  delta: number;
  target: number;
  actual: number;
}

interface PeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

/**
 * The pool's most recent published period ending before `beforeDate`.
 * Returns undefined for a pool's first-ever period.
 */
export function findPreviousPublishedPeriod(
  poolId: string,
  beforeDate: string
): PeriodRow | undefined {
  return db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND eind_datum < ?
       ORDER BY eind_datum DESC
       LIMIT 1`
    )
    .get(poolId, beforeDate) as PeriodRow | undefined;
}

/**
 * What each person over- or under-worked in `period`, per counter.
 *
 * Only people who were pool members during that period are considered -
 * somebody who joined afterwards has nothing to carry.
 */
export function computeCarryOver(period: PeriodRow): CarryOverEntry[] {
  const members = db
    .prepare(
      `SELECT p.id FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string }>;

  if (members.length === 0) return [];

  const bands = resolveBands(
    resolveRulesetConfig(period),
    countSlotsByTeller(period.id),
    members.length
  );

  const actualRows = db
    .prepare(
      `SELECT a.person_id, st.teller, COUNT(*) as count
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       GROUP BY a.person_id, st.teller`
    )
    .all(period.id) as Array<{ person_id: string; teller: string; count: number }>;

  const actual = new Map<string, number>();
  for (const row of actualRows) actual.set(`${row.person_id}|${row.teller}`, row.count);

  // The band this period actually enforced already included its own
  // carry-over, so the target has to include it too - otherwise a debt that
  // was correctly paid off would look like an overshoot and bounce back.
  const priorRows = db
    .prepare(
      `SELECT person_id, teller, SUM(delta) as total
       FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ?
       GROUP BY person_id, teller`
    )
    .all(period.id) as Array<{ person_id: string; teller: string; total: number }>;

  const prior = new Map<string, number>();
  for (const row of priorRows) prior.set(`${row.person_id}|${row.teller}`, row.total || 0);

  const entries: CarryOverEntry[] = [];
  for (const member of members) {
    for (const teller of TELLERS) {
      const key = `${member.id}|${teller}`;
      const [min, max] = bands[teller];
      const shift = prior.get(key) || 0;
      const adjustedMin = min + shift;
      const adjustedMax = max + shift;
      const count = actual.get(key) || 0;

      // Measured against the band itself, not its midpoint. The band is
      // what the person was actually promised ("you receive 8 or 9 evening
      // shifts"), so landing anywhere inside it means the promise was kept
      // and nothing carries.
      //
      // Using the midpoint instead introduces a systematic drift whenever
      // slots don't divide evenly by headcount: 175 evening shifts across
      // 30 people gives a band of [5,6] whose midpoint is 5, so the 22
      // people who worked 6 would each bank -1 - and next period their
      // band drops, they overshoot again, and the debt compounds downward
      // forever. Observed exactly that before switching to band edges.
      let delta = 0;
      let target = count;
      if (count < adjustedMin) {
        delta = adjustedMin - count;
        target = adjustedMin;
      } else if (count > adjustedMax) {
        delta = adjustedMax - count;
        target = adjustedMax;
      }

      // Only record a real imbalance; a settled counter needs no row.
      if (delta !== 0) {
        entries.push({ person_id: member.id, teller, delta, target, actual: count });
      }
    }
  }

  return entries;
}

/**
 * Book carry-over from the previous published period against `periodId`.
 *
 * Idempotent: re-opening a period replaces its CARRY_OVER rows rather than
 * stacking a second set on top. BEGINSALDO and CORRECTIE entries are left
 * alone - those are the planner's own bookings, not ours to recompute.
 *
 * Returns how many entries were written.
 */
export function applyCarryOverForPeriod(periodId: string, actorId: string): number {
  const period = db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as PeriodRow | undefined;

  if (!period) return 0;

  const previous = findPreviousPublishedPeriod(period.pool_id, period.start_datum);
  if (!previous) return 0; // first period for this pool - nothing to carry

  const entries = computeCarryOver(previous);

  const write = db.transaction(() => {
    db.prepare(
      `DELETE FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ? AND categorie = 'CARRY_OVER'`
    ).run(periodId);

    const insert = db.prepare(
      `INSERT INTO dienstrooster_ledger_entry
         (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CARRY_OVER', ?, datetime('now'))`
    );

    for (const entry of entries) {
      const shortfall = entry.delta > 0;
      const amount = Math.abs(entry.delta);
      const reden =
        `${amount} ${shortfall ? 'to make up from' : 'too many in'} the previous period ` +
        `(${entry.actual} of ${entry.target})`;

      insert.run(
        crypto.randomUUID(),
        entry.person_id,
        period.pool_id,
        entry.teller,
        periodId,
        entry.delta,
        reden,
        actorId
      );
    }
  });

  write();
  return entries.length;
}

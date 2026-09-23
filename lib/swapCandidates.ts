/**
 * Which colleagues' shifts can someone ask to swap for, and how likely is
 * each colleague to say yes?
 *
 * A swap hands the colleague the requester's offered shift. How they stand
 * towards THAT day is what decides whether the request has a chance: a
 * colleague who blocked it will almost certainly decline, one who marked
 * it as a voorkeur may well be glad to. The swap dialog used to list every
 * same-type shift in date order with none of that visible, so a requester
 * had no way to aim for a colleague likely to agree.
 *
 * KORT_OP_ELKAAR: the colleague would end up with two shifts close
 * together - in the same week, or within the window between shifts. That
 * is allowed (their own call, see lib/swapWindowRule.ts), just less
 * likely to get a yes. Whether the REQUESTER would end up that way is
 * reported separately (requester_te_dichtbij): it is the requester's own
 * choice, so it doesn't say anything about the colleague.
 */

import { db } from '@/db/client';
import { checkSwapAllowed } from './swapEligibility';
import { swapWindowConflicts } from './swapWindowRule';

export type SwapCandidateCategory =
  | 'VOORKEUR'
  | 'BESCHIKBAAR'
  | 'LIEVER_NIET'
  | 'KORT_OP_ELKAAR'
  | 'GEBLOKKEERD';

/** Most promising first - the order the dialog groups them in. */
export const SWAP_CANDIDATE_ORDER: SwapCandidateCategory[] = [
  'VOORKEUR',
  'BESCHIKBAAR',
  'LIEVER_NIET',
  'KORT_OP_ELKAAR',
  'GEBLOKKEERD',
];

export interface SwapCandidate {
  slot_id: string;
  datum: string;
  teller: string;
  person_id: string;
  codenaam: string;
  category: SwapCandidateCategory;
  /** The requester would end up with two shifts close together. */
  requester_te_dichtbij: boolean;
}

export type SwapCandidatesResult =
  | { ok: true; candidates: SwapCandidate[] }
  | { ok: false; status: number; message: string };

export function getSwapCandidates(
  requesterId: string,
  periodId: string,
  offeredSlotId: string,
  now: Date = new Date()
): SwapCandidatesResult {
  const period = db
    .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { status: string } | undefined;
  if (!period) return { ok: false, status: 404, message: 'Periode niet gevonden' };

  const offered = db
    .prepare(
      `SELECT s.id, s.datum, s.iso_jaar, s.iso_week, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ? AND a.person_id = ? AND a.slot_id = ?`
    )
    .get(periodId, requesterId, offeredSlotId) as
    | { id: string; datum: string; iso_jaar: number; iso_week: number; teller: string }
    | undefined;
  if (!offered) return { ok: false, status: 400, message: 'Je hebt de aangeboden dienst niet toegewezen gekregen' };

  const eligibility = checkSwapAllowed({ periodStatus: period.status, slotDates: [offered.datum] }, now);
  if (!eligibility.allowed) return { ok: false, status: 403, message: eligibility.message! };

  const others = db
    .prepare(
      `SELECT a.slot_id, s.datum, st.teller, a.person_id, p.codenaam
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       JOIN dienstrooster_person p ON p.id = a.person_id
       WHERE a.schedule_version_id = ? AND a.person_id != ? AND st.teller = ?
       ORDER BY s.datum`
    )
    .all(periodId, requesterId, offered.teller) as Array<Omit<SwapCandidate, 'category' | 'requester_te_dichtbij'>>;

  const preferenceStmt = db.prepare(
    'SELECT blocking_level FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?'
  );
  const sameWeekStmt = db.prepare(
    `SELECT 1 FROM dienstrooster_assignment a
     JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
     WHERE a.schedule_version_id = ? AND a.person_id = ? AND a.slot_id != ?
       AND s.iso_jaar = ? AND s.iso_week = ?
     LIMIT 1`
  );

  const candidates: SwapCandidate[] = [];
  for (const other of others) {
    // Same rule as the create route: a shift already behind us can't be
    // swapped, so it is not offered at all.
    if (!checkSwapAllowed({ periodStatus: period.status, slotDates: [other.datum] }, now).allowed) continue;

    const conflicts = swapWindowConflicts({
      periodId,
      requesterPersonId: requesterId,
      respondentPersonId: other.person_id,
      offeredSlotId: offered.id,
      requestedSlotId: other.slot_id,
    });
    const level = (preferenceStmt.get(other.person_id, offered.id) as { blocking_level: string | null } | undefined)
      ?.blocking_level;
    // Same week counts too, even when the window itself is set to 0.
    const sameWeek = Boolean(
      sameWeekStmt.get(periodId, other.person_id, other.slot_id, offered.iso_jaar, offered.iso_week)
    );

    const category: SwapCandidateCategory =
      level === 'ABSOLUUT'
        ? 'GEBLOKKEERD'
        : conflicts.respondentTooClose || sameWeek
          ? 'KORT_OP_ELKAAR'
          : level === 'LIEVER_NIET'
            ? 'LIEVER_NIET'
            : level === 'VOORKEUR'
              ? 'VOORKEUR'
              : 'BESCHIKBAAR';
    candidates.push({ ...other, category, requester_te_dichtbij: conflicts.requesterTooClose });
  }

  return { ok: true, candidates };
}

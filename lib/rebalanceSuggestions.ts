/**
 * Manual rebalancing suggestions for an already-generated roster.
 *
 * The solver leaves at most MAX_BAND_OVERSHOOT (see solver/constraints.py)
 * diensten above someone's streefbereik per counter, never more - but it
 * also never actively looks for someone else who still has room and could
 * take that dienst instead; that's exactly what a planner would otherwise
 * work out by hand. This module proposes, per over-target person, which of
 * their diensten could move to someone who hasn't used their own bereik up
 * yet, without ever violating a hard block (ABSOLUUT) or double-booking a
 * day - the window rule and holiday spread are deliberately NOT a veto
 * here, exactly as they already aren't for lib/rosterGaps.ts's manual-fill
 * flow: a planner making a deliberate, one-off correction must be able to
 * accept that the receiving person ends up with two diensten close
 * together, the same trade a manual reassign already allows today.
 *
 * Suggestion-only, by design (see the "Toepassen" conversation this was
 * built from): each suggestion names an existing dienst and the person who
 * could take it, but this module never writes to the database - accepting
 * one is just a normal reassign (POST .../assignments/[id]/reassign), the
 * same action a planner already has for any other dienst.
 */

import { db } from '@/db/client';
import {
  TELLERS,
  countSlotsByTeller,
  resolveBands,
  resolveRulesetConfig,
  scaledBandForMember,
  type Teller,
} from '@/lib/rosterBands';
import { getEligiblePeopleForSlot, type EligibilityCategory } from '@/lib/rosterGaps';

export interface RebalanceSuggestion {
  assignment_id: string;
  slot_id: string;
  datum: string;
  teller: Teller;
  from_person_id: string;
  from_codenaam: string;
  from_count: number; // this person's current count for `teller`, before the move
  from_max: number;
  to_person_id: string;
  to_codenaam: string;
  to_count: number; // the candidate's current count for `teller`, before the move
  to_max: number;
  category: EligibilityCategory; // never GEBLOKKEERD/PARTTIME - those are hard vetoes, filtered out
  warning: string | null;
}

interface PeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

interface Member {
  id: string;
  codenaam: string;
  deelnamefactor: number;
  geldig_vanaf: string;
  geldig_tot: string;
}

// Desirability order for picking a recipient among several eligible
// candidates - never used to exclude anyone (GEBLOKKEERD/PARTTIME are
// already filtered out before this runs). Lower index = preferred.
const CATEGORY_RANK: Record<EligibilityCategory, number> = {
  VOORKEUR: 0,
  BESCHIKBAAR: 1,
  LIEVER_NIET: 2,
  VENSTERBLOK: 3,
  PARTTIME: 99,
  GEBLOKKEERD: 99,
};

function warningFor(category: EligibilityCategory, codenaam: string): string | null {
  if (category === 'LIEVER_NIET') {
    return `Let op: dit is een liever-niet-dag voor ${codenaam}.`;
  }
  if (category === 'VENSTERBLOK') {
    return `Let op: doorbreekt het vensterblok - ${codenaam} krijgt hierdoor 2 diensten dicht bij elkaar (bijv. dezelfde week).`;
  }
  return null;
}

/**
 * Suggested reassignments that would bring one or more people back within
 * their streefbereik, without ever proposing a hard block or a
 * double-booked day. Not every overshoot necessarily gets a suggestion -
 * if nobody eligible has room, that instance is simply left out, same as
 * the solver itself would have had no better option.
 */
export function suggestRebalances(periodId: string): RebalanceSuggestion[] {
  const period = db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as PeriodRow | undefined;

  if (!period) return [];

  const members = db
    .prepare(
      `SELECT p.id, p.codenaam, pm.deelnamefactor, pm.geldig_vanaf, pm.geldig_tot
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Member[];

  if (members.length === 0) return [];

  const config = resolveRulesetConfig(period);
  const distributionMode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';
  const bands = resolveBands(config, countSlotsByTeller(periodId), members.length);

  const counts = new Map<string, number>(); // `${personId}|${teller}` -> count
  for (const row of db
    .prepare(
      `SELECT a.person_id, st.teller, COUNT(*) as count
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       GROUP BY a.person_id, st.teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; count: number }>) {
    counts.set(`${row.person_id}|${row.teller}`, row.count);
  }

  const deltas = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT person_id, teller, SUM(delta) as total
       FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ?
       GROUP BY person_id, teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; total: number }>) {
    deltas.set(`${row.person_id}|${row.teller}`, row.total || 0);
  }

  const membersById = new Map(members.map((m) => [m.id, m]));

  // Effective [min, max] per person/teller, ledger delta already folded
  // in - the same "actual_min/actual_max" the solver itself enforces.
  const effectiveMax = new Map<string, number>();
  for (const member of members) {
    for (const teller of TELLERS) {
      const key = `${member.id}|${teller}`;
      const [, max] = scaledBandForMember(bands, teller, member, period, distributionMode);
      effectiveMax.set(key, max + (deltas.get(key) || 0));
    }
  }

  // Remaining room per person/teller, mutated as suggestions are accepted
  // below so the same recipient is never suggested more room than they
  // actually have across multiple suggestions in this one pass.
  const remainingRoom = new Map<string, number>();
  for (const member of members) {
    for (const teller of TELLERS) {
      const key = `${member.id}|${teller}`;
      const max = effectiveMax.get(key) ?? 0;
      const count = counts.get(key) || 0;
      remainingRoom.set(key, Math.max(0, max - count));
    }
  }

  // Everyone's own assignments, so a candidate already booked on this
  // exact calendar date (regardless of counter) is never suggested for a
  // second dienst that same day.
  const assignmentsByPerson = new Map<string, Array<{ id: string; slot_id: string; datum: string; teller: Teller }>>();
  for (const row of db
    .prepare(
      `SELECT a.id, a.person_id, a.slot_id, s.datum, s.iso_jaar, s.iso_week, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       ORDER BY s.datum`
    )
    .all(periodId) as Array<{
    id: string;
    person_id: string;
    slot_id: string;
    datum: string;
    iso_jaar: number;
    iso_week: number;
    teller: Teller;
  }>) {
    if (!assignmentsByPerson.has(row.person_id)) assignmentsByPerson.set(row.person_id, []);
    assignmentsByPerson.get(row.person_id)!.push(row);
  }

  const datesByPerson = new Map<string, Set<string>>();
  for (const [personId, rows] of assignmentsByPerson) {
    datesByPerson.set(personId, new Set(rows.map((r) => r.datum)));
  }

  const suggestions: RebalanceSuggestion[] = [];

  for (const member of members) {
    for (const teller of TELLERS) {
      const key = `${member.id}|${teller}`;
      const max = effectiveMax.get(key) ?? 0;
      const count = counts.get(key) || 0;
      let excess = count - max;
      if (excess <= 0) continue;

      const candidateSlots = (assignmentsByPerson.get(member.id) || []).filter((a) => a.teller === teller);

      for (const slot of candidateSlots) {
        if (excess <= 0) break;

        const eligible = getEligiblePeopleForSlot(periodId, slot.slot_id, member.id).filter(
          (p) => p.category !== 'GEBLOKKEERD' && p.category !== 'PARTTIME'
        );

        const candidates = eligible
          .map((p) => ({
            ...p,
            room: remainingRoom.get(`${p.id}|${teller}`) ?? 0,
            count: counts.get(`${p.id}|${teller}`) || 0,
          }))
          .filter((p) => p.room > 0 && !(datesByPerson.get(p.id)?.has(slot.datum) ?? false))
          .sort((a, b) => {
            const rankDiff = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
            if (rankDiff !== 0) return rankDiff;
            if (a.count !== b.count) return a.count - b.count; // most under-target first
            return a.codenaam.localeCompare(b.codenaam);
          });

        const best = candidates[0];
        if (!best) continue; // nobody eligible has room - leave this instance unresolved

        const recipient = membersById.get(best.id)!;
        suggestions.push({
          assignment_id: slot.id,
          slot_id: slot.slot_id,
          datum: slot.datum,
          teller,
          from_person_id: member.id,
          from_codenaam: member.codenaam,
          from_count: count,
          from_max: max,
          to_person_id: recipient.id,
          to_codenaam: recipient.codenaam,
          to_count: best.count,
          to_max: effectiveMax.get(`${best.id}|${teller}`) ?? 0,
          category: best.category,
          warning: warningFor(best.category, recipient.codenaam),
        });

        remainingRoom.set(`${best.id}|${teller}`, best.room - 1);
        if (!datesByPerson.has(best.id)) datesByPerson.set(best.id, new Set());
        datesByPerson.get(best.id)!.add(slot.datum);
        excess -= 1;
      }
    }
  }

  return suggestions;
}

/**
 * Pre-publication validation.
 *
 * Publishing is the moment a roster becomes real to staff: the period is
 * frozen and every pool member is notified that these are their shifts. So
 * the same checks the planner sees in the dialog have to hold on the server
 * too - the dialog's disabled button is a convenience, not a guarantee, and
 * a direct POST to /publish bypassed it entirely (verified: it published a
 * roster with zero assignments and notified everyone).
 *
 * Shared by the publication-check endpoint and the publish route so the two
 * can never disagree about what "ready" means.
 *
 * Two different kinds of problem live here, and they used to all be treated
 * the same way (`issues`, hard-blocking `valid = false`):
 *
 *   - `issues` - the roster is genuinely not finished: slots nobody was
 *     assigned to. Publishing stays blocked until these are actually fixed.
 *   - `warnings` - a rule the roster deliberately breaks, on a planner's own
 *     say-so. The solver itself can never produce an ABSOLUUT violation or a
 *     window-rule violation - both are hard constraints on its side - so
 *     finding one here means a planner manually overrode it (manual-assign
 *     explicitly allows that, "in consultation with the person taking the
 *     shift" - see lib/windowRule.ts and the manual-assign route), or, for
 *     the window rule, two participants agreed to a swap that puts one of
 *     them two shifts close together (their own call - see
 *     lib/swapWindowRule.ts). Blocking
 *     publication on the same override the planner just made on purpose was
 *     a contradiction: there was no way to ship a roster that used that
 *     override at all. These require explicit confirmation
 *     (`requiresConfirmation`) before /publish will proceed, but do not by
 *     themselves make `valid` false.
 *
 *     A band violation (someone outside their streefbereik) belongs here
 *     too, not in `issues` - and for a similar, if not identical, reason.
 *     The band's upper bound genuinely is a hard constraint on the solver's
 *     side (MAX_BAND_OVERSHOOT = 0, solver/constraints.py), so going over
 *     max can only come from a manual override afterward, same as an
 *     ABSOLUUT or window-rule violation. Going under the minimum is
 *     different again: the solver leaves `under` fully soft on purpose
 *     ("a hard minimum could make the whole model infeasible outright when
 *     demand and supply don't line up", per that same file) - so a roster
 *     can legitimately come straight out of the solver with someone short
 *     of their target, when there simply isn't enough coverage to go
 *     around. Either way, a planner may have a real reason to ship the
 *     roster anyway (nobody else available, a promise to make it up next
 *     period) - and until now there was no way to do that at all, only to
 *     go back and reassign shifts by hand until the numbers lined up.
 */

import { db } from '@/db/client';
import {
  TELLERS,
  countSlotsByTeller,
  resolveBands,
  resolveRulesetConfig,
  resolveWindowWeeks,
  scaledBandForMember,
  type BandsByTeller,
} from '@/lib/rosterBands';
import { countWindowRuleViolations } from '@/lib/windowRule';
import { computeCoverageFactor } from '@/lib/coverageFactor';

export interface PublicationCheckResult {
  valid: boolean;
  requiresConfirmation: boolean;
  issues: string[];
  warnings: string[];
  checks: {
    slots_filled: boolean;
    no_hard_blocking: boolean;
    band_compliance: boolean;
    window_compliance: boolean;
  };
  bands: BandsByTeller;
  totals: {
    total_slots: number;
    assigned_slots: number;
    people_affected: number;
  };
}

interface PeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

export function runPublicationCheck(period: PeriodRow): PublicationCheckResult {
  const periodId = period.id;
  const issues: string[] = [];
  const warnings: string[] = [];

  const slots = db
    .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
    .get(periodId) as { count: number };
  const assignedSlots = db
    .prepare('SELECT COUNT(*) as count FROM dienstrooster_assignment WHERE schedule_version_id = ?')
    .get(periodId) as { count: number };

  const slotsFilled = slots.count === assignedSlots.count;
  if (!slotsFilled) {
    issues.push(`Nog niet alle diensten zijn ingedeeld (${assignedSlots.count} van ${slots.count} ingevuld)`);
  }

  const blockingViolations = db
    .prepare(
      `SELECT COUNT(*) as count FROM dienstrooster_assignment a
       JOIN dienstrooster_availability av ON a.person_id = av.person_id AND a.slot_id = av.slot_id
       WHERE a.schedule_version_id = ? AND av.blocking_level = 'ABSOLUUT'`
    )
    .get(periodId) as { count: number };

  if (blockingViolations.count > 0) {
    // A warning, not an issue: the solver can never produce this (ABSOLUUT
    // is a hard constraint on its side), so every one of these is a
    // planner's own deliberate manual-assign override, already made and
    // already in the audit trail. Blocking publication on it would mean
    // that override could never actually be shipped.
    warnings.push(
      `${blockingViolations.count} toewijzing(en) staan op een dag die geblokkeerd is voor die persoon. ` +
        `Controleer of dit bewust is afgesproken met de betrokkene(n).`
    );
  }

  const windowViolations = countWindowRuleViolations(periodId, resolveWindowWeeks(resolveRulesetConfig(period)));
  if (windowViolations > 0) {
    // Same reasoning as the ABSOLUUT check above: the solver never breaks
    // the window rule, so a violation here is a deliberate choice - a
    // planner's manual-assign override, or a swap two participants agreed
    // to themselves (see lib/swapWindowRule.ts).
    warnings.push(
      `${windowViolations}x staat iemand twee diensten binnen het venster van elkaar. ` +
        `Controleer of dit bewust is afgesproken met de betrokkene(n).`
    );
  }

  // Band compliance, per counter, against this period's own frozen ruleset.
  // Counting a person's assignments across all counters and comparing that
  // total against a single band mixes three unrelated quotas.
  const members = db
    .prepare(
      `SELECT p.id, pm.deelnamefactor, pm.geldig_vanaf, pm.geldig_tot FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{
    id: string;
    deelnamefactor: number;
    geldig_vanaf: string;
    geldig_tot: string;
  }>;

  const config = resolveRulesetConfig(period);
  const bands = resolveBands(config, countSlotsByTeller(periodId), members.length);

  // Under NAAR_RATO, the solver (constraints.add_band_constraints) doesn't
  // hold a part-timer to the same band as everyone else - it scales
  // base_min/base_max by their deelnamefactor first (floor/ceil, so a
  // band's width never collapses to 0 the way rounding both ends the same
  // way can). This check used to always compare against the flat,
  // full-time `bands` regardless of distribution_mode, so under NAAR_RATO
  // it flagged *every* part-timer as "outside their band" - a roster the
  // solver built correctly could never pass this gate, and the message
  // it showed (adjust the band, or manually move people) couldn't
  // actually fix that, since the real target per person was never wrong.
  const naarRato = config.distributionMode === 'NAAR_RATO';
  const distributionMode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';

  const perPerson = db
    .prepare(
      `SELECT a.person_id, st.teller, COUNT(*) as count
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       GROUP BY a.person_id, st.teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; count: number }>;

  const counts = new Map<string, number>();
  for (const row of perPerson) counts.set(`${row.person_id}|${row.teller}`, row.count);

  const ledger = db
    .prepare(
      `SELECT person_id, teller, SUM(delta) as total
       FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ?
       GROUP BY person_id, teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; total: number }>;

  const deltas = new Map<string, number>();
  for (const row of ledger) deltas.set(`${row.person_id}|${row.teller}`, row.total || 0);

  // Everyone in the pool, not just people who already have an assignment -
  // somebody scheduled zero times is exactly what a band's lower bound is for.
  let bandViolations = 0;
  let anyPartialCoverage = false;
  for (const member of members) {
    if (computeCoverageFactor(member.geldig_vanaf, member.geldig_tot, period.start_datum, period.eind_datum) < 1) {
      anyPartialCoverage = true;
    }
    for (const teller of TELLERS) {
      const key = `${member.id}|${teller}`;
      const [min, max] = scaledBandForMember(bands, teller, member, period, distributionMode);
      const delta = deltas.get(key) || 0;
      const count = counts.get(key) || 0;
      if (count < min + delta || count > max + delta) bandViolations++;
    }
  }

  if (bandViolations > 0) {
    const scalingNotes = [
      anyPartialCoverage ? 'Voor wie een deel van de periode meedraait, is het bereik automatisch naar rato verlaagd.' : null,
      naarRato ? 'Bij naar-rato-verdeling is het bereik geschaald naar ieders deelnamefactor.' : null,
    ].filter((note): note is string => note !== null);

    // A warning, not an issue: going over the band max can only be a
    // deliberate manual override (the solver itself never assigns past
    // it), and going under the min can be a genuine, unavoidable solver
    // outcome when there simply isn't enough coverage to go around (see
    // this module's own doc comment) - either way, blocking publication
    // outright leaves no way to ship the roster except reassigning shifts
    // by hand until the numbers line up, even when a planner has already
    // decided that's not worth it (nobody else available, made up next
    // period, etc.).
    warnings.push(
      `${bandViolations}x valt een persoon buiten het streefbereik voor een diensttype ` +
        `(avond ${bands.AVOND[0]} tot ${bands.AVOND[1]}, ` +
        `weekend ${bands.WEEKEND[0]} tot ${bands.WEEKEND[1]}, ` +
        `feestdag ${bands.FEESTDAG[0]} tot ${bands.FEESTDAG[1]}).` +
        (scalingNotes.length > 0 ? ` ${scalingNotes.join(' ')}` : '') +
        ` Controleer of dit bewust is. Is het dat niet, pas dan het streefbereik aan bij de instellingen ` +
        `van deze periode of wissel handmatig wie welke dienst draait.`
    );
  }

  return {
    valid: issues.length === 0,
    requiresConfirmation: warnings.length > 0,
    issues,
    warnings,
    checks: {
      slots_filled: slotsFilled,
      no_hard_blocking: blockingViolations.count === 0,
      band_compliance: bandViolations === 0,
      window_compliance: windowViolations === 0,
    },
    bands,
    totals: {
      total_slots: slots.count,
      assigned_slots: assignedSlots.count,
      people_affected: members.length,
    },
  };
}

/**
 * POST /api/planner/period/[id]/generate-roster
 *
 * Initiates roster generation using CP-SAT solver.
 * Fetches constraints, calls solver service, stores assignments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveBands, resolveRulesetConfig, type Teller } from '@/lib/rosterBands';
import { clearSolverAssignments, getManuallyFilledSlotIds } from '@/lib/rosterGaps';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const actorId = auth!.userId;

    const periodId = params.id;
    const now = dateToISO(new Date());

    // Fetch period
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    // GEGENEREERD is included so a planner can regenerate - e.g. after
    // manually filling some gaps and wanting the solver to take another
    // pass at the rest, or after a preference changed. GEPUBLICEERD stays
    // excluded: regenerating after publish would silently invalidate a
    // roster staff have already been told about.
    if (!['CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD'].includes(period.status)) {
      return NextResponse.json(
        { success: false, error: `Cannot generate roster for period in ${period.status} status` },
        { status: 400 }
      );
    }

    // Only require overloop confirmation when there's actually a previous
    // published period to carry over from - a pool's first-ever period has
    // nothing to confirm.
    if (!period.overloop_bevestigd_op) {
      const hasPreviousPeriod = db
        .prepare(
          `SELECT id FROM dienstrooster_schedule_period
           WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND eind_datum < ?
           LIMIT 1`
        )
        .get(period.pool_id, period.start_datum);

      if (hasPreviousPeriod) {
        return NextResponse.json(
          {
            success: false,
            error: 'Prior assignments must be confirmed before generating the roster',
          },
          { status: 400 }
        );
      }
    }

    // Fetch slots (joined to shift_type for the teller - the solver
    // matches slots to counters by this name, not by shift_type_id)
    const allSlots = db
      .prepare(
        `SELECT s.*, st.teller
         FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.period_id = ?`
      )
      .all(periodId) as any[];

    if (allSlots.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No slots found. Generate slots first.' },
        { status: 400 }
      );
    }

    // Regenerating must not collide with (or silently overwrite) slots a
    // planner already filled in by hand - dienstrooster_assignment has a
    // UNIQUE(schedule_version_id, slot_id) constraint, and re-solving from
    // scratch has no notion of "this one's already spoken for" otherwise.
    // Exclude those slots from the solver's problem entirely rather than
    // just filtering the insert afterward, so the solver doesn't waste a
    // candidate trying to double-fill an already-covered shift.
    const manuallyFilledSlotIds = getManuallyFilledSlotIds(periodId);
    const slots = allSlots.filter((s) => !manuallyFilledSlotIds.has(s.id));

    // Fetch pool members whose membership window covers this period
    // (membership windows are open-ended, not scoped to one period)
    const poolMembers = db
      .prepare(
        `SELECT person_id FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
      )
      .all(period.pool_id, period.eind_datum, period.start_datum) as any[];

    const people = poolMembers.map((m) => m.person_id);

    if (people.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No active pool members' },
        { status: 400 }
      );
    }

    // Build parameterized placeholders for SQL IN clauses
    const personPlaceholders = people.map(() => '?').join(',');
    const slotPlaceholders = slots.map(() => '?').join(',');
    const slotIdList = slots.map((s) => s.id);

    // Fetch preferences
    const preferences = db
      .prepare(
        `SELECT * FROM dienstrooster_availability
         WHERE person_id IN (${personPlaceholders}) AND slot_id IN (${slotPlaceholders})`
      )
      .all(...people, ...slotIdList) as any[];

    // Build person preferences map
    const personPreferences: Record<string, Array<{ slot_id: string; blocking_level: string }>> = {};

    for (const person of people) {
      personPreferences[person] = preferences
        .filter((p) => p.person_id === person)
        .map((p) => ({
          slot_id: p.slot_id,
          blocking_level: p.blocking_level || 'NEUTRAL',
        }));
    }

    // Fetch balances (ledger sum per person per counter)
    const ledgerEntries = db
      .prepare(
        `SELECT person_id, teller, SUM(delta) as total
         FROM dienstrooster_ledger_entry
         WHERE geldt_voor_periode_id = ? AND person_id IN (${personPlaceholders})
         GROUP BY person_id, teller`
      )
      .all(periodId, ...people) as any[];

    const balances: Record<string, Record<string, number>> = {};
    for (const person of people) {
      balances[person] = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 };
    }

    for (const entry of ledgerEntries) {
      if (!balances[entry.person_id]) {
        balances[entry.person_id] = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 };
      }
      balances[entry.person_id][entry.teller] = entry.total || 0;
    }

    // Periods freeze their ruleset as JSON when opened (schedule_period has
    // no ruleset_id column - a period is never live-linked to a ruleset
    // row, so later edits to the pool's ruleset can't retroactively change
    // an open period). Fall back to the pool's current ruleset for periods
    // that predate that freeze happening.
    //
    // Shared with publication-check via lib/rosterBands so the gate before
    // publishing judges the roster by the same bands it was built with.
    const config = resolveRulesetConfig(period);

    const slotCountByTeller: Record<Teller, number> = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 };
    for (const s of slots) {
      if (s.teller in slotCountByTeller) slotCountByTeller[s.teller as Teller]++;
    }
    const bands = resolveBands(config, slotCountByTeller, people.length);

    // Build solver request
    const solverInput = {
      period_id: periodId,
      slots: slots.map((s) => ({
        id: s.id,
        datum: s.datum,
        iso_jaar: s.iso_jaar,
        iso_week: s.iso_week,
        shift_type_id: s.shift_type_id,
        shift_type_name: s.teller,
        benodigd_aantal_personen: s.benodigd_aantal_personen || 1,
        is_feestdag: s.is_feestdag || false,
        feestdag_groep: s.feestdag_groep || null,
      })),
      person_preferences: personPreferences,
      people,
      rules: {
        // `|| 2` would silently replace an explicit 0 (no minimum gap
        // between shifts, a valid planner choice) with 2 - only fall back
        // when the value is genuinely absent.
        window_weeks: typeof config.windowWeeks === 'number' ? config.windowWeeks : 2,
        band_avond: bands.AVOND,
        band_weekend: bands.WEEKEND,
        band_feestdag: bands.FEESTDAG,
        distribution_mode: (config.distributionMode as string) || 'GELIJK',
      },
      balances,
      active_people: people.length,
    };

    // Call solver service
    const solverUrl = process.env.SOLVER_URL || 'http://solver:8000';
    const solverResponse = await fetch(`${solverUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(solverInput),
    });

    if (!solverResponse.ok) {
      const error = await solverResponse.text();
      return NextResponse.json(
        { success: false, error: `Solver error: ${error}` },
        { status: 500 }
      );
    }

    const solverOutput = await solverResponse.json();

    if (!solverOutput.success) {
      // Capacity and band limits are soft constraints (see solver/constraints.py),
      // so the solver almost always returns a best-effort roster even when
      // there aren't enough people - this only fires when no assignment at
      // all is possible without breaking a hard rule (ABSOLUUT block,
      // window rule), or the solver genuinely errored. A real business
      // outcome, not a server fault, so 422 rather than 500.
      return NextResponse.json(
        { success: false, error: solverOutput.message || 'Solver failed' },
        { status: 422 }
      );
    }

    // Clear this period's previous solver attempt (a regenerate replaces
    // it) - but never touch MANUAL/OVERRIDE rows, and the slots they cover
    // were already excluded from the solver's input above, so there's no
    // conflict when inserting the fresh results below.
    clearSolverAssignments(periodId);

    // Store assignments using raw SQL
    let assignmentCount = 0;
    const insertStmt = db.prepare(
      `INSERT INTO dienstrooster_assignment
       (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const assign of solverOutput.assignments) {
      insertStmt.run(
        uuid(),
        periodId,
        assign.person_id,
        assign.slot_id,
        'SOLVER',
        1,
        now
      );
      assignmentCount++;
    }

    // Update period status to GEGENEREERD (matches the PeriodStatus enum -
    // publish and manual-assign both gate on this exact value)
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = ?, row_version = row_version + 1
       WHERE id = ?`
    ).run('GEGENEREERD', periodId);

    // Enrich the solver's bare slot IDs with what the planner actually
    // needs to see to fill a gap by hand: date and shift type.
    const slotById = new Map(slots.map((s) => [s.id, s]));
    const unfilledSlots = (solverOutput.diagnostics.unfilled_slots || []).map(
      (u: { slot_id: string; shortfall: number }) => {
        const slot = slotById.get(u.slot_id);
        return {
          slot_id: u.slot_id,
          shortfall: u.shortfall,
          datum: slot?.datum ?? null,
          teller: slot?.teller ?? null,
        };
      }
    );

    // Log audit entry
    db.prepare(
      `INSERT INTO dienstrooster_audit_log
       (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      actorId,
      'schedule_period',
      periodId,
      'GENERATE_ROSTER',
      JSON.stringify({ status: period.status }),
      JSON.stringify({
        status: 'GEGENEREERD',
        assignments_created: assignmentCount,
        unfilled_slots: unfilledSlots.length,
        cost: solverOutput.diagnostics.total_cost,
      }),
      now
    );

    return NextResponse.json({
      success: true,
      data: {
        assignments_created: assignmentCount,
        unfilled_slots: unfilledSlots,
        fully_covered: unfilledSlots.length === 0,
        cost: solverOutput.diagnostics.total_cost,
        violations: solverOutput.diagnostics.violations,
        time_seconds: solverOutput.diagnostics.time_seconds,
        solver_status: solverOutput.diagnostics.solver_status,
      },
    });
  } catch (error) {
    return internalErrorResponse('generate-roster', error);
  }
}

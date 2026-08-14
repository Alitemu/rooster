/**
 * POST /api/planner/period/[id]/generate-roster
 *
 * Initiates roster generation using the CP-SAT solver.
 * Fetches preferences and rules, sends to solver service, stores assignments.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import {
  auditLog,
  assignment,
  schedulePeriod,
  shiftSlot,
  poolMembership,
  availability,
  ledgerEntry,
  ruleset,
} from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const periodId = params.id;
    const now = dateToISO(new Date());

    // Fetch period
    const period = db
      .select()
      .from(schedulePeriod)
      .where(eq(schedulePeriod.id, periodId))
      .get();

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    if (!['CONCEPT', 'OPEN'].includes(period.status)) {
      return NextResponse.json(
        { success: false, error: `Cannot generate roster for period in ${period.status} status` },
        { status: 400 }
      );
    }

    // Fetch slots for period
    const slots = db
      .select()
      .from(shiftSlot)
      .where(eq(shiftSlot.period_id, periodId))
      .all();

    if (slots.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No slots found for period. Generate slots first.' },
        { status: 400 }
      );
    }

    // Fetch pool membership to get active people
    const poolMembers = db
      .select()
      .from(poolMembership)
      .where(
        and(
          eq(poolMembership.pool_id, period.pool_id),
          eq(poolMembership.geldig_vanaf, period.start_datum),
          eq(poolMembership.geldig_tot, period.eind_datum)
        )
      )
      .all();

    const people = poolMembers.map((m) => m.person_id);

    // Fetch preferences (availability entries)
    const preferences = db
      .select()
      .from(availability)
      .where(
        and(
          inArray(availability.person_id, people),
          inArray(
            availability.slot_id,
            slots.map((s) => s.id)
          )
        )
      )
      .all();

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
      .select({
        person_id: ledgerEntry.person_id,
        teller: ledgerEntry.teller,
        total: sql<number>`sum(${ledgerEntry.delta})`,
      })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.geldt_voor_periode_id, periodId),
          inArray(ledgerEntry.person_id, people)
        )
      )
      .groupBy(ledgerEntry.person_id, ledgerEntry.teller)
      .all();

    const balances: Record<string, Record<string, number>> = {};
    for (const person of people) {
      balances[person] = {
        AVOND: 0,
        WEEKEND: 0,
        FEESTDAG: 0,
      };
    }

    for (const entry of ledgerEntries) {
      if (!balances[entry.person_id]) {
        balances[entry.person_id] = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 };
      }
      balances[entry.person_id][entry.teller] = entry.total || 0;
    }

    // Fetch ruleset
    const rulesetData = db
      .select()
      .from(ruleset)
      .where(eq(ruleset.id, period.ruleset_id))
      .get();

    if (!rulesetData) {
      return NextResponse.json(
        { success: false, error: 'Ruleset not found' },
        { status: 400 }
      );
    }

    const config = JSON.parse(rulesetData.config_json || '{}');

    // Build solver request
    const solverInput = {
      period_id: periodId,
      slots: slots.map((s) => ({
        id: s.id,
        datum: s.datum,
        iso_jaar: s.iso_jaar,
        iso_week: s.iso_week,
        shift_type_id: s.shift_type_id,
        shift_type_name: s.shift_type_id, // Will be looked up
        benodigd_aantal_personen: s.benodigd_aantal_personen,
        is_feestdag: s.is_feestdag,
        feestdag_groep: s.feestdag_groep,
      })),
      person_preferences: personPreferences,
      people,
      rules: {
        window_weeks: config.windowWeeks || 2,
        band_avond: config.bandAvond || [7, 8],
        band_weekend: config.bandWeekend || [7, 8],
        band_feestdag: config.bandFeestdag || [7, 8],
        distribution_mode: config.distributionMode || 'GELIJK',
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
      return NextResponse.json(
        { success: false, error: solverOutput.message || 'Solver failed' },
        { status: 500 }
      );
    }

    // Store assignments in database
    let assignmentCount = 0;

    for (const assignment of solverOutput.assignments) {
      const assignmentId = uuid();

      db.insert(assignment)
        .values({
          id: assignmentId,
          schedule_version_id: periodId,
          person_id: assignment.person_id,
          slot_id: assignment.slot_id,
          bron: 'SOLVER',
          row_version: 1,
          aangemaakt_op: now,
        })
        .run();

      assignmentCount++;
    }

    // Update period status to GENERATED
    db.update(schedulePeriod)
      .set({
        status: 'GENERATED',
        row_version: (period.row_version || 1) + 1,
      })
      .where(eq(schedulePeriod.id, periodId))
      .run();

    // Log audit entry
    db.insert(auditLog)
      .values({
        id: uuid(),
        actor_id: 'system', // TODO: get actual user ID
        entiteit: 'schedule_period',
        entiteit_id: periodId,
        actie: 'GENERATE_ROSTER',
        oud_json: JSON.stringify({ status: period.status }),
        nieuw_json: JSON.stringify({
          status: 'GENERATED',
          assignments_created: assignmentCount,
          cost: solverOutput.diagnostics.total_cost,
        }),
        tijdstip: now,
      })
      .run();

    return NextResponse.json({
      success: true,
      data: {
        assignments_created: assignmentCount,
        cost: solverOutput.diagnostics.total_cost,
        violations: solverOutput.diagnostics.violations,
        time_seconds: solverOutput.diagnostics.time_seconds,
        solver_status: solverOutput.diagnostics.solver_status,
      },
    });
  } catch (error) {
    console.error('Roster generation error:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

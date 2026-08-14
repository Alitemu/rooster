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
import { getAuthContextFromRequest } from '@/lib/auth-context';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Extract auth context (TODO: implement real auth)
    const auth = getAuthContextFromRequest(request);
    const actorId = auth?.userId || 'system';

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

    if (!['CONCEPT', 'OPEN'].includes(period.status)) {
      return NextResponse.json(
        { success: false, error: `Cannot generate roster for period in ${period.status} status` },
        { status: 400 }
      );
    }

    // Fetch slots
    const slots = db
      .prepare('SELECT * FROM dienstrooster_shift_slot WHERE period_id = ?')
      .all(periodId) as any[];

    if (slots.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No slots found. Generate slots first.' },
        { status: 400 }
      );
    }

    // Fetch pool members (active people)
    const poolMembers = db
      .prepare(
        `SELECT person_id FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND geldig_vanaf = ? AND geldig_tot = ?`
      )
      .all(period.pool_id, period.start_datum, period.eind_datum) as any[];

    const people = poolMembers.map((m) => m.person_id);

    if (people.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No active pool members' },
        { status: 400 }
      );
    }

    // Build person IDs list for SQL IN clause
    const personIds = people.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
    const slotIds = slots.map((s) => `'${s.id.replace(/'/g, "''")}'`).join(',');

    // Fetch preferences
    const preferences = db
      .prepare(
        `SELECT * FROM dienstrooster_availability
         WHERE person_id IN (${personIds}) AND slot_id IN (${slotIds})`
      )
      .all() as any[];

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
         WHERE geldt_voor_periode_id = ? AND person_id IN (${personIds})
         GROUP BY person_id, teller`
      )
      .all(periodId) as any[];

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

    // Fetch ruleset
    const rulesetData = db
      .prepare('SELECT * FROM dienstrooster_ruleset WHERE id = ?')
      .get(period.ruleset_id) as any;

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
        shift_type_name: s.shift_type_id,
        benodigd_aantal_personen: s.benodigd_aantal_personen || 1,
        is_feestdag: s.is_feestdag || false,
        feestdag_groep: s.feestdag_groep || null,
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

    // Update period status to GENERATED
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET status = ?, row_version = row_version + 1
       WHERE id = ?`
    ).run('GENERATED', periodId);

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
        status: 'GENERATED',
        assignments_created: assignmentCount,
        cost: solverOutput.diagnostics.total_cost,
      }),
      now
    );

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

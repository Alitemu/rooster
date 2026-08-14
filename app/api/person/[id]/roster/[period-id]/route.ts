/**
 * GET /api/person/[id]/roster/[period-id]
 *
 * Get personal roster for a period (only after PUBLISHED).
 * Shows assignments with details and saldo impact.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string; 'period-id': string } }
) {
  try {
    const personId = params.id;
    const periodId = params['period-id'];

    // Verify person exists
    const person = db
      .prepare('SELECT * FROM dienstrooster_person WHERE id = ?')
      .get(personId) as any;

    if (!person) {
      return NextResponse.json(
        { success: false, error: 'Person not found' },
        { status: 404 }
      );
    }

    // Verify period exists and is published
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEPUBLICEERD') {
      return NextResponse.json(
        { success: false, error: 'Roster not yet published' },
        { status: 403 }
      );
    }

    // Get person's assignments
    const assignments = db
      .prepare(
        `SELECT
          a.id,
          a.slot_id,
          s.datum,
          s.iso_week,
          s.shift_type_id,
          a.aangemaakt_op
         FROM dienstrooster_assignment a
         JOIN dienstrooster_shift_slot s ON a.slot_id = s.id
         WHERE a.schedule_version_id = ? AND a.person_id = ?
         ORDER BY s.datum ASC`
      )
      .all(periodId, personId) as any[];

    // Count by shift type
    const byShiftType: Record<string, number> = {
      AVOND: 0,
      WEEKEND: 0,
      FEESTDAG: 0,
    };

    for (const a of assignments) {
      if (byShiftType.hasOwnProperty(a.shift_type_id)) {
        byShiftType[a.shift_type_id]++;
      }
    }

    // Get ledger balance for this period
    const ledger = db
      .prepare(
        `SELECT teller, SUM(delta) as total
         FROM dienstrooster_ledger_entry
         WHERE geldt_voor_periode_id = ? AND person_id = ?
         GROUP BY teller`
      )
      .all(periodId, personId) as any[];

    const balances: Record<string, number> = {
      AVOND: 0,
      WEEKEND: 0,
      FEESTDAG: 0,
    };

    for (const entry of ledger) {
      balances[entry.teller] = entry.total || 0;
    }

    return NextResponse.json({
      success: true,
      data: {
        person: {
          id: personId,
          codenaam: person.codenaam,
        },
        period: {
          id: periodId,
          naam: period.naam,
          start_datum: period.start_datum,
          eind_datum: period.eind_datum,
          gepubliceerd_op: period.gepubliceerd_op,
        },
        assignments,
        summary: {
          total_assignments: assignments.length,
          by_shift_type: byShiftType,
          balances,
        },
      },
    });
  } catch (error) {
    console.error('Roster viewing error:', error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

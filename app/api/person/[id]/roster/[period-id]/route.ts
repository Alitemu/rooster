/**
 * GET /api/person/[id]/roster/[period-id]
 *
 * Get personal roster for a period (only after PUBLISHED).
 * Shows assignments with details and saldo impact.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import { resolveRulesetConfig, resolveBands, countSlotsByTeller, TELLERS, type Teller } from '@/lib/rosterBands';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; 'period-id': string } }
) {
  try {
    const personId = params.id;
    const periodId = params['period-id'];

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    // Verify person exists
    const person = db
      .prepare('SELECT * FROM dienstrooster_person WHERE id = ?')
      .get(personId) as any;

    if (!person) {
      return NextResponse.json(
        { success: false, error: 'Persoon niet gevonden' },
        { status: 404 }
      );
    }

    // Verify period exists and is published
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Periode niet gevonden' },
        { status: 404 }
      );
    }

    if (period.status !== 'GEPUBLICEERD') {
      return NextResponse.json(
        { success: false, error: 'Roster not yet published' },
        { status: 403 }
      );
    }

    // Get person's assignments (joined to shift_type for the teller -
    // shift_type_id is a UUID, not one of the AVOND/WEEKEND/FEESTDAG counters)
    const assignments = db
      .prepare(
        `SELECT
          a.id,
          a.slot_id,
          s.datum,
          s.iso_week,
          s.shift_type_id,
          st.teller,
          a.aangemaakt_op
         FROM dienstrooster_assignment a
         JOIN dienstrooster_shift_slot s ON a.slot_id = s.id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
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
      if (byShiftType.hasOwnProperty(a.teller)) {
        byShiftType[a.teller]++;
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

    // The target band shown to the participant must be the exact same one
    // the solver actually enforced when building this roster - not a
    // separately-eyeballed number that could quietly disagree with it.
    const config = resolveRulesetConfig(period);
    const slotCountByTeller = countSlotsByTeller(periodId);
    const activePeople = db
      .prepare(
        `SELECT COUNT(*) as count FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
      )
      .get(period.pool_id, period.eind_datum, period.start_datum) as { count: number };
    const baseBands = resolveBands(config, slotCountByTeller, activePeople.count);

    const membership = db
      .prepare(
        `SELECT deelnamefactor FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
      )
      .get(period.pool_id, personId, period.eind_datum, period.start_datum) as
      | { deelnamefactor: number }
      | undefined;
    const factor = membership?.deelnamefactor ?? 1;
    const naarRato = config.distributionMode === 'NAAR_RATO';

    const targetBands: Record<Teller, { min: number; max: number }> = {
      AVOND: { min: 0, max: 0 },
      WEEKEND: { min: 0, max: 0 },
      FEESTDAG: { min: 0, max: 0 },
    };
    for (const teller of TELLERS) {
      const [baseMin, baseMax] = baseBands[teller];
      const scaledMin = naarRato ? Math.round(baseMin * factor) : baseMin;
      const scaledMax = naarRato ? Math.max(scaledMin, Math.round(baseMax * factor)) : baseMax;
      const delta = balances[teller];
      targetBands[teller] = { min: scaledMin + delta, max: scaledMax + delta };
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
          target_bands: targetBands,
        },
      },
    });
  } catch (error) {
    return internalErrorResponse('roster-view', error);
  }
}

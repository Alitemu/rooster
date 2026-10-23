/**
 * Prior Assignments Auto-Derive Route
 *
 * POST /api/periods/[id]/prior-assignments/auto-derive - Auto-derive from previous period
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { refreshDerivedPriorAssignments } from '@/lib/previousPeriod';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface AutoDeriveResult {
  period_id: string;
  derived_count: number;
  from_previous_period_id: string | null;
  message: string;
}

/**
 * POST /api/periods/[id]/prior-assignments/auto-derive - Auto-derive assignments
 *
 * Derives prior assignments from the previous period's published assignments,
 * as they are now. Only processes the last windowWeeks-1 weeks of the prior period.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS's comes later (lib/aiosPeriod.ts).
    const aiosNotYet = aiosNotYetDenial(params.id);
    if (aiosNotYet) return aiosNotYet;
    // Nothing changes in the prullenbak (lib/periodTrash.ts).
    const inTrash = trashedPeriodDenial(params.id);
    if (inTrash) return inTrash;
    const actorId = auth!.userId;

    const { id } = params;

    // Fetch current period
    const periodStmt = db.prepare(`
      SELECT
        id,
        pool_id,
        start_datum,
        eind_datum,
        bevroren_ruleset_json
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const period = periodStmt.get(id) as any;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }


    // Derived again from the previous roster as it is now: a day someone
    // else works since (a swap) gets them, a day nobody works loses its row,
    // what the planner set by hand stays (lib/previousPeriod.ts). It used
    // to skip every day it already had, so "afleiden" again changed nothing.
    const refresh = refreshDerivedPriorAssignments(id, actorId);

    if (!refresh.previous || !refresh.range) {
      const response: ApiSuccessResponse<AutoDeriveResult> = {
        success: true,
        data: {
          period_id: id,
          derived_count: 0,
          from_previous_period_id: null,
          message: 'Geen vorige gepubliceerde periode gevonden',
        },
      };
      return NextResponse.json(response);
    }

    const [startDate, endDate] = refresh.range;
    const derivedCount = refresh.added + refresh.changed;
    if (derivedCount + refresh.removed > 0) {
      writeAuditLog({
        actorId,
        entiteit: 'schedule_period',
        entiteitId: id,
        actie: refresh.added > 0 && refresh.changed + refresh.removed === 0 ? 'CREATE' : 'UPDATE',
        nieuw: {
          wijziging: 'rooster vooraf afgeleid uit de vorige periode',
          aantal: derivedCount,
          nieuw: refresh.added,
          bijgewerkt: refresh.changed,
          verwijderd: refresh.removed,
          uit_periode: refresh.previous.id,
        },
      });
    }

    const response: ApiSuccessResponse<AutoDeriveResult> = {
      success: true,
      data: {
        period_id: id,
        derived_count: derivedCount,
        from_previous_period_id: refresh.previous.id,
        message:
          derivedCount + refresh.removed > 0
            ? `${derivedCount} toewijzing${derivedCount === 1 ? '' : 'en'} afgeleid uit de vorige periode (${startDate} t/m ${endDate})` +
              (refresh.removed > 0 ? `. ${refresh.removed} dag${refresh.removed === 1 ? '' : 'en'} zonder dienst meer weggehaald.` : '')
            : `Niets nieuws gevonden om af te leiden. De vorige periode had niets in het overloopvenster (${startDate} t/m ${endDate}) of alles stond al goed.`,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('prior-assignments-auto-derive', error);
  }
}

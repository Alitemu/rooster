/**
 * GET /api/aios/deelnemer/[id]/periode/[periodId] - an AIOS's preferences screen for a
 * quarter (lib/aiosPreferences.ts): every dienst per day with their mark,
 * the blocks, what they ask besides, the 50% counters and where their
 * hand-in stands. The achterwacht's screen has its own routes, which refuse
 * an AIOS period (lib/periodAccess.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor, geenAiosDenial } from '@/lib/aiosToegang';
import { internalErrorResponse } from '@/lib/api-errors';
import { aiosVoortgangstoets } from '@/lib/aiosToetsNacht';
import {
  aiosInvoerToegestaan,
  blokkadeTellers,
  loadAiosPeriode,
  loadAiosVoorkeurDagen,
  loadAiosWens,
} from '@/lib/aiosPreferences';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id) ?? geenAiosDenial(id);
    if (denied) return denied;

    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) {
      return NextResponse.json(
        { success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } },
        { status: 404 }
      );
    }

    const dagen = loadAiosVoorkeurDagen(id, periodId);
    const invoer = aiosInvoerToegestaan(period);
    const submission = db
      .prepare('SELECT status, ingediend_op FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(id, periodId) as { status: string; ingediend_op: string | null } | undefined;

    return NextResponse.json({
      success: true,
      data: {
        period: {
          id: period.id,
          naam: period.naam,
          start_datum: period.start_datum,
          eind_datum: period.eind_datum,
          deadline: period.deadline,
          status: period.status,
        },
        dagen,
        wens: loadAiosWens(id, periodId),
        tellers: blokkadeTellers(dagen),
        // The night before it is a fellow's: not in the AIOS's quarter (lib/aiosVoortgangstoets.ts).
        voortgangstoets: aiosVoortgangstoets(periodId),
        indiening: submission ?? null,
        invoer: invoer.ok ? { open: true } : { open: false, reden: invoer.message },
      },
    });
  } catch (error) {
    return internalErrorResponse('aios-preferences', error);
  }
}

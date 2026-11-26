/**
 * GET /api/aios/periode/[id]/voorkeuren - "Status voorkeuren" of an
 * AIOS period: per AIOS taking part, where their hand-in stands, what they
 * marked, what they asked besides and the 50% counters, which warn the
 * planner as they warn the AIOS (lib/aiosVoorkeur.ts). Only for an AIOS
 * period; the achterwacht's dashboard has its own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { blokkadeTellers, loadAiosPeriode, loadAiosVoorkeurDagenVoor, loadAiosWens, telMarkeringen } from '@/lib/aiosPreferences';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;

    const period = loadAiosPeriode(id);
    if (!period) {
      return NextResponse.json(
        { success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } },
        { status: 404 }
      );
    }

    // Everyone the invitations go to (lib/aiosUitnodigen.ts aiosDeelnemers).
    const leden = db
      .prepare(
        `SELECT DISTINCT p.id, p.codenaam, s.status, s.ingediend_op
         FROM dienstrooster_pool_membership pm
         JOIN dienstrooster_person p ON p.id = pm.person_id
         LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = ?
         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
         ORDER BY p.codenaam COLLATE NOCASE`
      )
      .all(id, period.pool_id, period.eind_datum, period.start_datum) as Array<{
      id: string;
      codenaam: string;
      status: string | null;
      ingediend_op: string | null;
    }>;

    const voorkeurDagen = loadAiosVoorkeurDagenVoor(leden.map((l) => l.id), id);
    const deelnemers = leden.map((l) => {
      const dagen = voorkeurDagen.get(l.id)!;
      return {
        person_id: l.id,
        codenaam: l.codenaam,
        status: l.status === 'BEVESTIGD' ? 'INGEDIEND' : l.status === 'BEZIG' ? 'BEZIG' : 'NIET_BEGONNEN',
        ingediend_op: l.ingediend_op,
        markeringen: telMarkeringen(dagen),
        tellers: blokkadeTellers(dagen),
        wens: loadAiosWens(l.id, id),
      };
    });

    return NextResponse.json({ success: true, data: { deelnemers } });
  } catch (error) {
    return internalErrorResponse('planner-aios-voorkeuren', error);
  }
}

/**
 * POST /api/planner/pool/[id]/members/reeks - { van, tot, geldig_vanaf, geldig_tot }
 * adds a reeks of codenamen (lib/codenaamReeks.ts: aios01 tot en met aios30)
 * to the pool, each the way the single form does (lib/poolLeden.ts voegLidToe).
 * Who cannot be added (already in the pool, an account, the other dienst) is
 * skipped and named, the rest is added: the planner adding aios01..aios30
 * with aios05 already there wants the other 29.
 *
 * Every one added is in the audit log (voegLidToe).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { poolDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { validateCodenaam } from '@/lib/codenaam';
import { codenaamReeks } from '@/lib/codenaamReeks';
import { isValidIsoDate } from '@/lib/isoDate';
import { synchroniseer, voegLidToe } from '@/lib/poolLeden';

const fail = (status: number, code: string, message: string) => NextResponse.json({ success: false, error: { code, message } }, { status });

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = poolDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const body = await parseJsonBody<{ van?: unknown; tot?: unknown; geldig_vanaf?: unknown; geldig_tot?: unknown }>(req);
    if (typeof body.van !== 'string' || typeof body.tot !== 'string') return fail(400, 'INVALID_INPUT', 'Vul de eerste en de laatste codenaam van de reeks in.');
    if (!isValidIsoDate(body.geldig_vanaf) || !isValidIsoDate(body.geldig_tot)) return fail(400, 'INVALID_INPUT', 'Datums moeten in het formaat JJJJ-MM-DD staan');
    const vanaf = body.geldig_vanaf as string;
    const tot = body.geldig_tot as string;
    if (vanaf > tot) return fail(400, 'INVALID_RANGE', '"Geldig vanaf" moet vóór of op "geldig tot" liggen');

    const reeks = codenaamReeks(body.van, body.tot);
    if (!reeks.ok) return fail(400, 'INVALID_INPUT', reeks.message);
    for (const codenaam of reeks.codenamen) {
      const check = validateCodenaam(codenaam);
      if (!check.valid) return fail(400, 'INVALID_INPUT', `${codenaam}: ${check.message}`);
    }

    const pool = db.prepare('SELECT id, type FROM dienstrooster_pool WHERE id = ?').get(params.id) as { id: string; type: string } | undefined;
    if (!pool) return fail(404, 'POOL_NOT_FOUND', 'Pool niet gevonden');

    const toegevoegd: string[] = [];
    const overgeslagen: Array<{ codenaam: string; reden: string }> = [];
    for (const codenaam of reeks.codenamen) {
      const uit = voegLidToe(pool, codenaam, vanaf, tot, auth!.userId);
      if (uit.ok) {
        toegevoegd.push(codenaam);
        synchroniseer(uit.personId);
      } else {
        overgeslagen.push({ codenaam, reden: uit.message });
      }
    }
    return NextResponse.json({ success: true, data: { toegevoegd, overgeslagen } }, { status: toegevoegd.length > 0 ? 201 : 200 });
  } catch (error) {
    return internalErrorResponse('planner-pool-members-reeks', error);
  }
}

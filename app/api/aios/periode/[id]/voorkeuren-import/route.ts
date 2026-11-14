/**
 * POST /api/aios/periode/[id]/voorkeuren-import - read the AIOS's
 * voorkeurenoverzicht back in (lib/aiosVoorkeurImport.ts). A test tool,
 * ADMIN only. Body: { bestand: string (the .xlsx as base64), toepassen?:
 * boolean }. Without `toepassen` nothing changes: the response lists what
 * would.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { importeerAiosVoorkeuren } from '@/lib/aiosVoorkeurImport';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const body = (await parseJsonBody(req)) as { bestand?: unknown; toepassen?: unknown } | null;
    const toepassen = body?.toepassen === true;
    const result = importeerAiosVoorkeuren(period, body?.bestand, toepassen);
    if (!result.ok) return aiosFout(result.status, result.code, result.message);
    if (result.toegepast) {
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'period',
        entiteitId: id,
        actie: 'UPDATE',
        nieuw: { wijziging: 'voorkeuren van de AIOS geïmporteerd (test)', aantal: result.plan.wijzigingen.length, personen: result.plan.personen },
      });
    }
    return NextResponse.json({ success: true, data: { ...result.plan, toegepast: result.toegepast } });
  } catch (error) {
    return internalErrorResponse('aios-voorkeuren-import', error);
  }
}

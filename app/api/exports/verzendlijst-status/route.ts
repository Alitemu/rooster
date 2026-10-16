/**
 * GET /api/exports/verzendlijst-status?period_id= - whether this server
 * can send the verzendlijst of that period itself (lib/verzendlijstMail.ts):
 * the Gmail account and the mailbox of the flow of the period's dienst
 * (the AIOS have their own). The export dialog only offers "Automatisch
 * versturen" when it can, and otherwise explains the manual route
 * (download + attach). Without a period: the account's own dienst.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse } from '@/lib/api-errors';
import { verzendlijstMailConfigured } from '@/lib/verzendlijstMail';
import { periodDienstDenial, visibleDienst } from '@/lib/dienstAccess';
import { dienstVanPeriode } from '@/lib/aiosPeriod';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = getAuthContextFromRequest(req);
  if (!requirePlannerAccess(auth)) return unauthorizedResponse();
  const periodId = req.nextUrl.searchParams.get('period_id');
  if (periodId) {
    const denied = periodDienstDenial(auth, periodId);
    if (denied) return denied;
  }
  const dienst = periodId ? dienstVanPeriode(periodId) : (visibleDienst(auth!) ?? 'ACHTERWACHT');
  return NextResponse.json({ success: true, data: { ingesteld: verzendlijstMailConfigured(dienst) } });
}

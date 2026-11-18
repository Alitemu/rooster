/**
 * GET /api/exports/verzendlijst-status - whether this server can send the
 * verzendlijst itself (lib/verzendlijstMail.ts). The export dialog only
 * offers "Automatisch versturen" when it can, and otherwise explains the
 * manual route (download + attach).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse } from '@/lib/api-errors';
import { verzendlijstMailConfigured } from '@/lib/verzendlijstMail';
import { eigenDienstDenial } from '@/lib/dienstAccess';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = getAuthContextFromRequest(req);
  if (!requirePlannerAccess(auth)) return unauthorizedResponse();
  // The achterwacht's flow: the AIOS has its own (app/api/aios/mail-instellingen).
  const andereDienst = eigenDienstDenial(auth!, 'ACHTERWACHT');
  if (andereDienst) return andereDienst;
  return NextResponse.json({ success: true, data: { ingesteld: verzendlijstMailConfigured() } });
}

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
  return NextResponse.json({ success: true, data: { ingesteld: verzendlijstMailConfigured() } });
}

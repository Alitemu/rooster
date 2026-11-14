/**
 * POST /api/admin/back-up/versturen - send a backup now ("Nu een back-up
 * versturen"), changed or not: to try the settings and the flow in OneDrive.
 *
 * The beheerder only. Changes no data (lib/dbBackupMail.ts keeps what went out
 * next to the backups, not in the database), so no audit row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess, requirePlannerAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { backupMailOverzicht, runBackupMail } from '@/lib/dbBackupMail';

export async function POST(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse('Alleen de beheerder kan een back-up versturen.');
    const uit = await runBackupMail(new Date(), { dwingen: true });
    if (uit.uitkomst === 'NIET_INGESTELD') {
      return NextResponse.json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Stel eerst het adres en het back-upwachtwoord in.' } }, { status: 400 });
    }
    if (uit.uitkomst === 'MISLUKT') {
      return NextResponse.json({ success: false, error: { code: 'SEND_FAILED', message: uit.melding } }, { status: 502 });
    }
    return NextResponse.json({ success: true, data: backupMailOverzicht() });
  } catch (error) {
    return internalErrorResponse('backup-versturen', error);
  }
}

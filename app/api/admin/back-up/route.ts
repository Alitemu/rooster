/**
 * GET    /api/admin/back-up - whether the backup by mail is set up, where it
 *        goes, when the last one went out and what went wrong. Never the password.
 * PUT    { aan, wachtwoord? } - the address and the backup password. Leaving
 *        the password out keeps the saved one.
 * DELETE - stop sending backups.
 *
 * The beheerder only: the backup holds the whole database, both diensten.
 * lib/dbBackupMail.ts. Changes are audit-logged, without the password.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthContextFromRequest, requireAdminAccess, requirePlannerAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { MIN_WACHTWOORD_LENGTE } from '@/lib/dbBackupBestand';
import { backupMailOverzicht, deleteBackupInstellingen, getBackupInstellingen, saveBackupInstellingen } from '@/lib/dbBackupMail';

const ALLEEN_BEHEERDER = 'Alleen de beheerder kan de back-up instellen.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (message: string) => NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message } }, { status: 400 });

const putSchema = z.object({
  aan: z.string().trim().max(254),
  wachtwoord: z.string().max(200).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    return NextResponse.json({ success: true, data: backupMailOverzicht() });
  } catch (error) {
    return internalErrorResponse('backup-get', error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);

    const parsed = putSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail('Vul het adres voor de back-up in.');
    const { aan } = parsed.data;
    if (!EMAIL.test(aan)) return fail('Het adres voor de back-up is geen geldig e-mailadres.');

    const opgeslagen = getBackupInstellingen();
    const getypt = parsed.data.wachtwoord ?? '';
    if (getypt && getypt.length < MIN_WACHTWOORD_LENGTE) {
      return fail(`Kies een back-upwachtwoord van minstens ${MIN_WACHTWOORD_LENGTE} tekens.`);
    }
    const wachtwoord = getypt || opgeslagen?.wachtwoord;
    if (!wachtwoord) return fail('Vul het back-upwachtwoord in.');

    saveBackupInstellingen({ aan, wachtwoord }, auth!.userId);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'app_setting',
      entiteitId: 'backup',
      actie: 'UPDATE',
      oud: opgeslagen ? { aan: opgeslagen.aan } : null,
      nieuw: { aan, wachtwoord_gewijzigd: Boolean(getypt) },
    });
    return NextResponse.json({ success: true, data: backupMailOverzicht() });
  } catch (error) {
    return internalErrorResponse('backup-put', error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    const opgeslagen = getBackupInstellingen();
    if (deleteBackupInstellingen()) {
      writeAuditLog({ actorId: auth!.userId, entiteit: 'app_setting', entiteitId: 'backup', actie: 'DELETE', oud: { aan: opgeslagen?.aan ?? null } });
    }
    return NextResponse.json({ success: true, data: backupMailOverzicht() });
  } catch (error) {
    return internalErrorResponse('backup-delete', error);
  }
}

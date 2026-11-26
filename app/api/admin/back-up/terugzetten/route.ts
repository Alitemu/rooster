/**
 * POST /api/admin/back-up/terugzetten - { bestand: string (the backup file as
 * base64), wachtwoord, bevestiging: 'TERUGZETTEN' } replaces the whole
 * database with the one in the backup (lib/dbBackupTerugzetten.ts says how and
 * what it checks first). The copy of the database as it was is kept next to
 * the daily backups.
 *
 * The beheerder only, and only with the word typed: this undoes everything
 * since the backup was made, for both diensten. The body is larger than any
 * other route takes (lib/api-errors.ts MAX_BACKUP_UPLOAD_BYTES).
 *
 * The audit row goes into the restored database, so it says who restored
 * what; it can only be written when the beheerder is in that database too.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requireAdminAccess, requirePlannerAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, MAX_BACKUP_UPLOAD_BYTES, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { BEVESTIGING, TerugzetFout, zetBackupTerug } from '@/lib/dbBackupTerugzetten';

const fail = (status: number, message: string) => NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message } }, { status });

export async function POST(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse('Alleen de beheerder kan een back-up terugzetten.');

    if (Number(req.headers.get('content-length')) > MAX_BACKUP_UPLOAD_BYTES) {
      return fail(413, 'Dit bestand is te groot voor een back-up van Dienstrooster.');
    }
    const body = await parseJsonBody<{ bestand?: unknown; wachtwoord?: unknown; bevestiging?: unknown }>(req, { maxBytes: MAX_BACKUP_UPLOAD_BYTES });
    if (typeof body.bestand !== 'string' || body.bestand.trim() === '') return fail(400, 'Kies eerst een back-upbestand.');
    if (typeof body.wachtwoord !== 'string' || body.wachtwoord === '') return fail(400, 'Vul het back-upwachtwoord in.');
    if (body.bevestiging !== BEVESTIGING) return fail(400, `Typ ${BEVESTIGING} om te bevestigen dat je de huidige gegevens wilt vervangen.`);

    let uit;
    try {
      uit = await zetBackupTerug(Buffer.from(body.bestand, 'base64'), body.wachtwoord);
    } catch (error) {
      if (error instanceof TerugzetFout) return fail(error.status, error.message);
      throw error;
    }

    const bekend = db.prepare('SELECT 1 FROM dienstrooster_person WHERE id = ?').get(auth!.userId);
    if (bekend) {
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'database',
        entiteitId: 'backup',
        actie: 'IMPORT',
        nieuw: { gemaakt_op: uit.kop.gemaakt_op, app_versie: uit.kop.app_versie },
      });
    } else {
      console.warn(`[terugzetten] back-up van ${uit.kop.gemaakt_op} teruggezet door een beheerder die daarin niet bestaat: geen auditregel`);
    }
    return NextResponse.json({
      success: true,
      data: { gemaakt_op: uit.kop.gemaakt_op, app_versie: uit.kop.app_versie, schema_bijgewerkt: uit.schemaBijgewerkt },
    });
  } catch (error) {
    return internalErrorResponse('backup-terugzetten', error);
  }
}

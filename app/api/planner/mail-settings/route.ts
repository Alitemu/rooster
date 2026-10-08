/**
 * GET    /api/planner/mail-settings - whether sending is set up, which
 *        account and which flow mailbox. Never the password.
 * PUT    { gebruiker, wachtwoord?, verzendlijst_aan } - save a Gmail account
 *        and its app password. Logs in first and refuses settings that
 *        don't work. Leaving the password out keeps the saved one.
 * DELETE - remove the settings. Sending then stops.
 *
 * lib/appSettings.ts, lib/verzendlijstMail.ts. Changes are audit-logged,
 * without the password.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { deleteMailSettings, getStoredMailSettings, saveMailSettings } from '@/lib/appSettings';
import { mailConfigStatus, verifyMailLogin } from '@/lib/verzendlijstMail';
import { flushMailQueue } from '@/lib/meldingMail';

const fail = (status: number, message: string) =>
  NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message } }, { status });

function audit(actorId: string, oud: unknown, nieuw: unknown, actie: 'UPDATE' | 'DELETE') {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
     VALUES (?, ?, 'app_setting', 'mail', ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), actorId, actie, JSON.stringify(oud), JSON.stringify(nieuw), new Date().toISOString());
}

export async function GET(req: NextRequest) {
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
    return NextResponse.json({ success: true, data: mailConfigStatus() });
  } catch (error) {
    return internalErrorResponse('mail-settings-get', error);
  }
}

const GMAIL = /^[^\s@]+@(gmail|googlemail)\.com$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const putSchema = z.object({
  gebruiker: z.string().trim().max(254),
  wachtwoord: z.string().max(200).optional(),
  verzendlijst_aan: z.string().trim().max(254),
});

export async function PUT(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();

    const parsed = putSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'Vul het Gmail-adres en het adres voor de verzendlijst in.');
    const { gebruiker, verzendlijst_aan } = parsed.data;

    if (!GMAIL.test(gebruiker)) {
      return fail(400, 'Dienstrooster verstuurt alleen via Gmail. Vul een adres in dat eindigt op @gmail.com.');
    }
    if (!EMAIL.test(verzendlijst_aan)) {
      return fail(400, 'Het adres voor de verzendlijst is geen geldig e-mailadres.');
    }

    // Leaving the password empty keeps the saved one - only for the same
    // account, so a changed address can't silently borrow another's password.
    const stored = getStoredMailSettings();
    const typed = parsed.data.wachtwoord?.replace(/\s+/g, '') ?? '';
    const wachtwoord =
      typed || (stored && stored.gebruiker.toLowerCase() === gebruiker.toLowerCase() ? stored.wachtwoord : null);
    if (!wachtwoord) return fail(400, 'Vul het app-wachtwoord in.');
    if (typed && !/^[a-z]{16}$/i.test(typed)) {
      return fail(
        400,
        'Een app-wachtwoord van Google bestaat uit 16 letters. Gebruik niet je gewone wachtwoord, maar maak een app-wachtwoord aan.'
      );
    }

    const login = await verifyMailLogin(gebruiker, wachtwoord);
    if (!login.ok) return fail(400, login.message);

    const before = mailConfigStatus();
    saveMailSettings({ gebruiker, wachtwoord, verzendlijstAan: verzendlijst_aan }, auth!.userId);
    audit(
      auth!.userId,
      { gebruiker: before.gebruiker, verzendlijst_aan: before.verzendlijst_aan },
      { gebruiker, verzendlijst_aan, wachtwoord_gewijzigd: Boolean(typed) },
      'UPDATE'
    );
    // Swap mails that waited for working settings go out now, not at the
    // next hourly run. Not awaited: the queue may take a while.
    void flushMailQueue();
    return NextResponse.json({ success: true, data: mailConfigStatus() });
  } catch (error) {
    return internalErrorResponse('mail-settings-put', error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const before = mailConfigStatus();
    if (deleteMailSettings()) {
      audit(auth!.userId, { gebruiker: before.gebruiker, verzendlijst_aan: before.verzendlijst_aan }, null, 'DELETE');
    }
    return NextResponse.json({ success: true, data: mailConfigStatus() });
  } catch (error) {
    return internalErrorResponse('mail-settings-delete', error);
  }
}

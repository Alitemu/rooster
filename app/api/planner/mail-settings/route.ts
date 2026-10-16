/**
 * GET    /api/planner/mail-settings - whether sending is set up, which
 *        account and which flow mailbox. Never the password.
 * PUT    { gebruiker, wachtwoord?, verzendlijst_aan, verzendlijst_aan_aios? } -
 *        save a Gmail account and its app password, and the mailbox of each
 *        dienst's flow. Logs in first and refuses settings that don't work.
 *        Leaving the password out keeps the saved one; leaving the AIOS
 *        mailbox out keeps the saved one, an empty one removes it.
 * DELETE - remove the settings. Sending then stops.
 *
 * The Gmail account is shared by the achterwacht and the AIOS (the
 * planner's choice); each dienst has its own flow, with its own address
 * list (docs/aios-rooster.md, "Mail"). Saving and removing are for the
 * beheerder only: a planner who could point a flow mailbox elsewhere would
 * receive the other dienst's personal links (lib/dienstAccess.ts). Every
 * planner sees the status, with only their own dienst's mailbox.
 *
 * lib/appSettings.ts, lib/verzendlijstMail.ts. Changes are audit-logged,
 * without the password.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requireAdminAccess, requirePlannerAccess, type AuthContext } from '@/lib/auth-context';
import { visibleDienst } from '@/lib/dienstAccess';
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { deleteMailSettings, getStoredMailSettings, saveMailSettings } from '@/lib/appSettings';
import { mailConfigStatus, verifyMailLogin } from '@/lib/verzendlijstMail';
import { flushMailQueue } from '@/lib/meldingMail';

const ALLEEN_BEHEERDER =
  'Alleen de beheerder kan de mailinstellingen wijzigen. Ze gelden voor de achterwacht en de AIOS samen.';

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
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    return NextResponse.json({ success: true, data: statusFor(auth!) });
  } catch (error) {
    return internalErrorResponse('mail-settings-get', error);
  }
}

/** The status, with only the mailbox of the dienst this account sees (a beheerder: both). */
function statusFor(auth: AuthContext) {
  const status = mailConfigStatus();
  const dienst = visibleDienst(auth);
  return {
    ...status,
    verzendlijst_aan: dienst === 'AIOS' ? null : status.verzendlijst_aan,
    verzendlijst_aan_aios: dienst === 'ACHTERWACHT' ? null : status.verzendlijst_aan_aios,
  };
}

const GMAIL = /^[^\s@]+@(gmail|googlemail)\.com$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const putSchema = z.object({
  gebruiker: z.string().trim().max(254),
  wachtwoord: z.string().max(200).optional(),
  verzendlijst_aan: z.string().trim().max(254),
  verzendlijst_aan_aios: z.string().trim().max(254).optional(),
});

export async function PUT(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);

    const parsed = putSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'Vul het Gmail-adres en het adres voor de verzendlijst in.');
    const { gebruiker, verzendlijst_aan } = parsed.data;

    if (!GMAIL.test(gebruiker)) {
      return fail(400, 'Dienstrooster verstuurt alleen via Gmail. Vul een adres in dat eindigt op @gmail.com.');
    }
    if (!EMAIL.test(verzendlijst_aan)) {
      return fail(400, 'Het adres voor de verzendlijst is geen geldig e-mailadres.');
    }
    const stored = getStoredMailSettings();
    const verzendlijst_aan_aios =
      parsed.data.verzendlijst_aan_aios === undefined
        ? (stored?.verzendlijstAanAios ?? null)
        : parsed.data.verzendlijst_aan_aios || null;
    if (verzendlijst_aan_aios !== null && !EMAIL.test(verzendlijst_aan_aios)) {
      return fail(400, 'Het adres voor de verzendlijst van de AIOS is geen geldig e-mailadres.');
    }

    // Leaving the password empty keeps the saved one - only for the same
    // account, so a changed address can't silently borrow another's password.
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
    saveMailSettings(
      { gebruiker, wachtwoord, verzendlijstAan: verzendlijst_aan, verzendlijstAanAios: verzendlijst_aan_aios },
      auth!.userId
    );
    audit(
      auth!.userId,
      {
        gebruiker: before.gebruiker,
        verzendlijst_aan: before.verzendlijst_aan,
        verzendlijst_aan_aios: before.verzendlijst_aan_aios,
      },
      { gebruiker, verzendlijst_aan, verzendlijst_aan_aios, wachtwoord_gewijzigd: Boolean(typed) },
      'UPDATE'
    );
    // Swap mails that waited for working settings go out now, not at the
    // next hourly run. Not awaited: the queue may take a while.
    void flushMailQueue();
    return NextResponse.json({ success: true, data: statusFor(auth!) });
  } catch (error) {
    return internalErrorResponse('mail-settings-put', error);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);
    const before = mailConfigStatus();
    if (deleteMailSettings()) {
      audit(
        auth!.userId,
        {
          gebruiker: before.gebruiker,
          verzendlijst_aan: before.verzendlijst_aan,
          verzendlijst_aan_aios: before.verzendlijst_aan_aios,
        },
        null,
        'DELETE'
      );
    }
    return NextResponse.json({ success: true, data: statusFor(auth!) });
  } catch (error) {
    return internalErrorResponse('mail-settings-delete', error);
  }
}

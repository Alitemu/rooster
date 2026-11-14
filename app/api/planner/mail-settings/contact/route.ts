/**
 * PUT /api/planner/mail-settings/contact { contact_planner } - the address
 * the achterwacht's participants mail when something is wrong in a voorlopig
 * roster or a swap can't go through the app. Empty removes it. The
 * beheerder only, like every mail setting; apart from the flow's mailbox,
 * which the flow reads and a person does not (the AIOS has its own, under
 * /api/aios/mail-instellingen). lib/appSettings.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requireAdminAccess, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { getContactPlanner, saveContactPlanner } from '@/lib/appSettings';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PUT(req: NextRequest) {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    if (!requireAdminAccess(auth)) return forbiddenResponse('Alleen de beheerder kan het contactadres van de planner wijzigen.');
    const body = await parseJsonBody<{ contact_planner: unknown }>(req);
    if (typeof body.contact_planner !== 'string') {
      return NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message: 'Vul het contactadres van de planner in.' } }, { status: 400 });
    }
    const adres = body.contact_planner.trim();
    if (adres !== '' && (adres.length > 254 || !EMAIL.test(adres))) {
      return NextResponse.json({ success: false, error: { code: 'INVALID_INPUT', message: 'Het contactadres van de planner is geen geldig e-mailadres.' } }, { status: 400 });
    }
    const oud = getContactPlanner();
    saveContactPlanner(adres, auth!.userId);
    db.prepare(
      `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, 'app_setting', 'contact_planner', ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), auth!.userId, adres === '' ? 'DELETE' : 'UPDATE', JSON.stringify({ contact_planner: oud }), adres === '' ? null : JSON.stringify({ contact_planner: adres }), new Date().toISOString());
    return NextResponse.json({ success: true, data: { contact_planner: getContactPlanner() } });
  } catch (error) {
    return internalErrorResponse('mail-settings-contact', error);
  }
}

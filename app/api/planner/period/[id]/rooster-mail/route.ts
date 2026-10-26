/**
 * POST /api/planner/period/[id]/rooster-mail
 *
 * Mails everyone their own shifts of a published roster once more: the
 * voorlopige mail while the roster is voorlopig, the definitieve one when it
 * is definitief. For when the mail of the publication failed (Gmail was down,
 * the password had to be renewed): publishing itself is not undone by a
 * failed mail, so this is the way to send it afterwards.
 *
 * Everyone gets it again, also those who already had it; the planner is
 * asked first (RosterMailResend in components/PlannerDashboard.tsx). One send
 * at a time per period (lib/inFlight.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { readVoorlopigSnapshot, sendRosterMail } from '@/lib/publication';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { rememberBaseUrl } from '@/lib/periodInvitations';
import { claimVerzending, VERZENDING_BEZIG } from '@/lib/inFlight';
import { writeAuditLog } from '@/lib/auditLog';

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id: periodId } = await props.params;
  let release: (() => void) | null = null;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, periodId);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS has its own (lib/aiosPublicatie.ts).
    const aiosNotYet = aiosNotYetDenial(periodId);
    if (aiosNotYet) return aiosNotYet;
    // Nothing changes in the prullenbak (lib/periodTrash.ts).
    const inTrash = trashedPeriodDenial(periodId);
    if (inTrash) return inTrash;

    const period = db.prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as any;
    if (!period) return fail(404, 'NOT_FOUND', 'Periode niet gevonden');
    if (period.status !== 'GEPUBLICEERD') {
      return fail(409, 'NOT_PUBLISHED', 'Alleen van een gepubliceerd rooster kan de mail opnieuw verstuurd worden.');
    }

    // One send at a time (lib/inFlight.ts): taken before the first await.
    release = claimVerzending(`rooster-mail:${periodId}`);
    if (!release) return fail(409, 'BEZIG', VERZENDING_BEZIG);

    const soort = period.definitief_op ? 'ROOSTER_DEFINITIEF' : 'ROOSTER_VOORLOPIG';
    const baseUrl = resolveBaseUrl(request);
    rememberBaseUrl(periodId, baseUrl);
    const mail = await sendRosterMail(soort, period, baseUrl, soort === 'ROOSTER_DEFINITIEF' ? readVoorlopigSnapshot(period.voorlopig_rooster_json) : []);

    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'schedule_period',
      entiteitId: periodId,
      actie: 'UPDATE',
      nieuw: {
        wijziging: 'roostermail opnieuw verstuurd',
        soort: soort === 'ROOSTER_DEFINITIEF' ? 'definitief' : 'voorlopig',
        verstuurd: mail.verstuurd,
        ...(mail.verstuurd ? { aantal: mail.aantal } : {}),
      },
    });

    return NextResponse.json({ success: true, data: { mail, soort: soort === 'ROOSTER_DEFINITIEF' ? 'definitief' : 'voorlopig' } });
  } catch (error) {
    return internalErrorResponse('rooster-mail', error);
  } finally {
    release?.();
  }
}

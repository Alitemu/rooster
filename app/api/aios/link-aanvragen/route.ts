/**
 * POST /api/aios/link-aanvragen - "Link kwijt?" for the AIOS. No login. The
 * form on the start page sends the typed address here and to the
 * achterwacht's /api/link-aanvragen, which is not changed for the AIOS:
 * each mails its own flow (lib/aiosMail.ts), and the flow decides from its
 * own address list whether and to whom a link goes.
 *
 * A copy of that route (docs/development/diensten.md, "Copied, not
 * changed"): the same answer whether the address is known or not, rate
 * limited per caller and in total. Without the AIOS's mail set up it
 * answers 503, as the achterwacht's does; without an invited AIOS period
 * nothing goes out and the answer is the same. The form takes the
 * achterwacht's answer first (components/LinkAanvraagForm.tsx).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseJsonBody, internalErrorResponse } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, rateLimitedResponseBody, recordAttempt } from '@/lib/rateLimit';
import { buildVerzendlijst, deadlineTekst, verzendlijstPersonen, type VerzendlijstBericht } from '@/lib/aiosVerzendlijst';
import { deadlinePassed } from '@/lib/aiosInvoer';
import { aiosMailIngesteld, verstuurAiosVerzendlijst } from '@/lib/aiosMail';
import { actieveAiosPeriodes, aiosDeelnemers, aiosMailBasisUrl, aiosPersoonlijkeLink } from '@/lib/aiosUitnodigen';
import { db } from '@/db/client';

const MAX_PER_CALLER = 3;
const MAX_TOTAL = 10;

const bodySchema = z.object({ email: z.string().trim().toLowerCase().max(254).email() });

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = bodySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Vul een geldig e-mailadres in.');

    const callerKey = `aios-link-aanvraag:${getClientIp(req)}`;
    const totalKey = 'aios-link-aanvraag:alle';
    for (const [key, max] of [
      [callerKey, MAX_PER_CALLER],
      [totalKey, MAX_TOTAL],
    ] as const) {
      const limit = checkRateLimit(key, max);
      if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
    }
    if (!aiosMailIngesteld()) {
      return fail(503, 'NOT_CONFIGURED', 'Een link aanvragen kan nu niet. Neem contact op met de roosteraar.');
    }
    recordAttempt(callerKey);
    recordAttempt(totalKey);

    const now = new Date();
    const namen: string[] = [];
    const kandidaten: VerzendlijstBericht[] = db.transaction(() =>
      actieveAiosPeriodes().flatMap((period) => {
        const baseUrl = aiosMailBasisUrl(period.id);
        if (!baseUrl) return [];
        namen.push(period.naam);
        const uitleg =
          period.status === 'OPEN' && !deadlinePassed(period.deadline, now)
            ? `Via deze link geef je je voorkeuren voor ${period.naam} door. Dat kan tot ${deadlineTekst(period.deadline)}.`
            : `De deadline voor ${period.naam} is verstreken. Via deze link kun je je voorkeuren nog bekijken.`;
        return aiosDeelnemers(period).map((d) => ({
          soort: 'LINK_AANVRAAG' as const,
          codenaam: d.codenaam,
          personen: verzendlijstPersonen(d.codenaam),
          onderwerp: `Je persoonlijke link voor het dienstrooster ${period.naam}`,
          tekst:
            `Beste ${d.codenaam},\n\nJe hebt je persoonlijke link voor het dienstrooster aangevraagd.\n\n` +
            `${uitleg}\n\n${aiosPersoonlijkeLink(d.id, period.id, baseUrl)}\n\n` +
            'Heb je dit niet zelf aangevraagd? Dan kun je deze e-mail negeren.\n\n' +
            'Heb je vragen? Neem dan contact op met de roosteraar.',
        }));
      })
    )();
    if (kandidaten.length > 0) {
      const result = await verstuurAiosVerzendlijst(
        buildVerzendlijst(
          { soort: 'LINK_AANVRAAG', automatisch: true, periode: namen.join(' en '), aanvraag: { email: parsed.data.email, kandidaten } },
          [],
          now
        )
      );
      if (!result.ok) return fail(502, 'MAIL_FAILED', 'Het versturen is niet gelukt. Probeer het later opnieuw.');
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return internalErrorResponse('aios-link-aanvragen', error);
  }
}

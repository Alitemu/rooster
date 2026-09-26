/**
 * POST /api/link-aanvragen - "Link kwijt?" on the start page. No login:
 * anyone can call it, so it reveals nothing and sends nothing to the
 * address typed in. It mails the flow one LINK_AANVRAAG verzendlijst
 * (lib/linkAanvraag.ts); the flow decides, from its own address list,
 * whether and to whom a link goes.
 *
 * The answer is the same whether the address is known or not - the app
 * can't know, and saying "unknown address" would let anyone test which
 * addresses belong to the ward. Only a malformed address, too many
 * requests or mail not being set up get their own answer.
 *
 * Rate-limited per address of the caller and in total: every request
 * issues a fresh link for every participant (see lib/linkAanvraag.ts) and
 * costs one mail from the planner's Gmail account, whose daily limit is
 * shared with invitations and reminders. A real participant asks once.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseJsonBody, internalErrorResponse } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, rateLimitedResponseBody, recordAttempt } from '@/lib/rateLimit';
import { buildVerzendlijst } from '@/lib/verzendlijst';
import { sendVerzendlijst, verzendlijstMailConfigured } from '@/lib/verzendlijstMail';
import { linkAanvraagKandidaten } from '@/lib/linkAanvraag';

/** Per caller and in total, per 15 minutes (lib/rateLimit.ts). */
const MAX_PER_CALLER = 3;
const MAX_TOTAL = 10;

const bodySchema = z.object({ email: z.string().trim().toLowerCase().max(254).email() });

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = bodySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Vul een geldig e-mailadres in.');

    const callerKey = `link-aanvraag:${getClientIp(req)}`;
    const totalKey = 'link-aanvraag:alle';
    for (const [key, max] of [
      [callerKey, MAX_PER_CALLER],
      [totalKey, MAX_TOTAL],
    ] as const) {
      const limit = checkRateLimit(key, max);
      if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });
    }

    if (!verzendlijstMailConfigured()) {
      return fail(503, 'NOT_CONFIGURED', 'Een link aanvragen kan nu niet. Neem contact op met de roosteraar.');
    }

    recordAttempt(callerKey);
    recordAttempt(totalKey);

    const now = new Date();
    const { periode, kandidaten } = linkAanvraagKandidaten(now);
    // Nobody to send a link to (no active period, or no address for the
    // links yet): nothing goes out, and the answer stays the same.
    if (periode && kandidaten.length > 0) {
      const result = await sendVerzendlijst(
        buildVerzendlijst(
          {
            soort: 'LINK_AANVRAAG',
            automatisch: true,
            periode,
            aanvraag: { email: parsed.data.email, kandidaten },
          },
          [],
          now
        )
      );
      if (!result.ok) {
        return fail(502, 'MAIL_FAILED', 'Het versturen is niet gelukt. Probeer het later opnieuw.');
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return internalErrorResponse('link-aanvragen', error);
  }
}

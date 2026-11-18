/**
 * POST /api/auth/wachtwoord-herstel { token, wachtwoord } - sets a new
 * password for the beheerder, with the link mailed to the Gmail account
 * (lib/wachtwoordHerstel.ts). No login: the link is the proof. Every session
 * of the account ends; the beheerder logs in again with the new password.
 *
 * Guessing a token is hopeless (it is signed), but a wrong one still counts
 * against the caller, like a wrong password does.
 */

import { NextRequest, NextResponse } from 'next/server';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkRateLimit, getClientIp, rateLimitedResponseBody, recordAttempt } from '@/lib/rateLimit';
import { stelWachtwoordIn } from '@/lib/wachtwoordHerstel';

const MAX_MISLUKT = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const key = `wachtwoord-herstel:${getClientIp(req)}`;
    const limit = checkRateLimit(key, MAX_MISLUKT);
    if (!limit.allowed) return NextResponse.json(rateLimitedResponseBody(limit.retryAfterSeconds), { status: 429 });

    const body = await parseJsonBody<{ token?: unknown; wachtwoord?: unknown }>(req);
    const uitkomst = await stelWachtwoordIn(body.token, body.wachtwoord);
    if (!uitkomst.ok) {
      if (uitkomst.code === 'INVALID_TOKEN') recordAttempt(key);
      return NextResponse.json({ success: false, error: { code: uitkomst.code, message: uitkomst.message } }, { status: 400 });
    }
    return NextResponse.json({ success: true, data: { codenaam: uitkomst.codenaam } });
  } catch (error) {
    return internalErrorResponse('wachtwoord-herstel', error);
  }
}

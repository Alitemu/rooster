/**
 * POST /api/auth/totp/confirm - Confirm TOTP enrollment with a live code
 *
 * Verifies the code against the secret embedded in the signed setup token
 * from /api/auth/totp/setup, then persists it as the account's TOTP secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyTOTPCode, isValidTOTPFormat } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { verifyPayload } from '@/lib/session';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { TotpSetupPayload } from '../setup/route';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!auth || (auth.role !== 'ADMIN' && auth.role !== 'PLANNER')) {
      return unauthorizedResponse();
    }

    const body = await parseJsonBody<{ setup_token: string; code: string }>(request);
    const { setup_token: setupToken, code } = body;

    if (!setupToken || !code || !isValidTOTPFormat(code)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: 'Setup-token en 6-cijferige code zijn verplicht' } },
        { status: 400 }
      );
    }

    const setupPayload = verifyPayload<TotpSetupPayload>(setupToken);
    if (!setupPayload || setupPayload.kind !== 'totp-setup' || setupPayload.personId !== auth.userId) {
      return NextResponse.json(
        { success: false, error: { code: 'SETUP_EXPIRED', message: 'Setup-token is ongeldig of verlopen. Begin opnieuw.' } },
        { status: 400 }
      );
    }

    if (!verifyTOTPCode(setupPayload.secret, code)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_CODE', message: 'Onjuiste code' } },
        { status: 400 }
      );
    }

    db.prepare(`UPDATE dienstrooster_person SET totp_secret = ? WHERE id = ?`).run(
      setupPayload.secret,
      auth.userId
    );

    return NextResponse.json({ success: true, data: { totp_enrolled: true } });
  } catch (error) {
    return internalErrorResponse('totp-confirm', error);
  }
}

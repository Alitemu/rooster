/**
 * POST /api/auth/totp/setup - Begin TOTP enrollment for the logged-in staff account
 *
 * Requires an existing staff session (password login). Generates a new
 * secret and returns a QR code plus a short-lived signed setup token; the
 * secret is only persisted once confirmed via /api/auth/totp/confirm, so a
 * staff member who never scans the QR code doesn't get locked out.
 *
 * `qr_code` (the `otpauth://` URI speakeasy builds) is rendered here into
 * `qr_code_image`, a PNG data URL - an authenticator app scans an image, not
 * a URI. The raw URI still ships too, as the fallback for "can't scan, let
 * me type it in" (most authenticator apps accept the URI or the secret
 * pasted directly); `secret` is that same fallback in its bare base32 form.
 */

import { NextRequest, NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { db } from '@/db/client';
import { generateTOTPSecret } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { signPayload } from '@/lib/session';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { checkRateLimit, recordAttempt, rateLimitedResponseBody } from '@/lib/rateLimit';

export interface TotpSetupPayload {
  kind: 'totp-setup';
  personId: string;
  secret: string;
}

const SETUP_TOKEN_MAX_AGE_SECONDS = 60 * 10;
const MAX_ATTEMPTS = 10;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!auth || (auth.role !== 'ADMIN' && auth.role !== 'PLANNER')) {
      return unauthorizedResponse();
    }

    // Unlike the auth routes, every call counts here, not just failures:
    // this hands out a fresh secret + QR each time, so the thing worth
    // limiting is the operation itself, not a wrong guess.
    const rateLimitKey = `totp-setup:${auth.userId}`;
    const rateLimit = checkRateLimit(rateLimitKey, MAX_ATTEMPTS);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }
    recordAttempt(rateLimitKey);

    const person = db
      .prepare(`SELECT codenaam FROM dienstrooster_person WHERE id = ?`)
      .get(auth.userId) as { codenaam: string } | undefined;

    if (!person) {
      return unauthorizedResponse();
    }

    const { secret, qrCode } = generateTOTPSecret(person.codenaam);

    const setupToken = signPayload<TotpSetupPayload>(
      { kind: 'totp-setup', personId: auth.userId, secret },
      SETUP_TOKEN_MAX_AGE_SECONDS
    );

    // Rendering can fail (it's the one external-library call in this
    // route), but that must never block enrollment outright - the raw URI
    // and the bare secret are both still usable without it.
    let qrCodeImage: string | null = null;
    try {
      qrCodeImage = await QRCode.toDataURL(qrCode);
    } catch (error) {
      console.error('[totp-setup] kon QR-afbeelding niet renderen', error);
    }

    return NextResponse.json({
      success: true,
      data: { setup_token: setupToken, qr_code: qrCode, qr_code_image: qrCodeImage, secret },
    });
  } catch (error) {
    return internalErrorResponse('totp-setup', error);
  }
}

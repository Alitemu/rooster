/**
 * POST /api/auth/totp/confirm - Confirm TOTP enrollment with a live code
 *
 * Verifies the code against the secret embedded in the signed setup token
 * from /api/auth/totp/setup, then persists it as the account's TOTP secret.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { verifyTOTPCode, isValidTOTPFormat } from '@/lib/auth';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { verifyPayload } from '@/lib/session';
import { encryptTotpSecret } from '@/lib/totpSecret';
import { writeAuditLog } from '@/lib/auditLog';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { takeAttempt, clearRateLimit, rateLimitedResponseBody } from '@/lib/rateLimit';
import type { TotpSetupPayload } from '../setup/route';

// Keyed by the authenticated actor (this route requires a session, unlike
// staff-login/verify-link) rather than IP - a valid 6-digit TOTP code is
// cheap and fast to guess (no bcrypt-style cost like a password), so
// without this an already-logged-in attacker could brute-force it well
// within the setup token's 10-minute lifetime. Counts rejected codes only,
// so repeatedly re-enrolling (a legitimate action) never uses it up.
const MAX_ATTEMPTS = 10;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!auth || !requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const rateLimitKey = `totp-confirm:${auth.userId}`;

    const body = await parseJsonBody<{ setup_token: string; code: string }>(request);
    const { setup_token: setupToken, code } = body;

    if (typeof setupToken !== 'string' || typeof code !== 'string' || !setupToken || !code || !isValidTOTPFormat(code)) {
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

    // A second authenticator replaces the first without the password or a code of the first: someone at an
    // unattended session could lock the owner out. Switching it off needs the password; do that first.
    const heeft = db.prepare('SELECT totp_secret FROM dienstrooster_person WHERE id = ?').get(auth.userId) as { totp_secret: string | null } | undefined;
    if (heeft?.totp_secret) {
      return NextResponse.json(
        { success: false, error: { code: 'TOTP_ALREADY_ENABLED', message: 'Tweestapsverificatie staat al aan. Zet die eerst uit met je wachtwoord.' } },
        { status: 409 }
      );
    }

    // Counted now, before the code is compared (lib/rateLimit.ts takeAttempt).
    const rateLimit = takeAttempt([[rateLimitKey, MAX_ATTEMPTS]]);
    if (!rateLimit.allowed) {
      return NextResponse.json(rateLimitedResponseBody(rateLimit.retryAfterSeconds), { status: 429 });
    }
    if (!verifyTOTPCode(setupPayload.secret, code)) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_CODE', message: 'Onjuiste code' } },
        { status: 400 }
      );
    }

    clearRateLimit(rateLimitKey);

    db.transaction(() => {
      db.prepare(`UPDATE dienstrooster_person SET totp_secret = ? WHERE id = ?`).run(
        encryptTotpSecret(setupPayload.secret),
        auth.userId
      );
      // Switching it off was logged, switching it on was not (audit 9).
      // Never the secret: only that it happened.
      writeAuditLog({
        actorId: auth.userId,
        entiteit: 'person',
        entiteitId: auth.userId,
        actie: 'UPDATE',
        nieuw: { wijziging: 'totp_ingeschakeld' },
      });
    })();

    return NextResponse.json({ success: true, data: { totp_enrolled: true } });
  } catch (error) {
    return internalErrorResponse('totp-confirm', error);
  }
}

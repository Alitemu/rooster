/**
 * First-Run Setup Status
 *
 * GET /api/auth/first-run-status - which staff accounts (ADMIN/PLANNER)
 * still have no password set.
 *
 * Deliberately unauthenticated: nobody CAN be authenticated yet on a fresh
 * deployment, since neither seeded account has a password. Exposing which
 * of two fixed, publicly-known codenamen ("ADMIN", "PLANNER") still need
 * setup isn't a secret - the login form already shows those same names.
 */

import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse } from '@/types';

// Reads no cookies/headers/params, so Next.js's static analysis would
// otherwise prerender this once at build time and serve that frozen
// answer forever - verified via `npm run build` marking it ○ (Static)
// instead of ƒ (Dynamic) without this, and the login page's setup gate
// never seeing a real password get set as a result.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const rows = db
      .prepare(
        `SELECT codenaam FROM dienstrooster_person
         WHERE rol IN ('ADMIN', 'PLANNER') AND wachtwoord_hash IS NULL
         ORDER BY codenaam ASC`
      )
      .all() as { codenaam: string }[];

    const response: ApiSuccessResponse<{ pending: string[] }> = {
      success: true,
      data: { pending: rows.map((r) => r.codenaam) },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('first-run-status', error);
  }
}

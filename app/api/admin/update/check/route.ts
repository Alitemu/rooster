/**
 * POST /api/admin/update/check - ask the updater to look up the released
 * version now rather than at its next 6-hourly check (lib/appUpdate.ts).
 * ADMIN only; 409 when no updater runs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { requestCheck } from '@/lib/appUpdate';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    if (!requireAdminAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
    if (!requestCheck()) {
      return NextResponse.json(
        { success: false, error: { code: 'UPDATER_NIET_ACTIEF', message: 'Bijwerken vanuit de app staat op deze server niet aan.' } },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true }, { status: 202 });
  } catch (error) {
    return internalErrorResponse('admin-update-check', error);
  }
}

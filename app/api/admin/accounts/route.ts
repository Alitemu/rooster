/**
 * GET  /api/admin/accounts - the staff accounts (ADMIN only).
 * POST /api/admin/accounts - { codenaam, rol: 'PLANNER' | 'ADMIN', wachtwoord, dienst_type? }
 *   adds one with a temporary password (lib/staffAccounts.ts). dienst_type
 *   ACHTERWACHT (the default) or AIOS, which is refused until it is in production.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { createStaffAccount, listStaffAccounts } from '@/lib/staffAccounts';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    if (!requireAdminAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
    return NextResponse.json({ success: true, data: listStaffAccounts() });
  } catch (error) {
    return internalErrorResponse('admin-accounts-list', error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const body = await parseJsonBody<{ codenaam?: unknown; rol?: unknown; wachtwoord?: unknown; dienst_type?: unknown }>(req);
    const result = await createStaffAccount(auth!.userId, {
      codenaam: body?.codenaam,
      rol: body?.rol,
      wachtwoord: body?.wachtwoord,
      dienst_type: body?.dienst_type,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: { id: result.id } }, { status: 201 });
  } catch (error) {
    return internalErrorResponse('admin-accounts-create', error);
  }
}

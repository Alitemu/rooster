/**
 * GET  /api/admin/accounts - the staff accounts (ADMIN only).
 * POST /api/admin/accounts - { codenaam, rol: 'PLANNER' | 'ADMIN', wachtwoord }
 *   adds one with a temporary password (lib/staffAccounts.ts).
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
    const body = await parseJsonBody<{ codenaam?: unknown; rol?: unknown; wachtwoord?: unknown }>(req);
    const result = await createStaffAccount(auth!.userId, {
      codenaam: body?.codenaam,
      rol: body?.rol,
      wachtwoord: body?.wachtwoord,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: { id: result.id } }, { status: 201 });
  } catch (error) {
    return internalErrorResponse('admin-accounts-create', error);
  }
}

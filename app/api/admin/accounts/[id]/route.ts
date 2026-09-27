/**
 * PATCH /api/admin/accounts/[id] - { actief?, rol? }: switch a staff account
 * off or on, or make it planner or beheerder (ADMIN only, never one's own,
 * never the last active admin; lib/staffAccounts.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { updateStaffAccount } from '@/lib/staffAccounts';

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const body = await parseJsonBody<{ actief?: unknown; rol?: unknown }>(req);
    const result = updateStaffAccount(auth!.userId, id, { actief: body?.actief, rol: body?.rol });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: { id } });
  } catch (error) {
    return internalErrorResponse('admin-accounts-update', error);
  }
}

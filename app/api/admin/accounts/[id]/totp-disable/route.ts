/**
 * POST /api/admin/accounts/[id]/totp-disable - turn off two-step
 * verification for a staff account whose phone is gone (ADMIN only, never
 * one's own; lib/staffAccounts.ts). The in-app counterpart of
 * scripts/reset-totp.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, unauthorizedResponse } from '@/lib/api-errors';
import { disableStaffTotp } from '@/lib/staffAccounts';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const result = disableStaffTotp(auth!.userId, id);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: { id } });
  } catch (error) {
    return internalErrorResponse('admin-accounts-totp-disable', error);
  }
}

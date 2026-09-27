/**
 * POST /api/admin/accounts/[id]/reset-password - { wachtwoord }: give a
 * staff account a temporary password (ADMIN only, never one's own). Its
 * sessions end and the next login must choose a new password
 * (lib/staffAccounts.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { resetStaffPassword } from '@/lib/staffAccounts';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const body = await parseJsonBody<{ wachtwoord?: unknown }>(req);
    const result = await resetStaffPassword(auth!.userId, id, body?.wachtwoord);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: { id } });
  } catch (error) {
    return internalErrorResponse('admin-accounts-reset-password', error);
  }
}

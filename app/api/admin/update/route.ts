/**
 * GET  /api/admin/update - this version, the released one and how the
 *   updater is doing (lib/appUpdate.ts updateOverzicht). ADMIN only.
 * POST /api/admin/update - { versie }: back up the database and ask the
 *   updater to go to `versie`, which must be the released version shown.
 *   202 with `aangevraagd_op` (server time, which the updater's outcome is
 *   compared with); the app restarts shortly after, so the page polls GET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { requestUpdate, updateOverzicht } from '@/lib/appUpdate';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    if (!requireAdminAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
    return NextResponse.json({ success: true, data: updateOverzicht() });
  } catch (error) {
    return internalErrorResponse('admin-update-status', error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const body = await parseJsonBody<{ versie?: unknown }>(req);
    const result = requestUpdate(auth!.userId, body?.versie);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json(
      { success: true, data: { ...updateOverzicht(), aangevraagd_op: result.aangevraagd_op } },
      { status: 202 }
    );
  } catch (error) {
    return internalErrorResponse('admin-update-request', error);
  }
}

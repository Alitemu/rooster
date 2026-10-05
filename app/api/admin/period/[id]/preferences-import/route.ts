/**
 * POST /api/admin/period/[id]/preferences-import - read the preferences
 * overview back in (lib/preferencesImport.ts). A test tool, ADMIN only.
 * Body: { csv: string, toepassen?: boolean }. Without `toepassen` nothing
 * changes: the response lists what would.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requireAdminAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { importPreferences } from '@/lib/preferencesImport';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requireAdminAccess(auth)) return unauthorizedResponse();
    const body = (await parseJsonBody(req)) as { csv?: unknown; toepassen?: unknown };
    const result = importPreferences(auth!.userId, id, body?.csv, body?.toepassen === true);
    if (!result.ok) {
      return NextResponse.json({ success: false, error: { code: result.code, message: result.message } }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: { ...result.plan, toegepast: result.toegepast } });
  } catch (error) {
    return internalErrorResponse('admin-preferences-import', error);
  }
}

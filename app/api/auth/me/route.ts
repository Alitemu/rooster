/**
 * GET /api/auth/me - Return the current authenticated identity, if any
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest } from '@/lib/auth-context';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = getAuthContextFromRequest(request);

  if (!auth) {
    return NextResponse.json({ success: true, data: { authenticated: false } });
  }

  return NextResponse.json({
    success: true,
    data: { authenticated: true, person_id: auth.userId, role: auth.role },
  });
}

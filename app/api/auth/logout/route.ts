/**
 * POST /api/auth/logout - Clear the session cookie (person or staff)
 */

import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/session';

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ success: true, data: { loggedOut: true } });
  clearSessionCookie(response);
  return response;
}

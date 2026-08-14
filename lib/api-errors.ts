/**
 * Client-safe API error responses.
 *
 * Never return raw error messages, stack traces, or DB details to the
 * client - log the full error server-side and return a generic message.
 */

import { NextResponse } from 'next/server';

export function internalErrorResponse(context: string, error: unknown, status = 500): NextResponse {
  console.error(`[${context}]`, error);
  return NextResponse.json(
    {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    },
    { status }
  );
}

export function unauthorizedResponse(message = 'Authentication required'): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: 'UNAUTHORIZED', message } },
    { status: 401 }
  );
}

export function forbiddenResponse(message = 'Not allowed'): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: 'FORBIDDEN', message } },
    { status: 403 }
  );
}

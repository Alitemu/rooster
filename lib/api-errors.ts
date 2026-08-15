/**
 * Client-safe API error responses.
 *
 * Never return raw error messages, stack traces, or DB details to the
 * client - log the full error server-side and return a generic message.
 */

import { NextRequest, NextResponse } from 'next/server';

/**
 * Parse a request's JSON body without letting a missing/malformed body
 * (e.g. no Content-Length, truncated request, non-JSON payload) surface
 * as an uncaught SyntaxError - that would otherwise bubble up to the
 * route's outer catch and get reported as a 500 INTERNAL_ERROR, even
 * though a bad request body is a client error, not a server fault.
 * Every route that uses this already validates its required fields
 * against the parsed object, so an empty object here correctly falls
 * through to that existing 400 response instead.
 */
export async function parseJsonBody<T = Record<string, unknown>>(req: NextRequest): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {} as Partial<T>;
  }
}

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

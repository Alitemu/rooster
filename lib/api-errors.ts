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
 *
 * Anything that is not a plain object becomes `{}` for the same reason.
 * Catching the throw alone was not enough: the literal body `null` is
 * valid JSON, so req.json() resolved with it instead of throwing, and the
 * very first `const { x } = body` in the route turned it into a
 * TypeError - a 500 on 13 routes for what is plainly a bad request. An
 * array or a bare number/string slipped through the same way and only
 * happened not to crash, because destructuring those yields undefined.
 * No route here takes a top-level array, so collapsing all four cases to
 * the same empty object keeps every caller's existing field validation as
 * the single place that decides what a missing field means.
 */
export async function parseJsonBody<T = Record<string, unknown>>(req: NextRequest): Promise<Partial<T>> {
  try {
    const parsed = await req.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {} as Partial<T>;
    }
    return parsed as Partial<T>;
  } catch {
    return {} as Partial<T>;
  }
}

/**
 * True when a write failed because it would duplicate a UNIQUE index.
 *
 * A uniqueness collision is a user-level conflict ("you already have
 * that"), not a server fault, so routes that can hit one should answer 409
 * rather than letting it fall through to a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    const code = (current as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function internalErrorResponse(context: string, error: unknown, status = 500): NextResponse {
  console.error(`[${context}]`, error);
  return NextResponse.json(
    {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Er is iets misgegaan. Probeer het opnieuw.' },
    },
    { status }
  );
}

export function unauthorizedResponse(message = 'Authenticatie vereist'): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: 'UNAUTHORIZED', message } },
    { status: 401 }
  );
}

export function forbiddenResponse(message = 'Niet toegestaan'): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: 'FORBIDDEN', message } },
    { status: 403 }
  );
}

/**
 * Type checks for fields of a JSON request body, for the routes that read
 * ids, reasons and imported rows straight from it.
 *
 * parseJsonBody guarantees a plain object, not what is inside it: a field
 * can still be a number, an array or an object where text belongs. Reaching
 * a SQL parameter, a .trim() or a for-of loop like that used to end in a
 * 500 (audit 6 found eleven routes). These turn it into a 400 the route
 * words itself, or into "missing" where a field is optional.
 */

import { NextResponse } from 'next/server';

/** Text, or undefined for a missing field; anything else is not acceptable. */
export function optionalText(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  return typeof value === 'string' ? { ok: true, value } : { ok: false };
}

/** A field read from an imported row: its text trimmed, or '' when it isn't text. */
export function rowText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The rows of an import: [] when the field is missing, the rows when it is
 * a list of objects, null when it is anything else.
 */
export function objectRows(value: unknown): Array<Record<string, unknown>> | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
    ? (value as Array<Record<string, unknown>>)
    : null;
}

export function badRequest(code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status: 400 });
}

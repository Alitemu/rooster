/**
 * A short free text a participant types (a swap toelichting, a rejection
 * reason). It is stored and mailed to a colleague, so it must be a string
 * and of sensible length: anything else used to reach the database as-is,
 * where a non-string crashed the insert (a 500) and a very long one went
 * straight into a mail.
 */

export const MAX_FREE_TEXT = 1000;

export type FreeTextResult = { ok: true; value: string | null } | { ok: false; message: string };

/** Absent, null or only whitespace = no text. `label` names the field in the message. */
export function optionalFreeText(value: unknown, label: string): FreeTextResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, message: `${label} moet tekst zijn.` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_FREE_TEXT) {
    return { ok: false, message: `${label} mag hooguit ${MAX_FREE_TEXT} tekens lang zijn.` };
  }
  return { ok: true, value: trimmed };
}

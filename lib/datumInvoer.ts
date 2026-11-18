/**
 * What a planner or participant types into a date field, and back.
 *
 * The browser's own date input shows the date in the language of the
 * browser: an English Chrome asks for mm/dd/yyyy, whatever the page says
 * (1.2.0). So the fields are plain text in dd-mm-jjjj, and only these
 * helpers turn that into the YYYY-MM-DD the rest of the app stores.
 *
 * Pure, no db: used by the client components (components/DatumVeld.tsx).
 */
import { isValidIsoDate, parseDutchOrIsoDate } from './isoDate';

/** YYYY-MM-DD as dd-mm-jjjj; anything else unchanged (an empty field stays empty). */
export function isoNaarInvoer(iso: string): string {
  if (!isValidIsoDate(iso)) return iso;
  const [j, m, d] = iso.split('-');
  return `${d}-${m}-${j}`;
}

/**
 * What was typed as YYYY-MM-DD, or null when it is no real date.
 * Takes d-m-jjjj (also with / or .), eight digits ddmmjjjj, and YYYY-MM-DD
 * (pasted from elsewhere).
 */
export function invoerNaarIso(tekst: string): string | null {
  const t = tekst.trim();
  if (t === '') return null;
  const cijfers = /^(\d{2})(\d{2})(\d{4})$/.exec(t);
  if (cijfers) return parseDutchOrIsoDate(`${cijfers[1]}-${cijfers[2]}-${cijfers[3]}`);
  return parseDutchOrIsoDate(t);
}

/** A time as typed (17:00, 9:05, 17.00, 1700) as HH:MM on a 24-hour clock, or null. */
export function tijdNaarIso(tekst: string): string | null {
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))$/.exec(tekst.trim());
  if (!m) return null;
  const uur = Number(m[1]);
  const minuut = Number(m[2]);
  if (uur > 23 || minuut > 59) return null;
  return `${String(uur).padStart(2, '0')}:${m[2]}`;
}

/** YYYY-MM-DDTHH:MM split into what the two fields show; empty fields for anything else. */
export function datumTijdNaarInvoer(waarde: string): { datum: string; tijd: string } {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(waarde);
  if (!m || !isValidIsoDate(m[1])) return { datum: '', tijd: '' };
  return { datum: isoNaarInvoer(m[1]), tijd: m[2] };
}

/** The two fields as YYYY-MM-DDTHH:MM, or '' while either is empty or wrong. */
export function invoerNaarDatumTijd(datum: string, tijd: string): string {
  const d = invoerNaarIso(datum);
  const t = tijdNaarIso(tijd);
  return d && t ? `${d}T${t}` : '';
}

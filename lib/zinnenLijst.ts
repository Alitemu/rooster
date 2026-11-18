/**
 * Several messages as one text, each a sentence (1.1.5): joined with "; " a
 * message that ended in a full stop gave ".;" ("...met de betrokkenen.; 28x
 * valt..."), the audit of 1.1.2.
 */
export function zinnenLijst(meldingen: string[]): string {
  return meldingen
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .map((m) => (/[.!?]$/.test(m) ? m : `${m}.`))
    .join(' ');
}

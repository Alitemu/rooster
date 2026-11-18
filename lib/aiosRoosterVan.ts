/**
 * "van de AIOS voor 2027 Q2", or "voor AIOS 2027 Q2" when the name says AIOS already: the mails read "Het rooster
 * van de AIOS voor AIOS 2027 Q2" with the name a quarter gets by default (2.1.0, audit per role, R2-10).
 */
export function roosterVan(naam: string): string {
  return /\bAIOS\b/i.test(naam) ? `voor ${naam}` : `van de AIOS voor ${naam}`;
}

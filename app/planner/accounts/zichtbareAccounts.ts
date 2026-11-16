/**
 * Which accounts Accounts beheren shows (1.11.0, the beheerder's wish). An account that is switched off
 * can't be deleted when the history of a roster names it (lib/staffAccounts.ts heeftSporen), so the list
 * only grew: every former planner stayed in it for good. Switched-off accounts are now left out until
 * the beheerder asks for them with "Toon uitgeschakelde accounts". Nothing is hidden from the server's
 * answer: the page counts them and says how many there are.
 */

export function zichtbareAccounts<T extends { actief: boolean }>(accounts: T[], toonUitgeschakeld: boolean): T[] {
  return toonUitgeschakeld ? accounts : accounts.filter((a) => a.actief);
}

export function aantalUitgeschakeld(accounts: Array<{ actief: boolean }>): number {
  return accounts.filter((a) => !a.actief).length;
}

/** What the page says after switching an account off or on, so nobody wonders where the row went. */
export function naSchakelen(codenaam: string, wasActief: boolean, toonUitgeschakeld: boolean): string {
  if (!wasActief) return `${codenaam} kan weer inloggen.`;
  const waar = toonUitgeschakeld ? '' : ' Het account staat nu bij de uitgeschakelde accounts. Vink Toon uitgeschakelde accounts aan om het te zien.';
  return `${codenaam} is uitgeschakeld en kan niet meer inloggen.${waar}`;
}

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { aantalUitgeschakeld, naSchakelen, zichtbareAccounts } from './zichtbareAccounts';

/**
 * The rules (1.11.0): Accounts beheren leaves switched-off accounts out until the beheerder asks for
 * them, never an account in use; it says how many are left out, and after switching one off it says
 * where the row went.
 */

const lijst = [
  { codenaam: 'admin', actief: true },
  { codenaam: 'oud-1', actief: false },
  { codenaam: 'planner', actief: true },
  { codenaam: 'oud-2', actief: false },
];

describe('the accounts Accounts beheren shows', () => {
  it('leaves switched-off accounts out by default and keeps every account in use, in order', () => {
    expect(zichtbareAccounts(lijst, false).map((a) => a.codenaam)).toEqual(['admin', 'planner']);
  });

  it('shows them all once asked, in the order the server gave', () => {
    expect(zichtbareAccounts(lijst, true)).toEqual(lijst);
  });

  it('counts the switched-off ones, so the page can say how many it leaves out', () => {
    expect(aantalUitgeschakeld(lijst)).toBe(2);
    expect(aantalUitgeschakeld(lijst.filter((a) => a.actief))).toBe(0);
  });

  it('says where the row went after switching off, only when it went', () => {
    expect(naSchakelen('oud-1', true, false)).toBe(
      'oud-1 is uitgeschakeld en kan niet meer inloggen. Het account staat nu bij de uitgeschakelde accounts. Vink Toon uitgeschakelde accounts aan om het te zien.'
    );
    expect(naSchakelen('oud-1', true, true)).toBe('oud-1 is uitgeschakeld en kan niet meer inloggen.');
    expect(naSchakelen('oud-1', false, false)).toBe('oud-1 kan weer inloggen.');
    expect(naSchakelen('oud-1', false, true)).toBe('oud-1 kan weer inloggen.');
  });

  it('is what the page draws: the list starts without them, and the switch is only there when one is left out', () => {
    const bron = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
    expect(bron).toContain('const [toonUitgeschakeld, setToonUitgeschakeld] = useState(false);');
    expect(bron).toContain('{zichtbareAccounts(accounts, toonUitgeschakeld).map((a) => {');
    expect(bron).not.toContain('{accounts.map((a) => {');
    expect(bron).toContain('{uitgeschakeld > 0 && (');
    expect(bron).toContain('Toon uitgeschakelde accounts ({uitgeschakeld})');
  });
});

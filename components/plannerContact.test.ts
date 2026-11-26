import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Audit per role R-05 (1.7.0): "Vragen over je rooster? Neem contact op met de planner" named no address;
 * the contactadres was only under Ruilen. Both roster views now name it when the beheerder set one: the
 * achterwacht's for every roster, not only a voorlopig one, and the AIOS's in its voorlopig notice and a
 * line of its own. The mails are in lib/publication.test.ts and app/api/aios/aiosPublicatie.test.ts.
 */
const bron = (f: string) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');

describe('the achterwacht', () => {
  const view = bron('PersonalRosterView.tsx');
  it('reads the contactadres for every roster', () => {
    const effect = view.slice(view.indexOf('const [contactPlanner, setContactPlanner]'), view.indexOf('const plannerAdres'));
    expect(effect).toContain('/swap-contacts`');
    expect(effect).not.toContain('if (definitief) return;');
  });
  it('names it where a question goes', () => {
    expect(view).toContain('Vragen over je rooster? Neem contact op met de planner{plannerAdres}.');
    expect(view).toContain('{plannerAdres} als dit niet klopt.');
    expect(view).toMatch(/href=\{`mailto:\$\{contactPlanner\}`\}/);
  });
});

describe('the AIOS', () => {
  const view = bron('AiosMijnRooster.tsx');
  it('names it in the voorlopig notice and where a question goes', () => {
    expect(view).toContain('data-testid="aios-vragen-rooster"');
    expect((view.match(/rooster\.contact_planner \?/g) ?? []).length).toBe(2);
    expect(view).toMatch(/href=\{`mailto:\$\{rooster\.contact_planner\}`\}/);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { draaiTaken } from './taakUitvoerder';

/**
 * The rule: the hourly tasks of the two diensten hold each other up in
 * nothing. A task that throws, in whichever place, does not keep the others
 * from running (instrumentation-node.ts; the AIOS's swap reminders and mail
 * queue used to wait behind the achterwacht's swap reminders in one try).
 */
describe('draaiTaken', () => {
  it('runs every task, in order, also after one that throws', async () => {
    const volgorde: string[] = [];
    const taken = ['a', 'b', 'c', 'd'].map((naam) => ({
      naam,
      doe: async () => {
        volgorde.push(naam);
        if (naam === 'a' || naam === 'c') throw new Error(`${naam} stuk`);
      },
    }));
    const gelogd: string[] = [];
    const mislukt = await draaiTaken(taken, (naam) => gelogd.push(naam));
    expect(volgorde).toEqual(['a', 'b', 'c', 'd']);
    expect(mislukt).toEqual(['a', 'c']);
    expect(gelogd).toEqual(['a', 'c']);
  });

  it('also catches a task that throws at once, not in a promise', async () => {
    const volgorde: string[] = [];
    const mislukt = await draaiTaken(
      [
        { naam: 'sync', doe: () => { throw new Error('direct'); } },
        { naam: 'daarna', doe: () => { volgorde.push('daarna'); } },
      ],
      () => {}
    );
    expect(mislukt).toEqual(['sync']);
    expect(volgorde).toEqual(['daarna']);
  });
});

describe('the hourly work of the server', () => {
  it('runs the achterwacht\'s and the AIOS\'s swap work as tasks of their own', () => {
    const bron = readFileSync('instrumentation-node.ts', 'utf8');
    for (const naam of ['ruilherinneringen', 'aios-ruilherinneringen', 'aios-ruilmails', 'ruilmails', 'auto-herinneringen', 'aios-herinneringen']) {
      expect(bron, naam).toContain(`naam: '${naam}'`);
    }
    // The tasks of both diensten in one try is what held the AIOS's up.
    expect(bron).not.toMatch(/try \{[^}]*stuurAutomatischeRuilHerinneringen[^}]*stuurAutomatischeAiosRuilHerinneringen/s);
  });
});

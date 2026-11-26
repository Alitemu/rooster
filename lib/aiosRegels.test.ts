import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { aiosCompensatiedagen, controleerAiosRooster, REGEL_WOORDEN, type Regel } from '@/lib/aiosRegels';
import type { AiosSolverInvoer } from '@/lib/aiosSolverInvoer';

/**
 * The app's copy of the hard rules (lib/aiosRegels.ts) finds in every
 * roster of tests/fixtures/aios-regels.json exactly what the solver's own
 * check (aios-solver/controle.py) found there; aios-solver/test_gedeeld.py
 * checks controle.py against the same file. A rule changed on one side
 * only fails one of the two.
 */

interface Geval {
  naam: string;
  invoer: AiosSolverInvoer;
  roosters: Array<{ toewijzingen: Array<[string, string]>; fouten: Array<[Regel, string, string[]]> }>;
}

const GEVALLEN = (
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/aios-regels.json'), 'utf8')) as { gevallen: Geval[] }
).gevallen;

// Python's sorted() on lists: element by element, a string by code point, a shorter list first.
function vergelijk(a: unknown, b: unknown): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = vergelijk(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  return a === b ? 0 : (a as string) < (b as string) ? -1 : 1;
}

describe('the hard rules, as the solver checks them', () => {
  it('every rule is in the file, and a roster that breaks nothing', () => {
    const gezien = new Set(GEVALLEN.flatMap((g) => g.roosters.flatMap((r) => r.fouten.map((f) => f[0]))));
    expect([...gezien].sort()).toEqual(Object.keys(REGEL_WOORDEN).sort());
    expect(GEVALLEN.some((g) => g.roosters.some((r) => r.fouten.length === 0))).toBe(true);
  });

  for (const geval of GEVALLEN) {
    it(`finds what controle.py found: ${geval.naam}`, () => {
      for (const rooster of geval.roosters) {
        const gevonden = controleerAiosRooster(geval.invoer, new Map(rooster.toewijzingen));
        expect([...gevonden].sort(vergelijk)).toEqual(rooster.fouten);
      }
    });
  }
});

describe('the compensation days per AIOS, for the roosterbureau', () => {
  // A night block zo t/m di from Sunday 2097-05-26, and Hemelvaart on the Thursday after.
  const nacht = (datum: string) => ({ id: `ND-${datum}`, datum, code: 'ND' as const, start_tijd: '22:30', eind_tijd: '08:30', punten: 1, blok_id: 'N1' });
  const invoer = (feestdagen: string[]) => ({
    feestdagen,
    diensten: [nacht('2097-05-26'), nacht('2097-05-27'), nacht('2097-05-28')],
    blokken: [{ id: 'N1', soort: 'NACHT' as const, vorm: 'ZO_DI' as const }],
    aios: [],
  });
  const rooster = new Map([
    ['ND-2097-05-26', 'a'],
    ['ND-2097-05-27', 'a'],
    ['ND-2097-05-28', 'a'],
  ]);

  it('Wednesday and Thursday after a night block zo t/m di', () => {
    expect(aiosCompensatiedagen(invoer([]), rooster)).toEqual(new Map([['a', ['2097-05-29', '2097-05-30']]]));
  });

  it('off a feestdag on a werkdag: Thursday Hemelvaart, so Friday', () => {
    expect(aiosCompensatiedagen(invoer(['2097-05-30']), rooster)).toEqual(new Map([['a', ['2097-05-29', '2097-05-31']]]));
  });
});

describe('a roster that holds someone who is no longer a participant', () => {
  it('names their diensten as outside the membership, and does not throw', () => {
    const invoer = {
      periode: { van: '2097-05-25', tot: '2097-05-31' },
      feestdagen: [],
      diensten: [{ id: 'ND-2097-05-26', datum: '2097-05-26', code: 'ND', start_tijd: '22:30', eind_tijd: '08:30', punten: 1, blok_id: null }],
      blokken: [],
      aios: [],
      tijdslimiet_seconden: 5,
    } as unknown as AiosSolverInvoer;
    expect(controleerAiosRooster(invoer, new Map([['ND-2097-05-26', 'weg']]))).toEqual([['1_BUITEN_LIDMAATSCHAP', 'weg', ['ND-2097-05-26']]]);
  });
});

describe('the compensation days of the quarter before', () => {
  it('start the quarter off: nights zo t/m di right before it give Wednesday and Thursday', () => {
    const invoer = {
      periode: { van: '2097-01-02', tot: '2097-01-08' },
      feestdagen: [],
      diensten: ['2097-01-02', '2097-01-04'].map((datum) => ({ id: `UD-${datum}`, datum, code: 'UD', start_tijd: '17:36', eind_tijd: '20:00', punten: 0.2, blok_id: null })),
      blokken: [],
      aios: [
        {
          id: 'a',
          eerdere_diensten: ['2096-12-30', '2096-12-31', '2097-01-01'].map((datum) => ({
            id: `ND-${datum}`,
            datum,
            code: 'ND',
            start_tijd: '22:30',
            eind_tijd: '08:30',
            blok_id: 'oud',
            blok_soort: 'NACHT',
            blok_vorm: 'ZO_DI',
          })),
        },
      ],
      tijdslimiet_seconden: 5,
    } as unknown as AiosSolverInvoer;
    expect(aiosCompensatiedagen(invoer, new Map())).toEqual(new Map([['a', ['2097-01-02', '2097-01-03']]]));
  });
});

describe('the rules over the boundary, forward (the quarter after)', () => {
  const dienst = (datum: string, code: 'UD' | 'DD' | 'AD' | 'ND', blok: string | null = null) => ({
    id: `${code}-${datum}`,
    datum,
    code,
    start_tijd: code === 'ND' ? '22:30' : code === 'UD' ? '17:36' : '08:00',
    eind_tijd: code === 'ND' ? '08:30' : code === 'UD' ? '20:00' : '17:00',
    punten: 1,
    blok_id: blok,
  });
  const grens = (d: ReturnType<typeof dienst>) => ({ ...d, blok_id: null, blok_soort: null, blok_vorm: null });
  /** This quarter ends 2097-03-31; `latere` is what the AIOS has in the first days of the next. */
  const invoer = (diensten: ReturnType<typeof dienst>[], latere?: ReturnType<typeof dienst>[]) =>
    ({
      periode: { van: '2097-01-01', tot: '2097-03-31' },
      feestdagen: [],
      diensten,
      blokken: [],
      aios: [
        {
          id: 'a',
          fte: 1,
          beschikbaar: [{ van: '2090-01-01', tot: '2099-12-31' }],
          onderbreking: null,
          inwerken: null,
          parttime_dagen: [],
          vier_avonden: false,
          vier_nachten: false,
          twee_dagdiensten: false,
          markeringen: [],
          erboven: {},
          eerdere_diensten: [],
          ...(latere ? { latere_diensten: latere.map(grens) } : {}),
        },
      ],
      tijdslimiet_seconden: 5,
    }) as unknown as AiosSolverInvoer;
  const vind = (i: AiosSolverInvoer, ids: string[], regels?: string[]) =>
    controleerAiosRooster(i, new Map(ids.map((id) => [id, 'a']))).filter((o) => !regels || regels.includes(o[0]));

  it('a single night on the last day gives the next day off: a dienst there in the next quarter breaks rule 7 and 9', () => {
    const nacht = dienst('2097-03-31', 'ND');
    const later = dienst('2097-04-01', 'UD');
    expect(vind(invoer([nacht]), [nacht.id], ['7_COMPENSATIEDAG', '9_RUST'])).toEqual([]);
    const fouten = vind(invoer([nacht], [later]), [nacht.id]);
    expect(fouten).toEqual(
      expect.arrayContaining([
        ['7_COMPENSATIEDAG', 'a', [nacht.id, `later:${later.id}`]],
        ['9_RUST', 'a', [nacht.id, `later:${later.id}`]],
      ])
    );
    expect(fouten).toHaveLength(2);
  });

  it('a compensation day of the next quarter\'s first dienst may fall in this quarter: the Friday before a Saturday dagdienst', () => {
    // 2097-03-28 is a Thursday; the quarter's last Friday is 2097-03-29, and the Saturday 03-30 starts the next roster.
    const vrijdag = dienst('2097-03-29', 'UD');
    const zaterdag = dienst('2097-03-30', 'DD');
    expect(vind(invoer([vrijdag]), [vrijdag.id], ['7_COMPENSATIEDAG'])).toEqual([]);
    expect(vind(invoer([vrijdag], [zaterdag]), [vrijdag.id], ['7_COMPENSATIEDAG'])).toEqual([
      ['7_COMPENSATIEDAG', 'a', [`later:${zaterdag.id}`, vrijdag.id]],
    ]);
  });

  it('the next quarter\'s own diensten are not judged here: two on a day, or eight nights in a row wholly over there', () => {
    const eigen = dienst('2097-03-01', 'UD');
    const dubbel = [dienst('2097-04-02', 'DD'), dienst('2097-04-02', 'UD')];
    expect(vind(invoer([eigen], dubbel), [eigen.id], ['3_TWEE_OP_EEN_DAG'])).toEqual([]);
    const nachten = ['02', '03', '04', '05', '06', '07', '08', '09'].map((d) => dienst(`2097-04-${d}`, 'ND'));
    expect(vind(invoer([eigen], nachten), [eigen.id])).toEqual([]);
  });

  it('a streak of nights from this quarter into the next counts: more than seven is rule 9', () => {
    const eigen = ['28', '29', '30', '31'].map((d) => dienst(`2097-03-${d}`, 'ND'));
    const later = ['01', '02', '03', '04'].map((d) => dienst(`2097-04-${d}`, 'ND'));
    expect(vind(invoer(eigen), eigen.map((d) => d.id), ['9_MEER_DAN_7_NACHTEN'])).toEqual([]);
    expect(vind(invoer(eigen, later), eigen.map((d) => d.id), ['9_MEER_DAN_7_NACHTEN'])).toEqual([['9_MEER_DAN_7_NACHTEN', 'a', ['2097-04-04']]]);
  });

  it('is nothing without the next quarter, or with an AIOS who has nothing there', () => {
    const nacht = dienst('2097-03-31', 'ND');
    expect(vind(invoer([nacht], []), [nacht.id])).toEqual(vind(invoer([nacht]), [nacht.id]));
  });

  it('leaves the compensation days for the roosterbureau as they are: the next quarter\'s days are that roster\'s', () => {
    const nacht = dienst('2097-03-31', 'ND');
    const later = dienst('2097-04-01', 'DD');
    expect(aiosCompensatiedagen(invoer([nacht], [later]), new Map([[nacht.id, 'a']]))).toEqual(aiosCompensatiedagen(invoer([nacht]), new Map([[nacht.id, 'a']])));
  });
});

import { describe, expect, it } from 'vitest';
import { NACHTBLOKKEN_PER_AIOS, nachtblokStand, nachtblokWaarschuwing, type NachtblokInvoer } from './aiosNachtblok';

/**
 * 1.6.0: the page warns before the AIOS roster is made when too few
 * part-timers are known for the night blocks of Sunday to Tuesday
 * (lib/aiosNachtblok.ts; the planner's limit: three blocks per AIOS).
 */
const KWARTAAL = { van: '2027-01-06', tot: '2027-04-06' };
const dag = (i: number) => new Date(Date.parse('2027-01-10T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);

/** `n` night blocks zo-di, one a week from Sunday 10 January 2027, three nights each. */
function blokken(n: number, vorm = 'ZO_DI'): Pick<NachtblokInvoer, 'blokken' | 'diensten'> {
  const lijst = Array.from({ length: n }, (_, i) => ({ id: `b${i}`, soort: 'NACHT', vorm }));
  return { blokken: lijst, diensten: lijst.flatMap((b, i) => [0, 1, 2].map((d) => ({ datum: dag(i * 7 + d), blok_id: b.id }))) };
}
const aios = (fte: number, extra: Partial<NachtblokInvoer['aios'][number]> = {}) => ({ fte, beschikbaar: [KWARTAAL], onderbreking: null, inwerken: null, ...extra });

describe('nachtblokStand', () => {
  it('counts the blocks and who may do them: only below 0,9 fte', () => {
    const stand = nachtblokStand({ ...blokken(13), aios: [aios(1), aios(0.9), aios(0.8), aios(0.8), aios(0.6)] });
    expect(stand).toEqual({ blokken: 13, mogen: 3, tekort: true });
  });

  it('is short from one block more than three per AIOS', () => {
    const vijf = [aios(0.8), aios(0.8), aios(0.8), aios(0.8), aios(0.8)];
    expect(NACHTBLOKKEN_PER_AIOS).toBe(3);
    expect(nachtblokStand({ ...blokken(15), aios: vijf }).tekort).toBe(false);
    expect(nachtblokStand({ ...blokken(16), aios: vijf }).tekort).toBe(true);
    expect(nachtblokStand({ ...blokken(13), aios: vijf }).tekort).toBe(false);
  });

  it('is short when nobody entered a part-time day: everyone counts as full-time', () => {
    expect(nachtblokStand({ ...blokken(13), aios: Array.from({ length: 12 }, () => aios(1)) })).toEqual({ blokken: 13, mogen: 0, tekort: true });
  });

  it('leaves out a block cut up around feestdagen, an evening block and a block of other days', () => {
    const los = blokken(2, 'LOS');
    const avond = { blokken: [{ id: 'a', soort: 'AVOND', vorm: 'ZO_DI' }], diensten: [{ datum: dag(0), blok_id: 'a' }] };
    const woVr = { blokken: [{ id: 'w', soort: 'NACHT', vorm: 'WO_VR' }], diensten: [{ datum: dag(3), blok_id: 'w' }] };
    for (const geval of [los, avond, woVr]) expect(nachtblokStand({ ...geval, aios: [] })).toEqual({ blokken: 0, mogen: 0, tekort: false });
  });

  it('leaves out who is worked in or has interrupted the training for every block', () => {
    const stand = nachtblokStand({
      ...blokken(4),
      aios: [aios(0.8, { inwerken: KWARTAAL }), aios(0.8, { onderbreking: KWARTAAL }), aios(0.8)],
    });
    expect(stand).toEqual({ blokken: 4, mogen: 1, tekort: true });
  });

  it('counts who is worked in for a part of the quarter: a later block is theirs to do', () => {
    const stand = nachtblokStand({ ...blokken(4), aios: [aios(0.8, { inwerken: { van: KWARTAAL.van, tot: dag(8) } }), aios(0.8)] });
    expect(stand).toEqual({ blokken: 4, mogen: 2, tekort: false });
  });

  it('leaves out who is not in the pool on the days of any block', () => {
    const stand = nachtblokStand({ ...blokken(2), aios: [aios(0.8, { beschikbaar: [{ van: '2027-03-01', tot: KWARTAAL.tot }] })] });
    expect(stand.mogen).toBe(0);
  });
});

describe('nachtblokWaarschuwing', () => {
  it('says nothing when there are enough part-timers', () => {
    expect(nachtblokWaarschuwing({ blokken: 13, mogen: 5, tekort: false })).toBeNull();
  });

  it('names the blocks, who may do them, the limit and what the planner checks', () => {
    const tekst = nachtblokWaarschuwing({ blokken: 13, mogen: 2, tekort: true })!;
    expect(tekst).toContain('Te weinig AIOS in deeltijd voor de nachtblokken van zondag tot en met dinsdag. Dit kwartaal heeft er 13.');
    expect(tekst).toContain('Maar 2 AIOS mogen die doen: alleen wie een deeltijdfactor lager dan 0,9 heeft, bijvoorbeeld 0,8.');
    expect(tekst).toContain('Dat is meer dan 3 blokken per AIOS');
    expect(tekst).toContain('Controleer of alle AIOS hun parttimedagen juist hebben opgegeven. Wie niets heeft opgegeven, telt als voltijd.');
  });

  it('is in words for nobody and for one', () => {
    expect(nachtblokWaarschuwing({ blokken: 13, mogen: 0, tekort: true })).toContain('Geen enkele AIOS mag die doen');
    expect(nachtblokWaarschuwing({ blokken: 4, mogen: 1, tekort: true })).toContain('Maar 1 AIOS mag die doen');
  });
});

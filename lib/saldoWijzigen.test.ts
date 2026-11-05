import { describe, it, expect } from 'vitest';
import { kanSaldoWijzigen, saldoInWoorden } from './saldoWijzigen';

describe('saldoInWoorden', () => {
  it('a saldo in words, never a raw sign', () => {
    expect(saldoInWoorden('AVOND', -1)).toBe('1 avonddienst minder');
    expect(saldoInWoorden('WEEKEND', 2)).toBe('2 weekenddiensten extra');
    expect(saldoInWoorden('FEESTDAG', -3)).toBe('3 feestdagdiensten minder');
    for (const n of [-3, -1, 1, 4]) expect(saldoInWoorden('AVOND', n)).not.toMatch(/[-+]\d/);
  });
});

describe('kanSaldoWijzigen', () => {
  it('only while no roster is generated: open or closed, matching the routes', () => {
    expect(kanSaldoWijzigen('OPEN')).toBe(true);
    expect(kanSaldoWijzigen('GESLOTEN')).toBe(true);
    for (const s of ['CONCEPT', 'GEGENEREERD', 'GEPUBLICEERD']) expect(kanSaldoWijzigen(s)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { beginsaldoInWoorden, kanSaldoWijzigen, saldoInWoorden } from './saldoWijzigen';

describe('saldoInWoorden', () => {
  it('a saldo in words, never a raw sign', () => {
    expect(saldoInWoorden('AVOND', -1)).toBe('1 avonddienst minder');
    expect(saldoInWoorden('WEEKEND', 2)).toBe('2 weekenddiensten extra');
    expect(saldoInWoorden('FEESTDAG', -3)).toBe('3 feestdagdiensten minder');
    for (const n of [-3, -1, 1, 4]) expect(saldoInWoorden('AVOND', n)).not.toMatch(/[-+]\d/);
  });

  it('"Grote verschillen" on the period page says it this way too, not "2 weekenddienst extra" (audit 1.2.2)', () => {
    const bron = fs.readFileSync(path.resolve(__dirname, '../components/PlannerDashboard.tsx'), 'utf-8');
    expect(bron).toMatch(/\{saldoInWoorden\(item\.counter, item\.delta\)\}/);
  });
});

describe('beginsaldoInWoorden', () => {
  it('both counters in words, a zero left out, "geen verschil" when both are zero', () => {
    expect(beginsaldoInWoorden(-1, 2)).toBe('1 avonddienst minder, 2 weekenddiensten extra');
    expect(beginsaldoInWoorden(0, -3)).toBe('3 weekenddiensten minder');
    expect(beginsaldoInWoorden(0, 0)).toBe('geen verschil');
  });

  it('step 5 of the wizard says it this way, not "AVOND -1, WEEKEND 2" or "records" (audit 1.2.2)', () => {
    const bron = fs.readFileSync(path.resolve(__dirname, '../components/SetupWizard.tsx'), 'utf-8');
    expect(bron).toMatch(/\{beginsaldoInWoorden\(r\.AVOND_delta \?\? 0, r\.WEEKEND_delta \?\? 0\)\}/);
    expect(bron).not.toMatch(/AVOND \{r\.AVOND_delta/);
    expect(bron).not.toMatch(/records klaar/);
  });
});

describe('kanSaldoWijzigen', () => {
  it('only while no roster is generated: open or closed, matching the routes', () => {
    expect(kanSaldoWijzigen('OPEN')).toBe(true);
    expect(kanSaldoWijzigen('GESLOTEN')).toBe(true);
    for (const s of ['CONCEPT', 'GEGENEREERD', 'GEPUBLICEERD']) expect(kanSaldoWijzigen(s)).toBe(false);
  });
});

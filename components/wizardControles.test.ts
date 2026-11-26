import { describe, expect, it } from 'vitest';
import { bereikInWoorden, kanOpenen, streefbereikInWoorden, wizardControles, type WizardStand } from './wizardControles';

/**
 * 1.6.0: step 7 of "Periode instellen" shows what the period opens with and
 * lets it open only on real checks (components/wizardControles.ts).
 */
const klaar: WizardStand = {
  naam: '2027-1',
  start_datum: '2027-01-04',
  eind_datum: '2027-03-28',
  deadline: '2026-12-01T17:00',
  personeelGeladen: true,
  aantalActief: 30,
  capaciteitGoed: true,
  capaciteitMislukt: false,
  voorstelGeladen: true,
  zelfIngevuld: false,
};
const controle = (stand: WizardStand, naam: string) => wizardControles(stand).find((c) => c.naam === naam)!;

describe('the streefbereik in words', () => {
  it('never shows a raw range', () => {
    expect(bereikInWoorden(2, 3, 'avonddienst', 'avonddiensten')).toBe('2 of 3 avonddiensten');
    expect(bereikInWoorden(0, 1, 'weekenddienst', 'weekenddiensten')).toBe('hoogstens 1 weekenddienst');
    expect(bereikInWoorden(0, 2, 'weekenddienst', 'weekenddiensten')).toBe('hoogstens 2 weekenddiensten');
    expect(bereikInWoorden(0, 0, 'feestdagdienst', 'feestdagdiensten')).toBe('geen feestdagdiensten');
    expect(bereikInWoorden(1, 1, 'feestdagdienst', 'feestdagdiensten')).toBe('1 feestdagdienst');
    expect(bereikInWoorden(4, 4, 'avonddienst', 'avonddiensten')).toBe('4 avonddiensten');
    expect(bereikInWoorden(2, 5, 'avonddienst', 'avonddiensten')).toBe('2 tot en met 5 avonddiensten');
  });

  it('names the three kinds in one sentence part', () => {
    expect(streefbereikInWoorden({ AVOND: 2, WEEKEND: 0, FEESTDAG: 0 }, { AVOND: 3, WEEKEND: 1, FEESTDAG: 0 })).toBe(
      '2 of 3 avonddiensten, hoogstens 1 weekenddienst en geen feestdagdiensten'
    );
  });
});

describe('the checks before a period opens', () => {
  it('lets a period open when everything is there', () => {
    const lijst = wizardControles(klaar);
    expect(lijst.map((c) => c.goed)).toEqual([true, true, true, true]);
    expect(kanOpenen(lijst)).toBe(true);
    expect(controle(klaar, 'Personeel').tekst).toBe('30 actief in deze periode');
  });

  it('does not open while the staff list is on its way, and says so instead of "nobody"', () => {
    const stand = { ...klaar, personeelGeladen: false, aantalActief: 0 };
    expect(kanOpenen(wizardControles(stand))).toBe(false);
    expect(controle(stand, 'Personeel').tekst).toBe('wordt geladen...');
  });

  it('does not open with nobody active, and says what to do', () => {
    const stand = { ...klaar, aantalActief: 0 };
    expect(kanOpenen(wizardControles(stand))).toBe(false);
    expect(controle(stand, 'Personeel').tekst).toContain('niemand actief in deze periode');
    expect(controle(stand, 'Personeel').tekst).toContain('stap 2');
    expect(controle(stand, 'Personeel').tekst).toContain('stap 1');
  });

  it('opens again once someone is active after all', () => {
    expect(kanOpenen(wizardControles({ ...klaar, aantalActief: 0 }))).toBe(false);
    expect(kanOpenen(wizardControles({ ...klaar, aantalActief: 1 }))).toBe(true);
  });

  it('does not open before the proposal for this period is in, whatever the fields hold', () => {
    const stand = { ...klaar, voorstelGeladen: false, capaciteitGoed: null };
    expect(kanOpenen(wizardControles(stand))).toBe(false);
    expect(controle(stand, 'Streefbereik').tekst).toBe('wordt berekend...');
  });

  it('opens on a streefbereik the planner typed, also when the proposal failed', () => {
    const mislukt = { ...klaar, voorstelGeladen: false, capaciteitGoed: null, capaciteitMislukt: true };
    expect(kanOpenen(wizardControles(mislukt))).toBe(false);
    expect(controle(mislukt, 'Streefbereik').tekst).toContain('Vul het streefbereik in bij stap 3');
    const getypt = { ...mislukt, zelfIngevuld: true };
    expect(kanOpenen(wizardControles(getypt))).toBe(true);
    expect(controle(getypt, 'Streefbereik').tekst).toBe('door jou ingevuld in stap 3');
  });

  it('does not open without a deadline', () => {
    const stand = { ...klaar, deadline: '' };
    expect(kanOpenen(wizardControles(stand))).toBe(false);
    expect(controle(stand, 'Periode en deadline').tekst).toContain('stap 1');
  });

  it('warns about too few people but lets the planner open: some shifts may stay empty', () => {
    const stand = { ...klaar, capaciteitGoed: false };
    const lijst = wizardControles(stand);
    expect(controle(stand, 'Capaciteit')).toMatchObject({ goed: false, nodig: false });
    expect(controle(stand, 'Capaciteit').tekst).toContain('te weinig mensen voor dit venster');
    expect(kanOpenen(lijst)).toBe(true);
  });
});

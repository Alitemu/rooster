/**
 * The handmatige correcties of a period's saldo: the reasons a planner picks
 * from, and what one entered correction becomes in the ledger.
 *
 * Shared by the setup wizard (step Correcties, sent when the period opens)
 * and the section "Import en correcties" on the period page (sent at once,
 * until the roster is generated): one list of reasons, so the two cannot
 * drift apart.
 */

export type CorrectionType = 'AVOND' | 'WEEKEND' | 'FEESTDAG' | 'RUIL_AVOND_VOOR_WEEKEND' | 'RUIL_WEEKEND_VOOR_AVOND';
// What the planner picks first - "Ongelijke ruil" then expands into a
// reden dropdown covering both RUIL_* correction types at once.
export type CorrectionTopLevel = 'RUIL' | 'AVOND' | 'WEEKEND' | 'FEESTDAG';

export interface Correction {
  id: string; // local, for the pending list - not a database id
  personId: string;
  codenaam: string;
  type: CorrectionType;
  reden: string;
  aantal: number;
}

export interface CorrectionReasonOption {
  type: CorrectionType;
  label: string;
  // null = the planner must fill in their own value; the field starts empty.
  defaultAantal: number | null;
  explain: (aantal: number) => string;
}

// Every predefined reden defaults to +-1 or +-2 (see defaultAantal above) -
// anything at or beyond this magnitude is far more likely a typo (5 instead
// of 2) than a real correction, so it gets flagged without blocking entry.
export const CORRECTION_AANTAL_WARNING_THRESHOLD = 3;

export const CORRECTION_TOP_LEVEL_LABELS: Record<CorrectionTopLevel, string> = {
  RUIL: 'Ongelijke ruil',
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdag',
};

// Per-teller label for the pending-corrections table - distinct from
// CORRECTION_TOP_LEVEL_LABELS because the two RUIL_* types need their own
// text (they touch two tellers at once), not just the 4-way top-level group.
export const CORRECTION_TYPE_LABELS: Record<CorrectionType, string> = {
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdag',
  RUIL_AVOND_VOOR_WEEKEND: 'Ruil avond → weekend',
  RUIL_WEEKEND_VOOR_AVOND: 'Ruil weekend → avond',
};

export const CORRECTION_REASONS_BY_TOP_LEVEL: Record<CorrectionTopLevel, CorrectionReasonOption[]> = {
  AVOND: [
    {
      type: 'AVOND',
      label: 'Last minute avonddienst overgenomen',
      defaultAantal: -2,
      explain: (n) =>
        `Heeft vorige periode last minute een avonddienst overgenomen en wordt daarvoor nu beloond met ${Math.abs(n)} avonddienst${Math.abs(n) === 1 ? '' : 'en'} minder in de huidige periode.`,
    },
    {
      type: 'AVOND',
      label: 'Overig',
      defaultAantal: null,
      explain: (n) => `Handmatige correctie: avonddienst wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}.`,
    },
  ],
  WEEKEND: [
    {
      type: 'WEEKEND',
      label: 'Last minute weekenddienst overgenomen',
      defaultAantal: -2,
      explain: (n) =>
        `Heeft vorige periode last minute een weekenddienst overgenomen en wordt daarvoor nu beloond met ${Math.abs(n)} weekenddienst${Math.abs(n) === 1 ? '' : 'en'} minder in de huidige periode.`,
    },
    {
      type: 'WEEKEND',
      label: 'Overig',
      defaultAantal: null,
      explain: (n) => `Handmatige correctie: weekenddienst wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}.`,
    },
  ],
  FEESTDAG: [
    {
      type: 'FEESTDAG',
      label: 'Last minute feestdag overgenomen',
      defaultAantal: -2,
      explain: (n) =>
        `Heeft vorige periode last minute een feestdagdienst overgenomen en wordt daarvoor nu beloond met ${Math.abs(n)} feestdagdienst${Math.abs(n) === 1 ? '' : 'en'} minder in de huidige periode.`,
    },
    {
      type: 'FEESTDAG',
      label: 'Overig',
      defaultAantal: null,
      explain: (n) => `Handmatige correctie: feestdag wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}.`,
    },
  ],
  RUIL: [
    {
      type: 'RUIL_AVOND_VOOR_WEEKEND',
      label: 'Ruil avond- voor weekenddienst',
      defaultAantal: 1,
      explain: (n) =>
        `Heeft een avonddienst geruild voor een weekenddienst: avonddienst wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}, weekenddienst wordt ${n >= 0 ? n + ' minder' : Math.abs(n) + ' meer'}.`,
    },
    {
      type: 'RUIL_WEEKEND_VOOR_AVOND',
      label: 'Ruil weekend- voor avonddienst',
      defaultAantal: 1,
      explain: (n) =>
        `Heeft een weekenddienst geruild voor een avonddienst: weekenddienst wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}, avonddienst wordt ${n >= 0 ? n + ' minder' : Math.abs(n) + ' meer'}.`,
    },
  ],
};

/** One ledger row a correction becomes: a plain counter, a reden, an aantal (delta < 0 = fewer shifts). */
export interface CorrectieRegel {
  type: 'AVOND' | 'WEEKEND' | 'FEESTDAG';
  reden: string;
  aantal: number;
}

/**
 * What one entered correction writes. An ongelijke ruil touches two counters
 * at once: it becomes its two halves, the second with the mirrored reden and
 * the opposite aantal (one avonddienst more is one weekenddienst fewer).
 */
export function correctieRegels(reason: CorrectionReasonOption, aantal: number): CorrectieRegel[] {
  if (reason.type === 'RUIL_AVOND_VOOR_WEEKEND' || reason.type === 'RUIL_WEEKEND_VOOR_AVOND') {
    const mirror = CORRECTION_REASONS_BY_TOP_LEVEL.RUIL.find((r) => r.type !== reason.type)!;
    const eerste = reason.type === 'RUIL_AVOND_VOOR_WEEKEND' ? 'AVOND' : 'WEEKEND';
    const tweede = eerste === 'AVOND' ? 'WEEKEND' : 'AVOND';
    return [
      { type: eerste, reden: reason.label, aantal },
      { type: tweede, reden: mirror.label, aantal: -aantal },
    ];
  }
  return [{ type: reason.type, reden: reason.label, aantal }];
}

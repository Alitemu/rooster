/**
 * What the step Bevestigen sums up before a participant of the achterwacht confirms: the days geblokkeerd
 * per kind of dienst, the days with a voorkeur and the days on liever niet. The last were in no summary
 * (audit per role R-09, 1.7.0), so whoever had marked them could not see them back before confirming.
 */
export interface VoorkeurTelling {
  geblokkeerd: { AVOND: number; WEEKEND: number; FEESTDAG: number; total: number };
  voorkeur: number;
  lieverNiet: number;
}

const TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG'] as const;
const isTeller = (t: string): t is (typeof TELLERS)[number] => (TELLERS as readonly string[]).includes(t);

export function telVoorkeuren(voorkeuren: ReadonlyArray<{ teller: string; blocking_level: string | null }>): VoorkeurTelling {
  const uit: VoorkeurTelling = { geblokkeerd: { AVOND: 0, WEEKEND: 0, FEESTDAG: 0, total: 0 }, voorkeur: 0, lieverNiet: 0 };
  for (const v of voorkeuren) {
    if (v.blocking_level === 'VOORKEUR') uit.voorkeur++;
    else if (v.blocking_level === 'LIEVER_NIET') uit.lieverNiet++;
    else if (v.blocking_level === 'ABSOLUUT' && isTeller(v.teller)) {
      uit.geblokkeerd[v.teller]++;
      uit.geblokkeerd.total++;
    }
  }
  return uit;
}

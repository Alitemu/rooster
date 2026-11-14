/**
 * What step 7 of "Periode instellen" says before the period opens (1.6.0).
 *
 * The wizard read its data per step: the proposed streefbereik only while
 * step 3 was on screen, the staff only on step 2 or 6. A planner who came
 * back later and went straight to step 7 read "0 actief" with 30 people
 * active, or opened the period on the range the code started with (7 or 8
 * avonddiensten, whatever the period): everyone's invitation then promised
 * "ongeveer 8 avonddiensten" for a period with two each (audit per role,
 * R-01). The list of ticks under it was fixed text.
 *
 * Now both are read when the wizard opens, the streefbereik stands in step
 * 7 in words, and the list is these checks. `nodig`: the period cannot be
 * opened while it fails. The capacity is a warning: a planner may open a
 * period knowing some shifts will stay empty.
 *
 * No React, no db: tested on plain values (components/wizardControles.test.ts).
 */

export type Bereik = Record<'AVOND' | 'WEEKEND' | 'FEESTDAG', number>;

/** "2 of 3 avonddiensten", "hoogstens 1 weekenddienst", "geen feestdagdiensten": never "2-3" or "[2,3]". */
export function bereikInWoorden(min: number, max: number, enkel: string, meervoud: string): string {
  const woord = (n: number) => (n === 1 ? enkel : meervoud);
  if (max <= 0) return `geen ${meervoud}`;
  if (min <= 0) return `hoogstens ${max} ${woord(max)}`;
  if (min === max) return `${max} ${woord(max)}`;
  return max - min === 1 ? `${min} of ${max} ${meervoud}` : `${min} tot en met ${max} ${meervoud}`;
}

export function streefbereikInWoorden(min: Bereik, max: Bereik): string {
  return (
    `${bereikInWoorden(min.AVOND, max.AVOND, 'avonddienst', 'avonddiensten')}, ` +
    `${bereikInWoorden(min.WEEKEND, max.WEEKEND, 'weekenddienst', 'weekenddiensten')} en ` +
    `${bereikInWoorden(min.FEESTDAG, max.FEESTDAG, 'feestdagdienst', 'feestdagdiensten')}`
  );
}

/**
 * The same sentence from a frozen ruleset (bandAvond: [min, max] and so on), for the period page's header:
 * it read "Avond 3-4 · Weekend 1-2 · Feestdag 0-1", the raw range the rules ban (audit 4, N-06). Null when
 * a band is missing or not two numbers.
 */
export function streefbereikUitRuleset(cfg: unknown): string | null {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const paar = (v: unknown): [number, number] | null =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1]] : null;
  const [a, w, f] = [paar(c.bandAvond), paar(c.bandWeekend), paar(c.bandFeestdag)];
  if (!a || !w || !f) return null;
  return streefbereikInWoorden({ AVOND: a[0], WEEKEND: w[0], FEESTDAG: f[0] }, { AVOND: a[1], WEEKEND: w[1], FEESTDAG: f[1] });
}

export interface WizardStand {
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  /** The staff list is the one of these dates (not still on its way, not of the dates before a change). */
  personeelGeladen: boolean;
  aantalActief: number;
  /** The capacity check of these dates and this window, or null while it is on its way or after it failed. */
  capaciteitGoed: boolean | null;
  capaciteitMislukt: boolean;
  /** The proposal that fits this period is in the fields. */
  voorstelGeladen: boolean;
  /** The planner typed a streefbereik in step 3. */
  zelfIngevuld: boolean;
}

export interface WizardControle {
  naam: string;
  goed: boolean;
  nodig: boolean;
  tekst: string;
}

export function streefbereikKlaar(stand: Pick<WizardStand, 'voorstelGeladen' | 'zelfIngevuld'>): boolean {
  return stand.voorstelGeladen || stand.zelfIngevuld;
}

export function wizardControles(stand: WizardStand): WizardControle[] {
  const periodeGoed = Boolean(stand.naam.trim() && stand.start_datum && stand.eind_datum && stand.deadline);
  const bereikGoed = streefbereikKlaar(stand);
  return [
    {
      naam: 'Periode en deadline',
      goed: periodeGoed,
      nodig: true,
      tekst: periodeGoed ? 'ingevuld' : 'de naam, de datums of de deadline ontbreken (stap 1)',
    },
    {
      naam: 'Personeel',
      goed: stand.personeelGeladen && stand.aantalActief > 0,
      nodig: true,
      tekst: !stand.personeelGeladen
        ? 'wordt geladen...'
        : stand.aantalActief > 0
          ? `${stand.aantalActief} actief in deze periode`
          : 'niemand actief in deze periode. Voeg iemand toe of zet iemand actief (stap 2). Of pas de datums van de periode aan (stap 1)',
    },
    {
      naam: 'Streefbereik',
      goed: bereikGoed,
      nodig: true,
      tekst: stand.zelfIngevuld
        ? 'door jou ingevuld in stap 3'
        : stand.voorstelGeladen
          ? 'het voorstel dat bij deze periode en dit aantal mensen past'
          : stand.capaciteitMislukt
            ? 'het voorstel kon niet berekend worden. Vul het streefbereik in bij stap 3'
            : 'wordt berekend...',
    },
    {
      naam: 'Capaciteit',
      goed: stand.capaciteitGoed === true,
      nodig: false,
      tekst:
        stand.capaciteitGoed === null
          ? stand.capaciteitMislukt
            ? 'kon niet berekend worden'
            : 'wordt berekend...'
          : stand.capaciteitGoed
            ? 'genoeg mensen voor dit venster'
            : 'te weinig mensen voor dit venster: een deel van de diensten kan leeg blijven (stap 3)',
    },
  ];
}

/** The period can be opened: every check that is needed holds. */
export function kanOpenen(controles: ReadonlyArray<WizardControle>): boolean {
  return controles.every((c) => c.goed || !c.nodig);
}

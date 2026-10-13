/**
 * Why shifts stayed empty after generating, in words a planner can act on.
 *
 * generate-roster marks each empty shift with what is certain about it
 * (`reden`: nobody a member of the pool that day, or every member blocked
 * it) and says per counter when the streefbereik's maximums together fall
 * short of its shifts (`bereik_tekort`). Without this the dialog said "not
 * enough people available" for every cause alike: a planner whose
 * memberships ended halfway the period saw 160 empty shifts with every
 * planner and window and had no way to see why.
 *
 * Pure, no db: used by the client dialog and tested on its own.
 */

export interface UnfilledSlotInfo {
  datum: string | null;
  teller: string | null;
  reden?: 'GEEN_LID' | 'IEDEREEN_GEBLOKKEERD' | null;
}

export type BereikTekort = Partial<
  Record<'AVOND' | 'WEEKEND' | 'FEESTDAG', { maximaal: number; diensten: number; voorgesteld?: [number, number] }>
>;

const MEERVOUD: Record<string, string> = {
  AVOND: 'avonddiensten',
  WEEKEND: 'weekenddiensten',
  FEESTDAG: 'feestdagdiensten',
};

function datumTekst(datum: string): string {
  return new Date(`${datum}T12:00:00Z`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function aantal(n: number, enkel: string, meer: string): string {
  return `${n} ${n === 1 ? enkel : meer}`;
}

/** Consecutive dates as ranges: "1 april 2027 t/m 5 september 2027", "3 mei 2027". */
export function dateRanges(dates: string[]): string[] {
  const sorted = [...new Set(dates)].sort();
  const ranges: Array<[string, string]> = [];
  for (const d of sorted) {
    const last = ranges[ranges.length - 1];
    const dayAfter = last ? new Date(Date.parse(`${last[1]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : null;
    if (last && d === dayAfter) last[1] = d;
    else ranges.push([d, d]);
  }
  return ranges.map(([a, b]) => (a === b ? datumTekst(a) : `${datumTekst(a)} t/m ${datumTekst(b)}`));
}

/**
 * One sentence per counter whose streefbereik cannot hold its shifts: the
 * same words after a generation and, in the generation dialog, before it
 * (lib/bandShortfall.ts).
 */
export function explainBereikTekort(bereikTekort: BereikTekort): string[] {
  return Object.entries(bereikTekort)
    .filter(([, t]) => t && t.maximaal < t.diensten)
    .map(([teller, tekort]) => {
      const soort = MEERVOUD[teller] ?? 'diensten';
      const voorstel = tekort!.voorgesteld;
      const advies = voorstel
        ? `Verhoog het bereik onder Venster en streefbereik, bijvoorbeeld naar ${voorstel[0] === voorstel[1] ? voorstel[0] : `${voorstel[0]} tot ${voorstel[1]}`} ${soort} per persoon.`
        : 'Verhoog het bereik onder Venster en streefbereik.';
      return `Het streefbereik laat samen hoogstens ${tekort!.maximaal} ${soort} toe, terwijl er ${tekort!.diensten} zijn. ${advies}`;
    });
}

/**
 * One sentence per cause, the most telling first; empty when nothing
 * stayed empty. `deelsLid`: how many members' Geldig vanaf/tot covers only
 * part of the period, which lowers their streefbereik in proportion.
 */
export function explainUnfilled(unfilled: UnfilledSlotInfo[], bereikTekort: BereikTekort = {}, deelsLid = 0): string[] {
  if (unfilled.length === 0) return [];
  const lines: string[] = [];

  const geenLid = unfilled.filter((u) => u.reden === 'GEEN_LID' && u.datum);
  if (geenLid.length > 0) {
    const ranges = dateRanges(geenLid.map((u) => u.datum!));
    const shown = ranges.length > 3 ? `${ranges.slice(0, 3).join(', ')} en nog ${ranges.length - 3} keer` : ranges.join(', ');
    lines.push(
      `Voor ${aantal(geenLid.length, 'dienst', 'diensten')} is op die dag niemand lid van de pool: ${shown}. ` +
        'Controleer Geldig vanaf en Geldig tot bij Medewerkers.'
    );
  }

  const geblokkeerd = unfilled.filter((u) => u.reden === 'IEDEREEN_GEBLOKKEERD');
  if (geblokkeerd.length > 0) {
    lines.push(`Voor ${aantal(geblokkeerd.length, 'dienst', 'diensten')} heeft iedereen die dag geblokkeerd.`);
  }

  const tekorten = Object.entries(bereikTekort).filter(([, t]) => t && t.maximaal < t.diensten);
  if (deelsLid > 0 && (tekorten.length > 0 || unfilled.length > geenLid.length + geblokkeerd.length)) {
    lines.push(
      `${deelsLid === 1 ? '1 persoon doet' : `${deelsLid} mensen doen`} volgens Geldig vanaf en Geldig tot maar een deel van de periode mee. ` +
        `${deelsLid === 1 ? 'Het streefbereik van die persoon' : 'Hun streefbereik'} is daarom naar verhouding lager. Klopt dat niet, pas het dan aan bij Medewerkers.`
    );
  }

  lines.push(...explainBereikTekort(bereikTekort));
  const doorBereik = tekorten.reduce((sum, [, t]) => sum + t!.diensten - t!.maximaal, 0);

  // What the causes above leave unexplained: the streefbereik's shortfall
  // accounts for that many of the shifts without a certain reason.
  // These the people and their bereik could take: a method that searches
  // differently, or longer, may well fill them (audit 9: "Willekeurig" left
  // Pinksterzondag that the other three filled).
  const rest = Math.max(0, unfilled.length - geenLid.length - geblokkeerd.length - doorBereik);
  if (rest > 0) {
    lines.push(
      (geenLid.length + geblokkeerd.length + doorBereik === 0
        ? `${aantal(rest, 'dienst lukte', 'diensten lukten')} niet binnen het venster en het streefbereik van de beschikbare mensen.`
        : `Nog ${aantal(rest, 'dienst lukte', 'diensten lukten')} niet binnen het venster en het streefbereik.`) +
        ` Een andere methode of langer zoeken vult ${rest === 1 ? 'hem' : 'ze'} misschien wel.`
    );
  }
  return lines;
}

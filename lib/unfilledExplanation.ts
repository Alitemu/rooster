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

export type BereikTekort = Partial<Record<'AVOND' | 'WEEKEND' | 'FEESTDAG', { maximaal: number; diensten: number }>>;

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

/** One sentence per cause, the most telling first; empty when nothing stayed empty. */
export function explainUnfilled(unfilled: UnfilledSlotInfo[], bereikTekort: BereikTekort = {}): string[] {
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

  for (const [teller, tekort] of Object.entries(bereikTekort)) {
    if (!tekort) continue;
    lines.push(
      `Het streefbereik laat samen hoogstens ${tekort.maximaal} ${MEERVOUD[teller] ?? 'diensten'} toe, terwijl er ${tekort.diensten} zijn. ` +
        'Verhoog het bereik onder Venster en streefbereik.'
    );
  }

  const rest = unfilled.length - geenLid.length - geblokkeerd.length;
  if (rest > 0) {
    lines.push(
      lines.length === 0
        ? `${aantal(rest, 'dienst lukte', 'diensten lukten')} niet binnen het venster en het streefbereik van de beschikbare mensen.`
        : `De overige ${aantal(rest, 'dienst lukte', 'diensten lukten')} niet binnen het venster en het streefbereik.`
    );
  }
  return lines;
}

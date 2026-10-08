/**
 * The swap itself, written out for a mail about it.
 *
 * The in-app notification says "Aangeboden: 2027-03-02 (avonddienst)" -
 * fine next to the request in the app, where the rest is on screen. A
 * mail is read on its own, so it says from the reader's own side what they
 * give up and what they get, with the day written out.
 *
 * A mail never names the other side of a swap that hasn't gone through:
 * the planner's flow turns every codenaam it is told about into a real name
 * (lib/verzendlijst.ts `personen`), and a request is anonymous by mail
 * until it is approved, so the colleague can say no without knowing to
 * whom. In the app both sides keep seeing each other's codenaam, which is a
 * pseudonym. Once approved (`goedgekeurd`) the mail names both, with the
 * lines to pass on to whoever makes the work rosters.
 */

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

export interface SwapShift {
  datum: string;
  teller: string;
}

/** "maandag 1 maart 2027". The date is a calendar day, so no timezone may shift it. */
export function formatSwapDate(datum: string): string {
  return new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${datum}T00:00:00Z`));
}

function shift(s: SwapShift): string {
  return `${TELLER_LABELS[s.teller] ?? 'dienst'} op ${formatSwapDate(s.datum)}`;
}

export function swapMailDetails(params: {
  /** Who reads this mail. */
  lezer: 'aanvrager' | 'collega';
  aanvrager: string;
  collega: string;
  /** The requester's own shift, which the colleague would take over. */
  aangeboden: SwapShift;
  /** The colleague's shift, which the requester would take over. */
  gevraagd: SwapShift;
  toelichting?: string | null;
  /** The reader would end up with two shifts close together. */
  kortOpElkaar?: boolean;
  /**
   * The swap did not go through (rejected, withdrawn or lapsed): nothing
   * changes, so it is described as what was asked.
   */
  afgewezen?: boolean;
  redenAfwijzing?: string | null;
  /** The swap went through: name both sides and say what to pass on. */
  goedgekeurd?: boolean;
}): string {
  const aanvrager = params.lezer === 'aanvrager';
  let regels: string[];
  if (params.afgewezen) {
    regels = [
      aanvrager
        ? `Je vroeg je ${shift(params.aangeboden)} te ruilen tegen een ${shift(params.gevraagd)}.`
        : `Je werd gevraagd je ${shift(params.gevraagd)} te ruilen tegen een ${shift(params.aangeboden)}.`,
      'Je rooster blijft zoals het was.',
    ];
  } else if (params.goedgekeurd) {
    const [geeft, krijgt, ander] = aanvrager
      ? [params.aangeboden, params.gevraagd, params.collega]
      : [params.gevraagd, params.aangeboden, params.aanvrager];
    regels = [
      `Jij geeft: je ${shift(geeft)} aan ${ander}`,
      `Jij krijgt: de ${shift(krijgt)} van ${ander}`,
      '',
      'Geef deze ruil door aan wie de werkroosters maakt:',
      `${params.aanvrager} neemt de ${shift(params.gevraagd)} over van ${params.collega}.`,
      `${params.collega} neemt de ${shift(params.aangeboden)} over van ${params.aanvrager}.`,
    ];
  } else if (aanvrager) {
    regels = [`Jij geeft: je ${shift(params.aangeboden)}`, `Jij krijgt: een ${shift(params.gevraagd)}`];
  } else {
    regels = [`Jij geeft: je ${shift(params.gevraagd)}`, `Jij krijgt: een ${shift(params.aangeboden)}`];
  }

  const toelichting = params.toelichting?.trim();
  if (toelichting) {
    regels.push('', aanvrager ? `Je toelichting: ${toelichting}` : `Toelichting: ${toelichting}`);
  }
  if (params.kortOpElkaar) {
    regels.push('', 'Let op: na deze ruil heb je twee diensten kort op elkaar.');
  }
  const reden = params.redenAfwijzing?.trim();
  if (reden) regels.push('', `Reden: ${reden}`);
  return regels.join('\n');
}

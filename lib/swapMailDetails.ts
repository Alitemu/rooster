/**
 * The swap itself, written out for a mail about it.
 *
 * The in-app notification says "Aangeboden: 2027-03-02 (avonddienst)" -
 * fine next to the request in the app, where the rest is on screen. A
 * mail is read on its own, so it says from the reader's own side what they
 * give up and what they get, with the day written out.
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
}): string {
  const aanvrager = params.lezer === 'aanvrager';
  let regels: string[];
  if (params.afgewezen) {
    regels = [
      aanvrager
        ? `Je vroeg je ${shift(params.aangeboden)} te ruilen tegen de ${shift(params.gevraagd)} van ${params.collega}.`
        : `${params.aanvrager} vroeg je ${shift(params.gevraagd)} te ruilen tegen de ${shift(params.aangeboden)} van ${params.aanvrager}.`,
      'Je rooster blijft zoals het was.',
    ];
  } else if (aanvrager) {
    regels = [
      `Jij geeft: je ${shift(params.aangeboden)}`,
      `Jij krijgt: de ${shift(params.gevraagd)} van ${params.collega}`,
    ];
  } else {
    regels = [
      `Jij geeft: je ${shift(params.gevraagd)}`,
      `Jij krijgt: de ${shift(params.aangeboden)} van ${params.aanvrager}`,
    ];
  }

  const toelichting = params.toelichting?.trim();
  if (toelichting) {
    regels.push('', aanvrager ? `Je toelichting: ${toelichting}` : `Toelichting van ${params.aanvrager}: ${toelichting}`);
  }
  if (params.kortOpElkaar) {
    regels.push('', 'Let op: na deze ruil heb je twee diensten kort op elkaar.');
  }
  const reden = params.redenAfwijzing?.trim();
  if (reden) regels.push('', `Reden: ${reden}`);
  return regels.join('\n');
}

/**
 * The streefbereik of a period that is open (audit per role R-06, 1.7.0). After opening it could be changed
 * only in Rooster genereren, which is closed while the period is open: a range that was wrong (R-01 could
 * make one) went into every invitation without a way back. PATCH /api/periods/[id]/ruleset could do it all
 * along, for an open period too, with the audit log and the row version; the period page offers it now
 * while the period is open, next to the streefbereik in words.
 */

export type BereikTeller = 'AVOND' | 'WEEKEND' | 'FEESTDAG';
export type BereikInvoer = Record<BereikTeller, { van: string; tot: string }>;
export const BEREIK_TELLERS: readonly BereikTeller[] = ['AVOND', 'WEEKEND', 'FEESTDAG'];

const VELD = { AVOND: 'bandAvond', WEEKEND: 'bandWeekend', FEESTDAG: 'bandFeestdag' } as const;
const LABEL: Record<BereikTeller, string> = { AVOND: 'Streefbereik avond', WEEKEND: 'Streefbereik weekend', FEESTDAG: 'Streefbereik feestdag' };

/** Only while the period is open: from closed on, Rooster genereren has these fields itself. */
export function streefbereikAanpasbaar(status: string): boolean {
  return status === 'OPEN';
}

/** The fields filled with the frozen ranges, or null when one is missing. */
export function invoerUitRuleset(cfg: unknown): BereikInvoer | null {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const uit = {} as BereikInvoer;
  for (const t of BEREIK_TELLERS) {
    const band = c[VELD[t]];
    if (!Array.isArray(band) || band.length !== 2) return null;
    uit[t] = { van: String(band[0]), tot: String(band[1]) };
  }
  return uit;
}

export type BereikUitkomst =
  | { ok: true; body: { bandAvond: [number, number]; bandWeekend: [number, number]; bandFeestdag: [number, number] } }
  | { ok: false; fout: string };

/** The fields as the route takes them, or, for the first that is wrong, the route's own words (lib/rulesetValidation.ts). */
export function leesBereikInvoer(invoer: BereikInvoer): BereikUitkomst {
  const body = {} as { bandAvond: [number, number]; bandWeekend: [number, number]; bandFeestdag: [number, number] };
  const heel = (x: string) => /^\d{1,3}$/.test(x.trim());
  for (const t of BEREIK_TELLERS) {
    const { van, tot } = invoer[t];
    if (!heel(van) || !heel(tot) || Number(van) > Number(tot)) {
      return { ok: false, fout: `${LABEL[t]}: vul twee hele getallen van 0 of meer in. Het minimum mag niet hoger zijn dan het maximum.` };
    }
    body[VELD[t]] = [Number(van), Number(tot)];
  }
  return { ok: true, body };
}

/** The invitations name the expected number (lib/periodInvitations.ts indicatieTekst): sent already, they named the old one. */
export const NA_UITNODIGING =
  'De uitnodigingen zijn al verstuurd en noemden het oude aantal. Wil je dat iedereen het nieuwe aantal leest? Verstuur de uitnodigingen dan opnieuw onder Exporteren & communicatie.';

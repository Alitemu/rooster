/**
 * Rooster instellen (components/SetupWizard.tsx) for a new period starts from
 * what the pool's previous period was opened with: the verdeling, the two
 * windows and the blokkadebudget. Until 1.4.0 the wizard always started on
 * Gelijk and 100% (audit 1.3.0): 2027-1 ran Naar rato, 2027-2 opened on
 * Gelijk without a word, and a part-timer at 0.8 got a full-timer's
 * streefaantal unless the planner caught it in the summary.
 *
 * The streefbereik is not taken over: the capacity check works it out from
 * this period's own slots and headcount (the wizard's "Venster" step). Nor
 * are the solver's advanced settings: the wizard opens every period with
 * the Prioriteitenplanner, as before.
 */

import { db } from '@/db/client';
import { resolveWindowWeeks } from '@/lib/windowWeeks';

export interface VorigeInstellingen {
  /** The name of the period the settings come from, for "Overgenomen van …". */
  periode_naam: string;
  distributionMode: string;
  windowWeeksAvond: number;
  windowWeeksWeekendFeestdag: number;
  /** Percentages as the wizard shows them (100 = no limit). */
  hardPercent: number;
  softPercent: number;
  parttimeExempt: boolean;
}

/** The wizard sets one fraction for all three counters; the avond one stands for them. */
function percent(budget: unknown): number {
  const avond = (budget as { AVOND?: { maxFraction?: unknown } } | undefined)?.AVOND?.maxFraction;
  return typeof avond === 'number' ? Math.round(avond * 100) : 100;
}

/**
 * The settings of the pool's latest opened period that starts before this
 * one, outside the trash; null for the pool's first period. Opened is having
 * a frozen ruleset: "Periode openen" writes it and a concept has none.
 */
export function vorigeInstellingen(periodId: string): VorigeInstellingen | null {
  const vorige = db
    .prepare(
      `SELECT v.naam, v.bevroren_ruleset_json
       FROM dienstrooster_schedule_period p
       JOIN dienstrooster_schedule_period v ON v.pool_id = p.pool_id AND v.id != p.id
       WHERE p.id = ? AND v.verwijderd_op IS NULL AND v.start_datum < p.start_datum
         AND v.bevroren_ruleset_json IS NOT NULL
       ORDER BY v.start_datum DESC
       LIMIT 1`
    )
    .get(periodId) as { naam: string; bevroren_ruleset_json: string } | undefined;
  if (!vorige) return null;

  const config = JSON.parse(vorige.bevroren_ruleset_json) as Record<string, unknown>;
  const venster = resolveWindowWeeks(config);
  const hard = config.blockBudget as { parttimeExempt?: unknown } | undefined;
  return {
    periode_naam: vorige.naam,
    distributionMode: config.distributionMode === 'NAAR_RATO' ? 'NAAR_RATO' : 'GELIJK',
    windowWeeksAvond: venster.avond,
    windowWeeksWeekendFeestdag: venster.weekendFeestdag,
    hardPercent: percent(config.blockBudget),
    softPercent: percent(config.softBlockBudget),
    // The same default as lib/blockBudget.ts when the field is missing.
    parttimeExempt: typeof hard?.parttimeExempt === 'boolean' ? hard.parttimeExempt : true,
  };
}

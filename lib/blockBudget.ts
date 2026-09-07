/**
 * Block budget: an optional per-period cap on how many slots of one counter
 * a single person may block, expressed as a fraction of that counter's
 * total slots in the period.
 *
 * Two independent budgets share the same shape: `blockBudget` caps
 * ABSOLUUT (hard) blocks, `softBlockBudget` caps LIEVER_NIET (soft) ones.
 * Both default to "no limit" (maxFraction 1, or the field absent entirely)
 * so a period without this configured behaves exactly as before it existed.
 *
 * Denominator is the period's total slot count for that counter - the same
 * number every person is measured against, from lib/rosterBands.ts.
 * Numerator is the person's own ABSOLUUT/LIEVER_NIET rows for that counter
 * in this period, optionally excluding part-time-pattern-sourced rows
 * (`parttimeExempt`) since those aren't a preference the person chose.
 */

import { db } from '@/db/client';
import { resolveRulesetConfig, countSlotsByTeller, TELLERS, type Teller } from '@/lib/rosterBands';
import type { BlockLevel } from '@/types';

const TELLER_LABELS: Record<Teller, string> = {
  AVOND: 'avonddiensten',
  WEEKEND: 'weekenddiensten',
  FEESTDAG: 'feestdagdiensten',
};

const LEVEL_MESSAGES: Record<'ABSOLUUT' | 'LIEVER_NIET', (max: number, teller: string) => string> = {
  ABSOLUUT: (max, teller) => `Je hebt het maximum van ${max} geblokkeerde ${teller} voor deze periode al bereikt.`,
  LIEVER_NIET: (max, teller) =>
    `Je hebt het maximum van ${max} "liever niet"-voorkeuren voor ${teller} voor deze periode al bereikt.`,
};

interface TellerFraction {
  maxFraction: number;
}

interface ResolvedBudget {
  perTeller: Record<Teller, TellerFraction>;
  parttimeExempt: boolean;
}

function resolveBudget(
  config: Record<string, unknown>,
  key: 'blockBudget' | 'softBlockBudget'
): ResolvedBudget | null {
  const raw = config[key];
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;

  const perTeller = {} as Record<Teller, TellerFraction>;
  let anyConfigured = false;
  for (const teller of TELLERS) {
    const entry = c[teller] as { maxFraction?: unknown } | undefined;
    const fraction = entry && typeof entry.maxFraction === 'number' ? entry.maxFraction : 1;
    if (fraction < 1) anyConfigured = true;
    perTeller[teller] = { maxFraction: fraction };
  }
  if (!anyConfigured) return null;

  return {
    perTeller,
    parttimeExempt: typeof c.parttimeExempt === 'boolean' ? c.parttimeExempt : true,
  };
}

export interface BlockBudgetCheckResult {
  allowed: boolean;
  message?: string;
}

/**
 * Would setting `level` on this slot push the person over their block
 * budget for that slot's counter? Slots already at `level` are excluded
 * from the person's own count (via `excludeSlotId`), since re-saving the
 * same slot at the same level, or switching an existing block's level, must
 * not count the slot twice.
 */
export function checkBlockBudget(params: {
  period: { bevroren_ruleset_json?: string | null; pool_id: string };
  periodId: string;
  personId: string;
  teller: Teller;
  level: BlockLevel;
  excludeSlotId: string;
}): BlockBudgetCheckResult {
  const config = resolveRulesetConfig(params.period);
  const key = params.level === 'ABSOLUUT' ? 'blockBudget' : 'softBlockBudget';
  const budget = resolveBudget(config, key);
  if (!budget) return { allowed: true };

  const maxFraction = budget.perTeller[params.teller].maxFraction;
  if (maxFraction >= 1) return { allowed: true };

  const totalSlots = countSlotsByTeller(params.periodId)[params.teller];
  const maxAllowed = Math.floor(totalSlots * maxFraction);

  const sourceFilter = budget.parttimeExempt ? `AND a.source != 'PARTTIME'` : '';
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM dienstrooster_availability a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.person_id = ? AND s.period_id = ? AND st.teller = ? AND a.blocking_level = ?
         AND a.slot_id != ?
         ${sourceFilter}`
    )
    .get(params.personId, params.periodId, params.teller, params.level, params.excludeSlotId) as {
    count: number;
  };

  if (row.count + 1 > maxAllowed) {
    return {
      allowed: false,
      message: LEVEL_MESSAGES[params.level](maxAllowed, TELLER_LABELS[params.teller]),
    };
  }

  return { allowed: true };
}

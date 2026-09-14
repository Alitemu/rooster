/**
 * Shared TypeScript types for Dienstrooster
 *
 * Convention: Always use consistent naming
 * - Counter types: AVOND, WEEKEND, FEESTDAG (enums)
 * - Roles: ADMIN, PLANNER, DEELNEMER (enums)
 * - Balance amounts: delta < 0 means fewer shifts, delta > 0 means more shifts
 */

export type Role = 'ADMIN' | 'PLANNER' | 'DEELNEMER';
export type CounterType = 'AVOND' | 'WEEKEND' | 'FEESTDAG';
export type BlockLevel = 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR';
export type BlockSource = 'ZELF' | 'PARTTIME' | 'BEHEERDER';
export type PeriodStatus = 'CONCEPT' | 'OPEN' | 'GESLOTEN' | 'GEGENEREERD' | 'GEPUBLICEERD';
export type DistributionMode = 'GELIJK' | 'NAAR_RATO';
export type PartTimeFrequency = 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
export type Weekday = 'MA' | 'DI' | 'WO' | 'DO' | 'VR' | 'ZA' | 'ZO';
export type AbsenceType = 'VAKANTIE' | 'ZIEK' | 'VERLOF' | 'OVERIG';
export type LedgerCategory = 'CARRY_OVER' | 'CORRECTIE' | 'BEGINSALDO';
export type ImportType = 'BEGINSALDI' | 'FEESTDAG_HISTORIE';
export type HolidayGroup = 'NIEUWJAAR' | 'PASEN' | 'KONINGSDAG' | 'BEVRIJDINGSDAG' | 'HEMELVAART' | 'PINKSTEREN' | 'KERST';
export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'PUBLISH'
  | 'IMPORT'
  | 'GENERATE_ROSTER'
  | 'MANUAL_ASSIGN'
  | 'CANCEL'
  | 'REJECT'
  | 'APPROVE';

// Database Models
export interface Person {
  id: string;
  codenaam: string;
  rol: Role;
  actief: boolean;
  wachtwoord_hash?: string | null;
  totp_secret?: string | null;
  aangemaakt_op: string;
}

export interface PersonAccessLink {
  id: string;
  person_id: string;
  token_hash: string;
  aangemaakt_op: string;
  ingetrokken_op?: string | null;
  laatst_gebruikt_op?: string | null;
}

export interface Pool {
  id: string;
  naam: string;
  type: 'ACHTERWACHT' | 'NEURO' | 'KINDER' | 'INTERVENTIE' | 'AIOS';
  ruleset_id: string;
  verdeelmodus: DistributionMode;
  actief: boolean;
  aangemaakt_op: string;
}

export interface PoolMembership {
  id: string;
  person_id: string;
  pool_id: string;
  deelnamefactor: number;
  geldig_vanaf: string; // ISO date
  geldig_tot: string; // ISO date
}

export interface SchedulePeriod {
  id: string;
  pool_id: string;
  naam: string;
  start_datum: string; // ISO date
  eind_datum: string; // ISO date
  deadline: string; // ISO datetime
  status: PeriodStatus;
  bevroren_ruleset_json?: string | null;
  overloop_bevestigd_op?: string | null;
  gepubliceerd_op?: string | null;
  gepubliceerd_door_person_id?: string | null;
  row_version: number;
  aangemaakt_op: string;
  verwijderd_op?: string | null;
}

export interface ShiftSlot {
  id: string;
  period_id: string;
  shift_type_id: string;
  datum: string; // ISO date
  iso_jaar: number;
  iso_week: number;
  weekend_id?: string | null;
  is_feestdag: boolean;
  feestdag_naam?: string | null;
  feestdag_groep?: HolidayGroup | null;
  benodigd_aantal_personen: number;
  shift_block_id?: string | null;
}

export interface LedgerEntry {
  id: string;
  person_id: string;
  pool_id: string;
  teller: CounterType;
  geldt_voor_periode_id: string;
  datum?: string | null;
  delta: number; // Negative = fewer, positive = more
  reden: string;
  categorie: LedgerCategory;
  aangemaakt_door: string;
  aangemaakt_op: string;
}

export interface HolidayHistory {
  id: string;
  person_id: string;
  feestdag_groep: HolidayGroup;
  jaar: number;
  bron: 'SYSTEEM' | 'IMPORT' | 'HANDMATIG';
}

// API Response Types
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

// UI State Types
export interface AuthState {
  isAuthenticated: boolean;
  person?: Person;
  role?: Role;
  token?: string;
}

export interface BalanceDisplay {
  counter: CounterType;
  current: number;
  target: string; // e.g., "8 or 9"
  delta: number;
  message: string; // User-facing message in words
}

// Ruleset Configuration
export interface RulesetConfig {
  // Legacy, pooled window (AVOND/WEEKEND/FEESTDAG share one minimum-weeks-
  // between-shifts rule) - only ever read for a period frozen before
  // windowWeeksAvond/windowWeeksWeekendFeestdag existed. Every period
  // opened or regenerated since then carries those two instead; see
  // generate-roster/route.ts for the fallback.
  windowWeeks: number;
  // AVOND has its own minimum weeks between shifts; WEEKEND and FEESTDAG
  // share a second one (not three separate windows) - but a shift of one
  // type CAN still block a nearby shift of the other: the *smaller* of
  // the two values applies as a floor between every pair of shifts
  // regardless of type, on top of each group's own (typically larger)
  // same-type cap. See solver/constraints.py's add_window_constraints
  // (counters param) and solver/greedy.py's _window_group/window_ok for
  // the exact floor-plus-per-group decomposition.
  // holidaySpreadWithinPeriod below is unrelated - a separate,
  // FEESTDAG-only extra rule that predates this split.
  windowWeeksAvond: number;
  windowWeeksWeekendFeestdag: number;
  blockBudget: {
    AVOND: { maxFraction: number };
    WEEKEND: { maxFraction: number };
    FEESTDAG: { maxFraction: number };
    parttimeExempt: boolean;
  };
  softBlockBudget: {
    AVOND: { maxFraction: number };
    WEEKEND: { maxFraction: number };
    FEESTDAG: { maxFraction: number };
    parttimeExempt?: boolean;
  };
  softBlockPenalty: number;
  softBlockPenaltyPerPriorViolation: number;
  softBlockPriorViolationCap: number;
  largeBalanceThreshold: number;
  bandDeviationPenalty: number[];
  bandDeviationMultiplier: number;
  holidaySpreadWithinPeriod: number;
  // Solver objective weights - see solver/main.py's RuleSet for the
  // matching Python defaults these mirror (1000.0 / 0.5 / 0.3).
  shortfallWeight: number;
  bandImbalanceWeight: number;
  preferenceRewardWeight: number;
  // Which roster-generation approach to use - 'weighted' ("Puntenplanner",
  // the model shortfallWeight/bandImbalanceWeight/preferenceRewardWeight
  // above tune), 'lexicographic' ("Prioriteitenplanner", the default for
  // new periods - ignores those weights, solves dekking > eerlijkheid >
  // liever-niet > voorkeur in strict priority order instead), or
  // 'multi_start' ("Herhaalplanner" - repeats a 'lexicographic' solve up
  // to maxAttempts times with a different random seed each time), or
  // 'randomized' ("Gerandomiseerde planner" - repeats a non-CP-SAT greedy
  // day-by-day construction instead, see solver/greedy.py and
  // randomizedVariant below). Both multi-attempt modes keep the best
  // result found; see generate-roster/route.ts's runMultiStart. See
  // solver/solver.py's module docstring for the weighted/lexicographic
  // comparison.
  objectiveMode: 'weighted' | 'lexicographic' | 'multi_start' | 'randomized';
  // Only consulted when objectiveMode is 'multi_start' or 'randomized' -
  // how many times to repeat before giving up and keeping the best found
  // so far (a planner can also stop it early via the cancel button, or it
  // stops itself the moment an attempt is "perfect" - see
  // isPerfectRoster).
  maxAttempts: number;
  // Only consulted when objectiveMode is 'randomized'. 'medewerker': days
  // filled in chronological order, employee list randomized per slot.
  // 'dagen': day order is ALSO randomized (employee-list randomization is
  // identical to 'medewerker'). See solver/greedy.py's module docstring.
  randomizedVariant: 'medewerker' | 'dagen';
}

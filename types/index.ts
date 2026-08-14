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
export type BlockLevel = 'ABSOLUUT' | 'LIEVER_NIET';
export type BlockSource = 'ZELF' | 'PARTTIME' | 'BEHEERDER';
export type PeriodStatus = 'CONCEPT' | 'OPEN' | 'GESLOTEN' | 'GEGENEREERD' | 'GEPUBLICEERD';
export type DistributionMode = 'GELIJK' | 'NAAR_RATO';
export type PartTimeFrequency = 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
export type Weekday = 'MA' | 'DI' | 'WO' | 'DO' | 'VR' | 'ZA' | 'ZO';
export type AbsenceType = 'VAKANTIE' | 'ZIEK' | 'VERLOF' | 'OVERIG';
export type LedgerCategory = 'CARRY_OVER' | 'CORRECTIE' | 'BEGINSALDO';
export type ImportType = 'BEGINSALDI' | 'FEESTDAG_HISTORIE';
export type HolidayGroup = 'NIEUWJAAR' | 'PASEN' | 'KONINGSDAG' | 'BEVRIJDINGSDAG' | 'HEMELVAART' | 'PINKSTEREN' | 'KERST';
export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'PUBLISH' | 'IMPORT';

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
  row_version: number;
  aangemaakt_op: string;
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
  error: string;
  details?: Record<string, string>;
  status: number;
}

export interface ApiSuccessResponse<T> {
  data: T;
  status: number;
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
  windowWeeks: number;
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
  };
  softBlockPenalty: number;
  softBlockPenaltyPerPriorViolation: number;
  softBlockPriorViolationCap: number;
  fairShareMode: DistributionMode;
  largeBalanceThreshold: number;
  bandDeviationPenalty: number[];
  bandDeviationMultiplier: number;
  holidaySpreadWithinPeriod: number;
}

/**
 * The AIOS roster's period: a quarter from a Wednesday to a Tuesday
 * (docs/aios-rooster.md, "Periode"), so the evening and night blocks
 * (Sunday to Tuesday, Wednesday to Friday) always fit inside it.
 *
 * Q1 starts on the first Wednesday after 1 January - on 8 January when 1
 * January is itself a Wednesday - the rule of the planner's old Excel form.
 * Q2 and Q3 start 13 weeks later each; Q4 runs to the day before the next
 * Q1, 13 or 14 weeks. (The form ended Q4 a week too late in a year whose 1
 * January of the next year is a Tuesday, so Q4 and Q1 overlapped; here they
 * never do.)
 *
 * Pure date arithmetic: the period page computes it in the browser too.
 */

import { addDays, parseISO } from './holidays';

export type Kwartaal = 1 | 2 | 3 | 4;

export const KWARTALEN: readonly Kwartaal[] = [1, 2, 3, 4];

export interface AiosQuarter {
  jaar: number;
  kwartaal: Kwartaal;
  start_datum: string; // a Wednesday
  eind_datum: string; // a Tuesday
}

/** First Wednesday after 1 January of `jaar` (never 1 January itself). */
function q1Start(jaar: number): string {
  const jan1 = `${jaar}-01-01`;
  const dag = parseISO(jan1).getDay(); // 0 = Sunday .. 6 = Saturday
  // Days to the next Wednesday (3), a full week when it already is one.
  const verder = ((3 - dag + 7) % 7) || 7;
  return addDays(jan1, verder);
}

export function aiosQuarter(jaar: number, kwartaal: Kwartaal): AiosQuarter {
  const start = addDays(q1Start(jaar), 91 * (kwartaal - 1));
  const eind = kwartaal === 4 ? addDays(q1Start(jaar + 1), -1) : addDays(start, 90);
  return { jaar, kwartaal, start_datum: start, eind_datum: eind };
}

/**
 * The quarter that runs exactly from `start` to `eind`, or null. A period
 * of an AIOS pool must be one: anything else would cut a block in two or
 * leave days of the quarter to no period.
 */
export function exactAiosQuarter(start: string, eind: string): AiosQuarter | null {
  const jaar = parseISO(start).getFullYear();
  for (const j of [jaar, jaar - 1]) {
    for (const k of KWARTALEN) {
      const q = aiosQuarter(j, k);
      if (q.start_datum === start && q.eind_datum === eind) return q;
    }
  }
  return null;
}

/** The quarter `datum` falls in. */
export function aiosQuarterContaining(datum: string): AiosQuarter {
  const jaar = parseISO(datum).getFullYear();
  // A date before this year's Q1 is in last year's Q4.
  for (const j of [jaar, jaar - 1]) {
    for (const k of [4, 3, 2, 1] as const) {
      const q = aiosQuarter(j, k);
      if (q.start_datum <= datum && datum <= q.eind_datum) return q;
    }
  }
  // Unreachable: the quarters of two consecutive years cover every day.
  throw new Error(`No AIOS quarter contains ${datum}`);
}

/** The quarter after `q`. */
export function nextAiosQuarter(q: AiosQuarter): AiosQuarter {
  return q.kwartaal === 4 ? aiosQuarter(q.jaar + 1, 1) : aiosQuarter(q.jaar, (q.kwartaal + 1) as Kwartaal);
}

/** "2027 Q1", as the old form named them. */
export function aiosQuarterName(q: Pick<AiosQuarter, 'jaar' | 'kwartaal'>): string {
  return `${q.jaar} Q${q.kwartaal}`;
}

/** How many weeks the quarter has: 13, or 14 for some Q4s. */
export function aiosQuarterWeeks(q: AiosQuarter): number {
  const dagen = Math.round((parseISO(q.eind_datum).getTime() - parseISO(q.start_datum).getTime()) / 86_400_000) + 1;
  return Math.round(dagen / 7);
}

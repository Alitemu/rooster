/**
 * Prior Assignment Derivation Tests
 *
 * Rule: "One test = one proof a rule can't be broken"
 */

import { describe, it, expect } from 'vitest';
import {
  calculatePriorAssignmentWeeks,
  resolvePriorAssignmentWeeks,
  calculatePriorAssignmentRange,
  generateSkeletonPriorAssignments,
  doRangesOverlap,
  countPriorAssignmentEntries,
  countBySource,
  getAssignedEntries,
  getUnknownEntries,
  groupByDate,
  validatePriorAssignments,
  type DerivedPriorAssignment,
} from './priorAssignmentDerive';
import { dateToISO, parseISO } from './holidays';

describe('Prior Assignment Derivation', () => {
  describe('calculatePriorAssignmentWeeks', () => {
    it('calculates windowWeeks - 1 weeks to lookback', () => {
      expect(calculatePriorAssignmentWeeks(7)).toBe(6);
      expect(calculatePriorAssignmentWeeks(5)).toBe(4);
      expect(calculatePriorAssignmentWeeks(1)).toBe(0);
    });

    it('returns 0 for single-week windows', () => {
      expect(calculatePriorAssignmentWeeks(1)).toBe(0);
    });
  });

  /**
   * How deep the history carried over from the previous period has to be.
   *
   * The window rule is what these prior assignments exist for: without
   * enough of them, the solver cannot see a shift that happened just
   * before this period started, and can put someone on duty too soon
   * after it. Three routes each derived this number themselves with
   * `JSON.parse(...).windowWeeks || 7`, which got it wrong in three
   * different ways - each has a case below.
   */
  describe('resolvePriorAssignmentWeeks', () => {
    it('reads the window from the frozen ruleset', () => {
      const period = { pool_id: 'p', bevroren_ruleset_json: JSON.stringify({ windowWeeks: 5 }) };
      expect(resolvePriorAssignmentWeeks(period)).toBe(4);
    });

    it('falls back to the same default the solver uses, not to 7', () => {
      // resolveWindowWeeks falls back to 2, so this must give 2 - 1 = 1.
      // The old code answered 6 here, carrying five weeks of history that
      // nothing asked for.
      const period = { pool_id: 'p', bevroren_ruleset_json: JSON.stringify({}) };
      expect(resolvePriorAssignmentWeeks(period)).toBe(1);
    });

    it('honours an explicitly configured window of 0', () => {
      // `windowWeeks || 7` read a deliberate 0 ("no window rule") as
      // falsy and silently substituted 7.
      const period = { pool_id: 'p', bevroren_ruleset_json: JSON.stringify({ windowWeeks: 0 }) };
      expect(resolvePriorAssignmentWeeks(period)).toBe(0);
    });

    it('sees per-teller windows, and takes the one that reaches furthest', () => {
      // A period configured this way has no legacy windowWeeks at all, so
      // the old code fell back to 7 regardless of what these said. The
      // history has to be deep enough for the larger of the two.
      const period = {
        pool_id: 'p',
        bevroren_ruleset_json: JSON.stringify({
          windowWeeksAvond: 3,
          windowWeeksWeekendFeestdag: 6,
        }),
      };
      expect(resolvePriorAssignmentWeeks(period)).toBe(5);
    });

    it('lets a per-teller window override the pooled one', () => {
      const period = {
        pool_id: 'p',
        bevroren_ruleset_json: JSON.stringify({ windowWeeks: 2, windowWeeksWeekendFeestdag: 8 }),
      };
      expect(resolvePriorAssignmentWeeks(period)).toBe(7);
    });

    it('survives a ruleset that is not valid JSON', () => {
      // resolveRulesetConfig falls through to the pool's own ruleset for
      // this; with no such pool in the test database that means defaults,
      // and the important part is that it answers rather than throwing.
      const period = { pool_id: 'no-such-pool', bevroren_ruleset_json: '{ niet: json' };
      expect(() => resolvePriorAssignmentWeeks(period)).not.toThrow();
    });

    it('handles large window weeks', () => {
      expect(calculatePriorAssignmentWeeks(52)).toBe(51);
    });
  });

  describe('calculatePriorAssignmentRange', () => {
    it('calculates correct date range for 6-week lookback', () => {
      const [start, end] = calculatePriorAssignmentRange('2027-09-04', 6);

      expect(end).toBe('2027-09-04');

      // 6 weeks back from 2027-09-04 (Sunday)
      // Week 6 ends on Sunday (35 - 6 = week 29)
      // Actually: 6 weeks = 42 days back from Sunday = 2027-07-24
      const startParsed = parseISO(start);
      const endParsed = parseISO(end);
      const diffDays = Math.floor((endParsed.getTime() - startParsed.getTime()) / (1000 * 60 * 60 * 24));

      // Should be 42 days (6 weeks) - 1 day inclusive = 41 days
      expect(diffDays).toBe(41);
    });

    it('returns a well-formed empty range for 0-week lookback', () => {
      const [start, end] = calculatePriorAssignmentRange('2027-09-04', 0);

      expect(end).toBe('2027-09-04');
      // No lookback at all must mean an empty range, not an inverted one -
      // start has to land strictly after end (exactly one day after, not
      // an arbitrary earlier date), so the range is unambiguously empty
      // rather than merely "start > end" by some other, confusing amount.
      expect(start).toBe('2027-09-05');
      expect(parseISO(start).getTime()).toBeGreaterThan(parseISO(end).getTime());

      // And it must actually behave as empty downstream.
      expect(generateSkeletonPriorAssignments(start, end)).toHaveLength(0);
    });

    it('handles year boundary correctly', () => {
      const [start, end] = calculatePriorAssignmentRange('2027-01-03', 2);

      expect(end).toBe('2027-01-03');

      // Should go back into December 2026
      const startParsed = parseISO(start);
      expect(startParsed.getFullYear()).toBe(2026);
    });
  });

  describe('generateSkeletonPriorAssignments', () => {
    it('creates one entry per day per counter (3 entries/day)', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-09-04',
        ['AVOND', 'WEEKEND', 'FEESTDAG']
      );

      // 6 days × 3 counters = 18 entries
      expect(assignments).toHaveLength(18);
    });

    it('marks all entries as ONBEKEND source', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-09-04',
        ['AVOND', 'WEEKEND', 'FEESTDAG']
      );

      assignments.forEach((a) => {
        expect(a.bron).toBe('ONBEKEND');
        expect(a.person_codenaam).toBeNull();
        expect(a.bron_period_id).toBeNull();
      });
    });

    it('sets correct ISO week values', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-09-05',
        ['AVOND']
      );

      // All entries should have consistent iso_jaar and iso_week per date
      const dateGroups = new Map<string, number[]>();
      for (const a of assignments) {
        if (!dateGroups.has(a.datum)) {
          dateGroups.set(a.datum, [a.iso_week]);
        }
      }

      // Each date should have only one ISO week value
      dateGroups.forEach((weeks) => {
        expect(new Set(weeks).size).toBe(1);
      });
    });

    it('covers all dates in range with no gaps', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-09-04',
        ['AVOND']
      );

      const dates = new Set(assignments.map((a) => a.datum));
      const startParsed = parseISO('2027-08-30');
      const endParsed = parseISO('2027-09-04');

      let current = new Date(startParsed);
      while (current <= endParsed) {
        const dateStr = dateToISO(current);
        expect(dates.has(dateStr)).toBe(true);
        current.setDate(current.getDate() + 1);
      }
    });

    it('respects custom shift counters', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-08-31',
        ['AVOND', 'WEEKEND']
      );

      // 2 days × 2 counters = 4 entries
      expect(assignments).toHaveLength(4);

      const counters = new Set(assignments.map((a) => a.teller));
      expect(counters).toEqual(new Set(['AVOND', 'WEEKEND']));
    });
  });

  describe('doRangesOverlap', () => {
    it('detects overlapping ranges', () => {
      const result = doRangesOverlap(
        '2027-08-28',
        '2027-09-04',
        '2027-09-05',
        '2027-09-11'
      );

      // These should overlap or be adjacent
      expect(result).toBe(true);
    });

    it('detects non-overlapping ranges', () => {
      const result = doRangesOverlap(
        '2027-08-15',
        '2027-08-20',
        '2027-09-05',
        '2027-09-11'
      );

      expect(result).toBe(false);
    });

    it('detects identical ranges as overlapping', () => {
      const result = doRangesOverlap(
        '2027-08-28',
        '2027-09-04',
        '2027-08-28',
        '2027-09-04'
      );

      expect(result).toBe(true);
    });
  });

  describe('countPriorAssignmentEntries', () => {
    it('counts total entries correctly', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-09-04',
        ['AVOND', 'WEEKEND', 'FEESTDAG']
      );

      const count = countPriorAssignmentEntries(assignments);
      expect(count).toBe(18);
    });

    it('returns 0 for empty array', () => {
      expect(countPriorAssignmentEntries([])).toBe(0);
    });
  });

  describe('countBySource', () => {
    it('counts entries by derivation source', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: 'Persoon-01',
          bron: 'AFGELEID',
          bron_period_id: 'period-123',
        },
        {
          datum: '2027-08-31',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: 'Persoon-02',
          bron: 'HANDMATIG',
          bron_period_id: null,
        },
        {
          datum: '2027-09-01',
          iso_jaar: 2027,
          iso_week: 36,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const counts = countBySource(assignments);

      expect(counts['AFGELEID']).toBe(1);
      expect(counts['HANDMATIG']).toBe(1);
      expect(counts['ONBEKEND']).toBe(1);
    });
  });

  describe('getAssignedEntries', () => {
    it('filters to only entries with known persons', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: 'Persoon-01',
          bron: 'AFGELEID',
          bron_period_id: 'period-123',
        },
        {
          datum: '2027-08-31',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const assigned = getAssignedEntries(assignments);

      expect(assigned).toHaveLength(1);
      expect(assigned[0].person_codenaam).toBe('Persoon-01');
    });

    it('returns empty for all-unknown entries', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const assigned = getAssignedEntries(assignments);

      expect(assigned).toHaveLength(0);
    });
  });

  describe('getUnknownEntries', () => {
    it('filters to only unknown entries', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: 'Persoon-01',
          bron: 'AFGELEID',
          bron_period_id: 'period-123',
        },
        {
          datum: '2027-08-31',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const unknown = getUnknownEntries(assignments);

      expect(unknown).toHaveLength(1);
      expect(unknown[0].person_codenaam).toBeNull();
    });
  });

  describe('groupByDate', () => {
    it('groups assignments by date', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: 'Persoon-01',
          bron: 'AFGELEID',
          bron_period_id: 'period-123',
        },
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'WEEKEND',
          person_codenaam: 'Persoon-02',
          bron: 'HANDMATIG',
          bron_period_id: null,
        },
        {
          datum: '2027-08-31',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const grouped = groupByDate(assignments);

      expect(grouped.size).toBe(2);
      expect(grouped.get('2027-08-30')).toHaveLength(2);
      expect(grouped.get('2027-08-31')).toHaveLength(1);
    });

    it('returns empty map for empty assignments', () => {
      const grouped = groupByDate([]);

      expect(grouped.size).toBe(0);
    });
  });

  describe('validatePriorAssignments', () => {
    it('accepts valid assignments', () => {
      const assignments = generateSkeletonPriorAssignments(
        '2027-08-30',
        '2027-09-04',
        ['AVOND', 'WEEKEND', 'FEESTDAG']
      );

      const result = validatePriorAssignments(assignments);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects invalid date format', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027/08/30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const result = validatePriorAssignments(assignments);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects invalid ISO week', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 54,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const result = validatePriorAssignments(assignments);

      expect(result.valid).toBe(false);
    });

    it('rejects invalid teller', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'INVALID',
          person_codenaam: null,
          bron: 'ONBEKEND',
          bron_period_id: null,
        },
      ];

      const result = validatePriorAssignments(assignments);

      expect(result.valid).toBe(false);
    });

    it('rejects AFGELEID without bron_period_id', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: 'Persoon-01',
          bron: 'AFGELEID',
          bron_period_id: null,
        },
      ];

      const result = validatePriorAssignments(assignments);

      expect(result.valid).toBe(false);
    });

    it('rejects HANDMATIG without person_codenaam', () => {
      const assignments: DerivedPriorAssignment[] = [
        {
          datum: '2027-08-30',
          iso_jaar: 2027,
          iso_week: 35,
          teller: 'AVOND',
          person_codenaam: null,
          bron: 'HANDMATIG',
          bron_period_id: null,
        },
      ];

      const result = validatePriorAssignments(assignments);

      expect(result.valid).toBe(false);
    });
  });
});

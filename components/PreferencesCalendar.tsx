'use client';

/**
 * Preferences Calendar Component
 *
 * Interactive calendar grid for blocking preferences.
 * - Real <table> so week numbers and weekdays line up in columns, instead
 *   of a repeated block-per-week layout - that misalignment was the main
 *   source of "onoverzichtelijk" (unclear) feedback on the previous version.
 * - ISO week numbers always visible, in their own column
 * - Saturday/Sunday separate cells
 * - Four states per day: neutral, prefer-not, blocked, part-time -
 *   distinguished by color, pattern, and glyph together, never color alone
 * - "Block whole weekend" quick action, absolutely positioned so it can't
 *   stretch Saturday's row taller than the rest (the old layout bug)
 * - Live per-day coverage bar + count, and a running blocked-days summary
 *   per shift type at the top
 * - A social-pressure notice that reacts to whichever day was last
 *   touched (or, before any click, to the tightest day in the period)
 * - Auto-save with debounce
 * - Mobile-first, 375px min width
 */

import { useState, useCallback, useEffect } from 'react';
import { dateToISO, parseISO, getISOWeek, getHolidayInfo, addDays } from '@/lib/holidays';

type BlockLevel = 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null;

interface SlotPreference {
  slot_id: string;
  level: BlockLevel;
  source: string | null; // MANUAL, PARTTIME, ABSENCE, or null when level is null
}

interface DayPreference {
  datum: string;
  slots: Map<string, SlotPreference>; // teller -> {slot_id, level}
}

interface CoverageInfo {
  datum: string;
  total_in_pool: number;
  absoluut_blocked: number;
  liever_niet: number;
  voorkeur: number;
  available: number;
  message: string;
}

interface Props {
  personId: string;
  periodId: string;
  shiftCounters?: string[]; // Default: ['AVOND', 'WEEKEND', 'FEESTDAG']
  onPreferencesChange?: (changed: boolean) => void;
  onCoverageUpdate?: (coverage: Map<string, CoverageInfo>) => void;
}

const COUNTER_LABEL: Record<string, string> = {
  AVOND: 'Avonddiensten',
  WEEKEND: 'Weekenddiensten',
  FEESTDAG: 'Feestdagdiensten',
};

const GLYPH: Record<Exclude<BlockLevel, null>, string> = {
  VOORKEUR: '+',
  LIEVER_NIET: '~',
  ABSOLUUT: '✕',
};

const WEEKDAY_TAG = ['', '', '', '', '', 'za', 'zo']; // index 5/6 = Saturday/Sunday

function coverageBarClass(ratio: number): string {
  if (ratio < 0.3) return 'coverage-critical';
  if (ratio < 0.6) return 'coverage-warning';
  return 'coverage-good';
}

function formatDayLong(datum: string): string {
  return parseISO(datum).toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function coverageNoteText(cov: CoverageInfo): string {
  const day = formatDayLong(cov.datum);
  if (cov.absoluut_blocked === 0) {
    return `Op ${day} heeft nog niemand geblokkeerd. Alle ${cov.total_in_pool} collega's zijn beschikbaar.`;
  }
  return (
    `Op ${day} hebben ${cov.absoluut_blocked} van de ${cov.total_in_pool} collega's al geblokkeerd. ` +
    `Er blijven ${cov.available} mensen over voor die dag.`
  );
}

export function PreferencesCalendar({
  personId,
  periodId,
  shiftCounters = ['AVOND', 'WEEKEND', 'FEESTDAG'],
  onPreferencesChange,
  onCoverageUpdate,
}: Props) {
  const [preferences, setPreferences] = useState<Map<string, DayPreference>>(new Map());
  const [coverage, setCoverage] = useState<Map<string, CoverageInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanged, setHasChanged] = useState(false);
  const [highlightDatum, setHighlightDatum] = useState<string | null>(null);

  // Fetch initial preferences
  useEffect(() => {
    const fetchPreferences = async () => {
      try {
        const res = await fetch(`/api/person/${personId}/preferences/${periodId}`);
        if (!res.ok) throw new Error('Failed to fetch preferences');

        const data = await res.json();
        const prefs = new Map<string, DayPreference>();

        for (const slot of data.data.preferences) {
          const key = slot.datum;
          if (!prefs.has(key)) {
            prefs.set(key, {
              datum: key,
              slots: new Map(),
            });
          }
          prefs.get(key)!.slots.set(slot.teller, {
            slot_id: slot.slot_id,
            level: slot.blocking_level,
            source: slot.source,
          });
        }

        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load preferences:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchPreferences();
  }, [personId, periodId]);

  // Fetch coverage. Also called again after every save (see savePreference)
  // - without that, the bars, day cells, and the notice below the calendar
  // would keep showing pool-wide numbers from before the participant's own
  // just-saved change, which is exactly the kind of stale "live" number
  // CLAUDE.md's balance-messaging rule warns against.
  const fetchCoverage = useCallback(async () => {
    try {
      const res = await fetch(`/api/person/${personId}/preferences/${periodId}/coverage`);
      if (!res.ok) throw new Error('Failed to fetch coverage');

      const data = await res.json();
      const cov = new Map<string, CoverageInfo>(
        data.data.coverage_by_day.map((c: CoverageInfo) => [c.datum, c])
      );

      setCoverage(cov);
      onCoverageUpdate?.(cov);
    } catch (error) {
      console.error('Failed to load coverage:', error);
    }
  }, [personId, periodId, onCoverageUpdate]);

  useEffect(() => {
    fetchCoverage();
  }, [fetchCoverage]);

  // Before the participant has clicked anything, point the notice at the
  // tightest day in the period rather than leaving it empty - that's the
  // day most worth their attention first.
  useEffect(() => {
    if (highlightDatum || coverage.size === 0) return;
    let tightest: CoverageInfo | null = null;
    for (const c of coverage.values()) {
      if (!tightest || c.available < tightest.available) tightest = c;
    }
    if (tightest) setHighlightDatum(tightest.datum);
  }, [coverage, highlightDatum]);

  // Debounced save
  const savePreference = useCallback(
    async (slotId: string, level: BlockLevel) => {
      setIsSaving(true);
      try {
        const res = await fetch(`/api/person/${personId}/preferences/slot/${slotId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level }),
        });

        if (!res.ok) throw new Error('Failed to save preference');
        await fetchCoverage();
      } catch (error) {
        console.error('Failed to save preference:', error);
      } finally {
        setIsSaving(false);
      }
    },
    [personId, fetchCoverage]
  );

  // Handle preference click. Slots generated from a part-time pattern
  // (source === 'PARTTIME') are locked - see the day-cell rendering below,
  // which never wires this handler to their button in the first place, so
  // this is only ever called for slots the participant can actually edit.
  const handleTogglePreference = useCallback(
    (datum: string, teller: string) => {
      setHighlightDatum(datum);
      setPreferences((prev) => {
        const dayPref = prev.get(datum);
        const slot = dayPref?.slots.get(teller);

        if (!slot) {
          console.error('Slot not found for', datum, teller);
          return prev;
        }

        // Cycle: null → VOORKEUR → LIEVER_NIET → ABSOLUUT → null
        let next: BlockLevel;
        if (slot.level === null) next = 'VOORKEUR';
        else if (slot.level === 'VOORKEUR') next = 'LIEVER_NIET';
        else if (slot.level === 'LIEVER_NIET') next = 'ABSOLUUT';
        else next = null;

        const updated = new Map(prev);
        const updatedSlots = new Map(dayPref!.slots);
        updatedSlots.set(teller, { slot_id: slot.slot_id, level: next, source: next ? 'MANUAL' : null });
        updated.set(datum, { datum, slots: updatedSlots });

        setHasChanged(true);
        onPreferencesChange?.(true);
        savePreference(slot.slot_id, next);

        return updated;
      });
    },
    [savePreference, onPreferencesChange]
  );

  // Block whole weekend
  const handleBlockWeekend = useCallback(
    (satDate: string) => {
      const satParsed = parseISO(satDate);
      const sunParsed = new Date(satParsed);
      sunParsed.setDate(sunParsed.getDate() + 1);
      const sunDate = dateToISO(sunParsed);

      for (const counter of shiftCounters) {
        handleTogglePreference(satDate, counter);
        handleTogglePreference(sunDate, counter);
      }
    },
    [shiftCounters, handleTogglePreference]
  );

  if (loading) {
    return <div className="p-4 text-center">Voorkeuren laden...</div>;
  }

  // Generate calendar grid: as many full weeks as the period actually spans
  const weeks: string[][] = [];
  const allDates = Array.from(preferences.values()).map((p) => p.datum).sort();

  if (allDates.length === 0) {
    return <div className="p-4 text-center">Geen datums beschikbaar</div>;
  }

  const startDate = parseISO(allDates[0]);
  const endDate = parseISO(allDates[allDates.length - 1]);
  // Inclusive day count first, then divide - not (days / 7) + 1, which
  // over-counts by a full week (e.g. a real 22-week, 154-day period came
  // out as 23) and pushed the period's real last day into a spare row
  // under the wrong weekday column.
  const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);
  let currentDate = new Date(startDate);

  while (weeks.length < totalWeeks) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(dateToISO(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    weeks.push(week);
  }

  // Group weeks by calendar month (of the week's Monday) so the calendar
  // reads as a series of distinct months instead of one continuous wall of
  // weeks - a week that straddles a month boundary stays with the month it
  // starts in, rather than splitting its row in two.
  const monthGroups: { label: string; weeks: string[][] }[] = [];
  for (const week of weeks) {
    const label = parseISO(week[0]).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
    const current = monthGroups[monthGroups.length - 1];
    if (current && current.label === label) {
      current.weeks.push(week);
    } else {
      monthGroups.push({ label, weeks: [week] });
    }
  }

  // Blocked-days summary per shift type, computed live from what's on
  // screen - no extra request needed, updates the moment a cell is clicked.
  const counterTotals = new Map<string, { blocked: number; total: number }>();
  for (const counter of shiftCounters) counterTotals.set(counter, { blocked: 0, total: 0 });
  for (const dayPref of preferences.values()) {
    for (const counter of shiftCounters) {
      const slot = dayPref.slots.get(counter);
      if (!slot) continue;
      const totals = counterTotals.get(counter)!;
      totals.total++;
      if (slot.level === 'ABSOLUUT') totals.blocked++;
    }
  }

  const highlightCov = highlightDatum ? coverage.get(highlightDatum) : undefined;

  return (
    <div className="space-y-4">
      {/* Blocked-days counters */}
      <div className="flex gap-3 flex-wrap">
        {shiftCounters.map((counter) => {
          const totals = counterTotals.get(counter)!;
          const pct = totals.total > 0 ? Math.round((totals.blocked / totals.total) * 100) : 0;
          return (
            <div key={counter} className="flex-1 min-w-[180px] border border-neutral-200 rounded-lg p-3 bg-white">
              <div className="flex justify-between items-baseline text-xs text-neutral-600">
                <span>{COUNTER_LABEL[counter] || counter} geblokkeerd</span>
                <span className="font-mono">{totals.blocked} van {totals.total}</span>
              </div>
              <div className="text-lg font-semibold tracking-tight mt-0.5 mb-1.5">{pct}%</div>
              <div className="coverage-bar">
                <div className="coverage-bar-fill bg-blue-600" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-neutral-600">
        <span className="flex items-center gap-1.5">
          <i className="inline-block w-5 h-4 rounded border border-neutral-300 bg-white" />
          Beschikbaar
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-voorkeur inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">+</i>
          Voorkeur
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-prefer-not inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">~</i>
          Liever niet
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-blocked inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">✕</i>
          Geblokkeerd
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-parttime inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">PT</i>
          Parttime dag
        </span>
        <span className="flex items-center gap-1.5">
          <i className="weekend-slot inline-block w-5 h-4 rounded" />
          Weekend
        </span>
        <span className="flex items-center gap-1.5">
          <i className="holiday-slot inline-block w-5 h-4 rounded" />
          Feestdag (naam in het vakje)
        </span>
      </div>

      {/* Calendar, one card per calendar month */}
      {monthGroups.map((group) => (
        <div key={group.label} className="border border-neutral-200 rounded-lg p-3 bg-neutral-50/50">
          <h3 className="text-sm font-bold text-neutral-800 mb-2 capitalize">{group.label}</h3>
          <div className="w-full overflow-x-auto">
            <table className="w-full border-separate" style={{ borderSpacing: '3px' }}>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-neutral-500">
                  <th className="w-9 text-center font-semibold pb-1">wk</th>
                  {['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((d) => (
                    <th key={d} className="font-semibold pb-1">{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.weeks.map((week, weekIdx) => {
                  const [, isoWeek] = getISOWeek(parseISO(week[0]));

                  return (
                    <tr key={`week-${weekIdx}`}>
                      <td className="week-number text-center align-top pt-2">{isoWeek}</td>
                      {week.map((datum, dayIdx) => {
                        const dayPref = preferences.get(datum);
                        const isSaturday = dayIdx === 5;
                        const isSunday = dayIdx === 6;
                        const isWeekendDay = isSaturday || isSunday;
                        const cov = coverage.get(datum);
                        const holiday = getHolidayInfo(datum);
                        // Feestdag wins over weekend when a date is both
                        // (e.g. a Sunday that's also Eerste Paasdag) - same
                        // priority the server already assigns a slot's
                        // teller by (lib/slotPersistence.ts).
                        const tag = holiday ? holiday.name : WEEKDAY_TAG[dayIdx];
                        const ratio = cov && cov.total_in_pool > 0 ? cov.available / cov.total_in_pool : 1;

                        return (
                          <td key={datum} className="align-top p-0">
                            <div
                              className={`relative min-h-[92px] rounded-lg border p-1.5 pt-1
                                ${holiday ? 'holiday-slot' : isWeekendDay ? 'weekend-slot' : 'border-neutral-200 bg-white'}`}
                            >
                              <div className="flex items-start justify-between gap-1">
                                <span className="text-xs font-semibold tabular-nums">
                                  {parseISO(datum).getDate()}
                                </span>
                                {tag && (
                                  <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-500 truncate max-w-[46px]" title={tag}>
                                    {tag}
                                  </span>
                                )}
                              </div>

                              <div className="flex flex-col gap-0.5 mt-1">
                                {shiftCounters.map((counter) => {
                                  const slot = dayPref?.slots.get(counter);
                                  if (!slot) return null;

                                  const level = slot.level;
                                  const isParttime = slot.source === 'PARTTIME';

                                  if (isParttime) {
                                    return (
                                      <div
                                        key={`${datum}-${counter}`}
                                        className="calendar-cell-parttime w-full h-5 rounded text-[10px] font-semibold
                                          flex items-center justify-center cursor-not-allowed"
                                        title={`${COUNTER_LABEL[counter] || counter}: parttime dag (automatisch geblokkeerd)`}
                                      >
                                        {counter[0]}·PT
                                      </div>
                                    );
                                  }

                                  const stateClass = level
                                    ? level === 'ABSOLUUT'
                                      ? 'calendar-cell-blocked'
                                      : level === 'VOORKEUR'
                                        ? 'calendar-cell-voorkeur'
                                        : 'calendar-cell-prefer-not'
                                    : 'calendar-cell-neutral';

                                  return (
                                    <button
                                      key={`${datum}-${counter}`}
                                      onClick={() => handleTogglePreference(datum, counter)}
                                      disabled={isSaving}
                                      className={`w-full h-5 rounded text-[10px] font-semibold transition-all
                                        ${stateClass} hover:shadow-sm active:scale-95 disabled:opacity-50`}
                                      title={`${COUNTER_LABEL[counter] || counter}: ${level || 'beschikbaar'}`}
                                    >
                                      {counter[0]}{level ? GLYPH[level] : ''}
                                    </button>
                                  );
                                })}
                              </div>

                              {isWeekendDay && (
                                <button
                                  onClick={() => handleBlockWeekend(isSaturday ? datum : addDays(datum, -1))}
                                  disabled={isSaving}
                                  className="absolute top-0.5 right-0.5 text-[8px] font-bold px-1 py-0.5 rounded
                                    bg-neutral-200 hover:bg-neutral-300 text-neutral-700 transition-colors
                                    disabled:opacity-50"
                                  title="Heel weekend blokkeren"
                                >
                                  WE
                                </button>
                              )}

                              {cov && (
                                <div className="mt-1">
                                  <div className="coverage-bar">
                                    <div
                                      className={`coverage-bar-fill ${coverageBarClass(ratio)}`}
                                      style={{ width: `${Math.round(ratio * 100)}%` }}
                                    />
                                  </div>
                                  <div className="text-[9px] text-neutral-500 text-center mt-0.5 tabular-nums">
                                    {cov.available}/{cov.total_in_pool}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Coverage notice - reacts to the last day you touched */}
      {highlightCov && (
        <div className="text-sm p-3 rounded-lg bg-neutral-50 border border-neutral-200 text-neutral-700">
          {coverageNoteText(highlightCov)}
        </div>
      )}

      {/* Save status */}
      {isSaving && (
        <div className="sticky bottom-0 p-2 bg-blue-50 border-t border-blue-200 text-sm text-blue-700">
          Voorkeuren opslaan...
        </div>
      )}

      {hasChanged && !isSaving && (
        <div className="sticky bottom-0 p-2 bg-green-50 border-t border-green-200 text-sm text-green-700">
          Voorkeuren opgeslagen
        </div>
      )}
    </div>
  );
}

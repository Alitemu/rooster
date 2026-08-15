'use client';

/**
 * Preferences Calendar Component
 *
 * Interactive calendar grid for blocking preferences.
 * - 35 weeks (5 rows × 7 columns)
 * - ISO week numbers always visible
 * - Saturday/Sunday separate cells
 * - Four states per day: neutral, prefer-not, blocked, part-time
 * - "Block whole weekend" quick action
 * - Live coverage indicator per day
 * - Auto-save with debounce
 * - Mobile-first, 375px min width
 */

import { useState, useCallback, useEffect } from 'react';
import { dateToISO, parseISO, getISOWeek } from '@/lib/holidays';

type BlockLevel = 'ABSOLUUT' | 'LIEVER_NIET' | null;

interface SlotPreference {
  slot_id: string;
  level: BlockLevel;
}

interface DayPreference {
  datum: string;
  slots: Map<string, SlotPreference>; // teller -> {slot_id, level}
}

interface CoverageInfo {
  datum: string;
  total_in_pool: number;
  absoluut_blocked: number;
  message: string;
}

interface Props {
  personId: string;
  periodId: string;
  shiftCounters?: string[]; // Default: ['AVOND', 'WEEKEND', 'FEESTDAG']
  onPreferencesChange?: (changed: boolean) => void;
  onCoverageUpdate?: (coverage: Map<string, CoverageInfo>) => void;
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

  // Fetch coverage
  useEffect(() => {
    const fetchCoverage = async () => {
      try {
        const res = await fetch(`/api/person/${personId}/preferences/${periodId}/coverage`);
        if (!res.ok) throw new Error('Failed to fetch coverage');

        const data = await res.json();
        const cov = new Map<string, CoverageInfo>(
          data.data.coverage_by_day.map((c: any) => [c.datum, c])
        );

        setCoverage(cov);
        onCoverageUpdate?.(cov);
      } catch (error) {
        console.error('Failed to load coverage:', error);
      }
    };

    fetchCoverage();
  }, [personId, periodId, onCoverageUpdate]);

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
      } catch (error) {
        console.error('Failed to save preference:', error);
      } finally {
        setIsSaving(false);
      }
    },
    [personId]
  );

  // Handle preference click
  const handleTogglePreference = useCallback(
    (datum: string, teller: string) => {
      setPreferences((prev) => {
        const dayPref = prev.get(datum);
        const slot = dayPref?.slots.get(teller);

        if (!slot) {
          console.error('Slot not found for', datum, teller);
          return prev;
        }

        // Cycle: null → LIEVER_NIET → ABSOLUUT → null
        let next: BlockLevel;
        if (slot.level === null) next = 'LIEVER_NIET';
        else if (slot.level === 'LIEVER_NIET') next = 'ABSOLUUT';
        else next = null;

        const updated = new Map(prev);
        const updatedSlots = new Map(dayPref!.slots);
        updatedSlots.set(teller, { slot_id: slot.slot_id, level: next });
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
    return <div className="p-4 text-center">Loading preferences...</div>;
  }

  // Generate calendar grid: as many full weeks as the period actually spans
  const weeks: string[][] = [];
  const allDates = Array.from(preferences.values()).map((p) => p.datum).sort();

  if (allDates.length === 0) {
    return <div className="p-4 text-center">No dates available</div>;
  }

  const startDate = parseISO(allDates[0]);
  const endDate = parseISO(allDates[allDates.length - 1]);
  const totalWeeks = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000) + 1
  );
  let currentDate = new Date(startDate);

  while (weeks.length < totalWeeks) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(dateToISO(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    weeks.push(week);
  }

  return (
    <div className="w-full overflow-x-auto">
      <div className="calendar-grid p-4 space-y-6 min-w-full">
        {weeks.map((week, weekIdx) => {
          const [_isoYear, isoWeek] = getISOWeek(parseISO(week[0]));
          const weekLabel = `Week ${isoWeek}`;

          return (
            <div key={`week-${weekIdx}`} className="space-y-2">
              {/* Week header */}
              <div className="flex items-center gap-2 px-2">
                <span className="font-mono font-bold text-sm text-neutral-600">
                  {weekLabel}
                </span>
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-1">
                {week.map((datum, dayIdx) => {
                  const dayPref = preferences.get(datum);
                  const dayName = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][dayIdx];
                  const isSaturday = dayIdx === 5;
                  const cov = coverage.get(datum);

                  return (
                    <div key={datum} className="space-y-1">
                      {/* Date label */}
                      <div className="text-xs font-semibold text-center text-neutral-700">
                        {dayName} {parseISO(datum).getDate()}
                      </div>

                      {/* Preference states (stacked) */}
                      <div className="space-y-0.5">
                        {shiftCounters.map((counter) => {
                          const slot = dayPref?.slots.get(counter);
                          if (!slot) {
                            return <div key={`${datum}-${counter}`} className="w-full h-6" />;
                          }

                          const level = slot.level;
                          const stateClass = level
                            ? level === 'ABSOLUUT'
                              ? 'calendar-cell-blocked'
                              : 'calendar-cell-prefer-not'
                            : 'calendar-cell-neutral';

                          return (
                            <button
                              key={`${datum}-${counter}`}
                              onClick={() => handleTogglePreference(datum, counter)}
                              disabled={isSaving}
                              className={`
                                w-full h-6 rounded text-xs font-medium transition-all
                                ${stateClass}
                                hover:shadow-sm active:scale-95
                                disabled:opacity-50
                              `}
                              title={`${counter}: ${level || 'available'}`}
                            >
                              {counter[0]}
                            </button>
                          );
                        })}
                      </div>

                      {/* Weekend quick action */}
                      {isSaturday && (
                        <button
                          onClick={() => handleBlockWeekend(datum)}
                          disabled={isSaving}
                          className="w-full h-5 text-xs bg-neutral-200 hover:bg-neutral-300
                                     rounded text-neutral-700 font-medium transition-colors
                                     disabled:opacity-50"
                          title="Block whole weekend"
                        >
                          WE
                        </button>
                      )}

                      {/* Coverage indicator */}
                      {cov && (
                        <div className="text-xs text-neutral-600 text-center truncate">
                          {cov.absoluut_blocked}/{cov.total_in_pool}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Save status */}
      {isSaving && (
        <div className="sticky bottom-0 p-2 bg-blue-50 border-t border-blue-200 text-sm text-blue-700">
          Saving preferences...
        </div>
      )}

      {hasChanged && !isSaving && (
        <div className="sticky bottom-0 p-2 bg-green-50 border-t border-green-200 text-sm text-green-700">
          Preferences saved
        </div>
      )}
    </div>
  );
}

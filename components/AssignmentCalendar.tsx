'use client';

/**
 * Assignment Calendar Component
 *
 * Read-only calendar view of a period's generated roster - the same
 * month-card/week-grid layout as PreferencesCalendar, but each day shows
 * who is on duty (per shift type) instead of a participant's own
 * preferences. Purely a display of the alternative to AssignmentGrid's
 * table view; editing (reassign/remove) stays in that table.
 */

import { useEffect, useState } from 'react';
import { parseISO, getHolidayInfo } from '@/lib/holidays';
import { buildMonthGroups } from '@/lib/calendarMonths';

interface Assignment {
  codenaam: string;
  datum: string;
  teller: string; // AVOND | WEEKEND | FEESTDAG
}

interface Props {
  periodId: string;
}

const WEEKDAY_TAG = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']; // index 0-6 = Monday..Sunday
const SHIFT_COUNTERS = ['AVOND', 'WEEKEND', 'FEESTDAG'];

const COUNTER_LABEL: Record<string, string> = {
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdagdienst',
};

// One fixed letter per counter, same convention as PreferencesCalendar's
// button glyphs, so the two calendars read consistently.
const COUNTER_TAG: Record<string, string> = {
  AVOND: 'A',
  WEEKEND: 'W',
  FEESTDAG: 'F',
};

export function AssignmentCalendar({ periodId }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodRange, setPeriodRange] = useState<{ start: string; end: string } | null>(null);
  // datum -> teller -> codenamen op die dag/dienst (meestal 1, maar een
  // slot kan meerdere mensen nodig hebben)
  const [byDay, setByDay] = useState<Map<string, Map<string, string[]>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`/api/periods/${periodId}`).then((res) => res.json()),
      // page_size well above any realistic period's total slot count - the
      // calendar needs every assignment in one shot, not a paginated slice.
      fetch(`/api/planner/period/${periodId}/assignments?page_size=5000`).then((res) => res.json()),
    ])
      .then(([periodData, assignmentsData]) => {
        if (cancelled) return;

        const start = periodData?.data?.start_datum;
        const end = periodData?.data?.eind_datum;
        if (!start || !end) {
          setError('Periodegegevens konden niet geladen worden');
          return;
        }
        setPeriodRange({ start, end });

        const map = new Map<string, Map<string, string[]>>();
        for (const a of (assignmentsData?.data?.assignments || []) as Assignment[]) {
          if (!map.has(a.datum)) map.set(a.datum, new Map());
          const dayMap = map.get(a.datum)!;
          if (!dayMap.has(a.teller)) dayMap.set(a.teller, []);
          dayMap.get(a.teller)!.push(a.codenaam);
        }
        setByDay(map);
      })
      .catch(() => {
        if (!cancelled) setError('Laden van rooster mislukt');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [periodId]);

  if (loading) {
    return <div className="p-4 text-center text-neutral-600">Rooster laden...</div>;
  }

  if (error) {
    return <div className="p-4 text-center text-red-600">{error}</div>;
  }

  if (!periodRange) {
    return <div className="p-4 text-center text-neutral-500">Geen periode gevonden</div>;
  }

  const monthGroups = buildMonthGroups(parseISO(periodRange.start), parseISO(periodRange.end));

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-neutral-600">
        {SHIFT_COUNTERS.map((counter) => (
          <span key={counter} className="flex items-center gap-1.5">
            <i className="inline-flex items-center justify-center w-5 h-4 rounded border border-neutral-300 bg-white text-[9px] font-bold">
              {COUNTER_TAG[counter]}
            </i>
            {COUNTER_LABEL[counter]}
          </span>
        ))}
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
            <table className="w-full table-fixed border-separate" style={{ borderSpacing: '3px' }}>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-neutral-500">
                  <th className="w-9 text-center font-semibold pb-1">wk</th>
                  {WEEKDAY_TAG.map((d) => (
                    <th key={d} className="font-semibold pb-1">{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.weeks.map((week, weekIdx) => (
                  <tr key={`week-${weekIdx}`}>
                    <td className="week-number text-center align-top pt-2">{week.isoWeek}</td>
                    {week.days.map((datum, dayIdx) => {
                      if (datum === null) {
                        return <td key={`blank-${weekIdx}-${dayIdx}`} className="p-0" />;
                      }

                      const isWeekendDay = dayIdx === 5 || dayIdx === 6;
                      const holiday = getHolidayInfo(datum);
                      const tag = holiday ? holiday.name : WEEKDAY_TAG[dayIdx];
                      const dayAssignments = byDay.get(datum);

                      return (
                        <td key={datum} className="align-top p-0">
                          <div
                            className={`relative min-h-[92px] rounded-lg border p-1.5 pt-1
                              ${holiday ? 'holiday-slot' : isWeekendDay ? 'weekend-slot' : 'border-neutral-200 bg-white'}`}
                          >
                            <div className="flex flex-col items-start gap-0.5">
                              <span className="text-xs font-semibold tabular-nums">
                                {parseISO(datum).getDate()}
                              </span>
                              {tag && (
                                <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-500 truncate w-full text-left" title={tag}>
                                  {tag}
                                </span>
                              )}
                            </div>

                            <div className="flex flex-col gap-0.5 mt-1">
                              {SHIFT_COUNTERS.map((counter) => {
                                const names = dayAssignments?.get(counter);
                                if (!names || names.length === 0) return null;

                                return (
                                  <div
                                    key={`${datum}-${counter}`}
                                    className="w-full rounded bg-blue-50 border border-blue-100 px-1 py-0.5"
                                    title={`${COUNTER_LABEL[counter] || counter}: ${names.join(', ')}`}
                                  >
                                    <span className="text-[8px] font-bold uppercase text-blue-600">
                                      {COUNTER_TAG[counter]}
                                    </span>
                                    <div className="text-[10px] font-semibold text-neutral-900 leading-tight">
                                      {names.map((name, i) => (
                                        <div key={i} className="truncate">{name}</div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

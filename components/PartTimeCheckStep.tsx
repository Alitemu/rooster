'use client';

/**
 * Part-time Verification Step Component
 *
 * Shows the period as a month-by-month calendar with generated part-time
 * days clearly hatched, so a mismatch (wrong weekday, wrong week parity
 * around the year boundary) is visible at a glance rather than requiring
 * the participant to scan a flat list of dates. Requires checkbox
 * confirmation before preferences can be submitted.
 *
 * Deliberately just shows what the pattern generated - not why a day the
 * pattern would otherwise touch didn't end up blocked (a prior manual
 * block, an absence, ...). That's real information but it lives one level
 * too deep for this screen's job, which is purely "does this match what I
 * expect to see" at a glance.
 */

import { useState, useEffect } from 'react';
import { dateToISO, parseISO, getISOWeek } from '@/lib/holidays';

interface ParttimePattern {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface GeneratedDay {
  datum: string;
  weekdag: string;
  pattern_id: string;
  is_year_boundary: boolean;
}

interface Props {
  personId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  patterns: ParttimePattern[];
  onConfirm?: (confirmed: boolean) => void;
}

export function PartTimeCheckStep({ personId, periodId, periodStart, periodEnd, patterns, onConfirm }: Props) {
  const [generatedDays, setGeneratedDays] = useState<GeneratedDay[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadGeneratedDays = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/person/${personId}/parttime-patterns/generated-days?period_id=${periodId}`
        );
        const data = await res.json();
        setGeneratedDays(data.data?.generated_days || []);
      } catch {
        setGeneratedDays([]);
      } finally {
        setLoading(false);
      }
    };

    loadGeneratedDays();
  }, [personId, periodId, patterns]);

  useEffect(() => {
    onConfirm?.(confirmed);
  }, [confirmed, onConfirm]);

  if (loading) {
    return <div className="p-4 text-center">Deeltijddagen genereren...</div>;
  }

  const byDate = new Map(generatedDays.map((d) => [d.datum, d]));
  const boundaryDays = generatedDays.filter((d) => d.is_year_boundary);

  const startDate = parseISO(periodStart);
  const endDate = parseISO(periodEnd);
  const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);

  const weeks: string[][] = [];
  let currentDate = new Date(startDate);
  while (weeks.length < totalWeeks) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(dateToISO(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    weeks.push(week);
  }

  // Same month-grouping as PreferencesCalendar - a week straddling a month
  // boundary stays with the month of its Monday.
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

  return (
    <div className="card p-6 space-y-4">
      <div>
        <h3 className="font-bold text-lg mb-1">Deeltijddagen controleren</h3>
        <p className="text-sm text-neutral-600">
          De gearceerde dagen zijn automatisch geblokkeerd op basis van je deeltijdpatroon. Loop de
          maanden door en controleer of dat op de juiste weekdag staat.
        </p>
      </div>

      {generatedDays.length === 0 && (
        <p className="text-sm text-neutral-600">
          {patterns.length === 0
            ? 'Geen deeltijdpatronen ingesteld.'
            : 'Er vallen geen deeltijddagen binnen deze periode.'}
        </p>
      )}

      {boundaryDays.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 space-y-1">
          <p className="text-sm text-amber-900 font-medium">
            ⚠️ {boundaryDays.length} deeltijddag{boundaryDays.length === 1 ? '' : 'en'} val
            {boundaryDays.length === 1 ? 't' : 'len'} rond de jaarwisseling (geel omrand hieronder) -
            controleer die extra goed. Je hebt een patroon met &quot;even&quot; of &quot;oneven weken&quot;,
            en weeknummers maken daar een sprong: rond de jaarwisseling kan &quot;om de week&quot; een dag
            opleveren die je niet had verwacht.
          </p>
          <p className="text-sm text-amber-900">
            Klopt een dag hierboven niet? Pas de geldigheidsdatum (&quot;vanaf&quot;/&quot;tot en met&quot;)
            van je patroon hierboven aan zodat de jaarwisseling erbuiten valt, en maak een tweede patroon
            aan voor de rest van de periode - eventueel met de andere week gekozen, als de aansluiting
            na de jaarwisseling omgedraaid blijkt te zijn.
          </p>
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-neutral-600">
        <span className="flex items-center gap-1.5">
          <i className="inline-block w-5 h-4 rounded border border-neutral-300 bg-white" />
          Gewone dag
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-parttime inline-block w-5 h-4 rounded" />
          Deeltijddag (automatisch geblokkeerd)
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-parttime inline-block w-5 h-4 rounded ring-2 ring-amber-400" />
          Deeltijddag rond de jaarwisseling
        </span>
      </div>

      {/* Calendar, one card per calendar month */}
      <div className="space-y-4">
        {monthGroups.map((group) => (
          <div key={group.label} className="border border-neutral-200 rounded-lg p-3 bg-neutral-50/50">
            <h4 className="text-sm font-bold text-neutral-800 mb-2 capitalize">{group.label}</h4>
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
                        {week.map((datum) => {
                          const generated = byDate.get(datum);
                          return (
                            <td key={datum} className="align-top p-0">
                              <div
                                className={`h-11 rounded-lg border flex items-start justify-center pt-1 text-xs font-semibold tabular-nums
                                  ${generated
                                    ? `calendar-cell-parttime ${generated.is_year_boundary ? 'ring-2 ring-amber-400' : ''}`
                                    : 'border-neutral-200 bg-white text-neutral-900'}`}
                                title={generated ? 'Deeltijddag (automatisch geblokkeerd)' : undefined}
                              >
                                {parseISO(datum).getDate()}
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
      </div>

      {/* Confirmation checkbox */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 h-5 w-5 rounded border-neutral-300 text-blue-600
                     focus:ring-blue-500 cursor-pointer"
        />
        <span className="text-sm text-neutral-700">
          Ik heb de deeltijddagen hierboven gecontroleerd en bevestig dat ze kloppen.
          Ik begrijp dat weeknummers kunnen verschillen bij werken rond de jaarwisseling.
        </span>
      </label>

      {/* Summary */}
      <div className="text-xs text-neutral-500 italic">
        Totaal: {generatedDays.length} dagen
        {boundaryDays.length > 0 && <> • Jaarwisseling: {boundaryDays.length} dagen</>}
      </div>
    </div>
  );
}

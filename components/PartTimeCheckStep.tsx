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
 * Also marks (in grey) a day the pattern would otherwise cover but that's
 * already blocked under a different source (an imported historical
 * blockade, an absence, ...) - reconcilePatternForPeriod deliberately
 * leaves those alone rather than overwriting them. Without this, such a
 * day looked exactly like a plain, unblocked one here, which read as "my
 * pattern silently skipped this day" even though it's still fully blocked,
 * just not by this pattern.
 */

import { useState, useEffect } from 'react';
import { parseISO, dateToISO } from '@/lib/holidays';
import { buildMonthGroups } from '@/lib/calendarMonths';

interface ParttimePattern {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface AbsenceRange {
  van_datum: string;
  tot_datum: string;
}

// Every date the absence sync (lib/absenceSync.ts) actually blocks -
// inclusive of both ends, same rule matchSlotsToAbsence uses server-side -
// computed client-side so this calendar can show the full absence
// regardless of whether any given day also happens to match the pattern.
function datesInRange(vanDatum: string, totDatum: string): Set<string> {
  const dates = new Set<string>();
  const cursor = parseISO(vanDatum);
  const end = parseISO(totDatum);
  while (cursor <= end) {
    dates.add(dateToISO(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

interface GeneratedDay {
  datum: string;
  weekdag: string;
  pattern_id: string;
  is_year_boundary: boolean;
}

interface BlockedElsewhereDay {
  datum: string;
  weekdag: string;
  pattern_id: string;
  source: string;
}

interface Props {
  personId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  periodStatus?: string;
  patterns: ParttimePattern[];
  absences: AbsenceRange[];
  onConfirm?: (confirmed: boolean) => void;
}

export function PartTimeCheckStep({
  personId,
  periodId,
  periodStart,
  periodEnd,
  periodStatus,
  patterns,
  absences,
  onConfirm,
}: Props) {
  const [generatedDays, setGeneratedDays] = useState<GeneratedDay[]>([]);
  const [blockedElsewhereDays, setBlockedElsewhereDays] = useState<BlockedElsewhereDay[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const loadGeneratedDays = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(
          `/api/person/${personId}/parttime-patterns/generated-days?period_id=${periodId}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Ophalen van deeltijddagen mislukt');
        setGeneratedDays(data.data?.generated_days || []);
        setBlockedElsewhereDays(data.data?.blocked_elsewhere_days || []);
      } catch (err) {
        // A reset to empty lists here used to read as "je hebt geen
        // deeltijddagen deze periode" even though the fetch itself
        // failed - that let a participant confirm days that were never
        // actually verified. Surface the failure instead of hiding it.
        setGeneratedDays([]);
        setBlockedElsewhereDays([]);
        setLoadError(err instanceof Error ? err.message : 'Ophalen van deeltijddagen mislukt');
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
  const blockedElsewhereByDate = new Map(blockedElsewhereDays.map((d) => [d.datum, d]));
  const boundaryDays = generatedDays.filter((d) => d.is_year_boundary);
  const absenceDates = new Set<string>();
  for (const absence of absences) {
    for (const datum of datesInRange(absence.van_datum, absence.tot_datum)) {
      absenceDates.add(datum);
    }
  }
  // Only the absence days the two pattern-derived lists above don't already
  // account for - counting all of absenceDates here would double-count a
  // day that also happens to be a pattern day (already in generatedDays or
  // blockedElsewhereDays).
  const absenceOnlyCount = [...absenceDates].filter(
    (d) => !byDate.has(d) && !blockedElsewhereByDate.has(d)
  ).length;

  const startDate = parseISO(periodStart);
  const endDate = parseISO(periodEnd);
  // One true calendar month per group, same as PreferencesCalendar - a
  // month always starts on its actual 1st and ends on its actual last day,
  // never bleeding into a neighboring month's days. See lib/calendarMonths.ts.
  const monthGroups = buildMonthGroups(startDate, endDate);

  return (
    <div className="card p-6 space-y-4">
      <div>
        <h3 className="font-bold text-lg mb-1">Deeltijddagen controleren</h3>
        <p className="text-sm text-neutral-600">
          De gearceerde dagen zijn automatisch geblokkeerd op basis van je deeltijdpatroon of een
          geregistreerde afwezigheid. Loop de maanden door en controleer of dat klopt.
        </p>
      </div>

      {periodStatus === 'CONCEPT' && patterns.length > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded p-3">
          <p className="text-sm text-blue-900">
            Deze periode is nog niet geopend door de planner. De kalender hieronder toont daarom een
            voorbeeld op basis van je deeltijdpatroon - zodra de planner de periode opent, worden
            deze dagen automatisch echt geblokkeerd. Je hoeft dan niets opnieuw in te voeren.
          </p>
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-800">⚠️ {loadError} - de dagen hieronder zijn niet betrouwbaar.</p>
        </div>
      )}

      {!loadError && generatedDays.length === 0 && blockedElsewhereDays.length === 0 && absenceDates.size === 0 && (
        <p className="text-sm text-neutral-600">
          {patterns.length === 0
            ? 'Geen deeltijdpatronen of afwezigheid ingesteld.'
            : 'Er vallen geen deeltijddagen binnen deze periode.'}
        </p>
      )}

      {blockedElsewhereDays.length > 0 && (
        <div className="bg-neutral-100 border border-neutral-200 rounded p-3">
          <p className="text-sm text-neutral-700">
            {blockedElsewhereDays.length} dag{blockedElsewhereDays.length === 1 ? '' : 'en'} die je
            patroon zou raken {blockedElsewhereDays.length === 1 ? 'is' : 'zijn'} hieronder grijs
            gemarkeerd - die {blockedElsewhereDays.length === 1 ? 'is' : 'zijn'} al op een andere
            manier geblokkeerd (bijvoorbeeld een eerder ingevoerde blokkade of afwezigheid), dus je
            patroon hoeft daar niets te doen.
          </p>
        </div>
      )}

      {boundaryDays.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 space-y-1">
          <p className="text-sm text-amber-900 font-medium">
            ⚠️ {boundaryDays.length} deeltijddag{boundaryDays.length === 1 ? '' : 'en'} val
            {boundaryDays.length === 1 ? 't' : 'len'} rond de jaarwisseling (rood omrand hieronder) -
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
          <i className="calendar-cell-parttime inline-block w-5 h-4 rounded ring-2 ring-red-500" />
          Deeltijddag rond de jaarwisseling
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-absence inline-block w-5 h-4 rounded" />
          Afwezigheid
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-blocked-elsewhere inline-block w-5 h-4 rounded" />
          Al geblokkeerd om een andere reden
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
                    return (
                      <tr key={`week-${weekIdx}`}>
                        <td className="week-number text-center align-middle">{week.isoWeek}</td>
                        {week.days.map((datum, dayIdx) => {
                          if (datum === null) {
                            return <td key={`blank-${weekIdx}-${dayIdx}`} className="p-0" />;
                          }
                          const generated = byDate.get(datum);
                          const blockedElsewhere = !generated ? blockedElsewhereByDate.get(datum) : undefined;
                          const isAbsenceElsewhere = blockedElsewhere?.source === 'ABSENCE';
                          // A day the pattern doesn't touch at all (so
                          // neither of the two checks above ever see it),
                          // but that still falls within a registered
                          // absence's date range - the whole point of this
                          // fix, see the "in dezelfde kalender" request.
                          const isAbsenceOnly = !generated && !blockedElsewhere && absenceDates.has(datum);
                          const isAbsence = isAbsenceElsewhere || isAbsenceOnly;
                          return (
                            <td key={datum} className="align-top p-0">
                              <div
                                className={`h-11 rounded-lg border flex items-center justify-center text-xs font-semibold tabular-nums
                                  ${generated
                                    ? `calendar-cell-parttime ${generated.is_year_boundary ? 'ring-2 ring-red-500' : ''}`
                                    : isAbsence
                                      ? 'calendar-cell-absence'
                                      : blockedElsewhere
                                        ? 'calendar-cell-blocked-elsewhere'
                                        : 'border-neutral-200 bg-white text-neutral-900'}`}
                                title={
                                  generated
                                    ? 'Deeltijddag (automatisch geblokkeerd)'
                                    : isAbsence
                                      ? 'Deze dag valt binnen een geregistreerde afwezigheid'
                                      : blockedElsewhere
                                        ? 'Deze dag is al om een andere reden geblokkeerd - je patroon hoeft hier niets te doen'
                                        : undefined
                                }
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

      {/* Confirmation checkbox - wording depends on whether there's
          actually anything to check, so "geen deeltijdpatroon" doesn't have
          to be confirmed with a sentence about checking a calendar that's
          empty. */}
      <label className={`flex items-start gap-3 ${loadError ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!!loadError}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 h-5 w-5 rounded border-neutral-300 text-blue-600
                     focus:ring-blue-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <span className="text-sm text-neutral-700">
          {patterns.length === 0 ? (
            'Ik heb geen deeltijddagen - ik werk het volledige rooster. Ik heb mijn afwezigheid hierboven gecontroleerd en bevestig dat die klopt.'
          ) : (
            <>
              Ik heb de deeltijddagen en de afwezigheid hierboven gecontroleerd en bevestig dat ze kloppen.
              Ik begrijp dat weeknummers kunnen verschillen bij weken rond de jaarwisseling.
            </>
          )}
        </span>
      </label>

      {/* Summary */}
      <div className="text-xs text-neutral-500 italic">
        Totaal: {generatedDays.length} deeltijddagen
        {absenceOnlyCount > 0 && <> • {absenceOnlyCount} afwezigheidsdagen</>}
        {boundaryDays.length > 0 && <> • Jaarwisseling: {boundaryDays.length} dagen</>}
        {blockedElsewhereDays.length > 0 && <> • Al elders geblokkeerd: {blockedElsewhereDays.length} dagen</>}
      </div>
    </div>
  );
}

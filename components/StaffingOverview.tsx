'use client';

/**
 * Staffing Overview ("Dienstdoende") Component
 *
 * Everyone actually on duty this period, with how many AVOND/WEEKEND/
 * FEESTDAG shifts each of them has - a third way to look at the roster
 * next to the per-shift list and calendar views, answering "who's
 * scheduled, and how much of each shift type" without counting rows by
 * hand in either of those.
 */

import { useState, useEffect } from 'react';
import { FellowBadge } from './FellowBadge';
import { withBasePath } from '@/lib/basePath';

interface StaffingRow {
  person_id: string;
  codenaam: string;
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  totaal: number;
  fellow: boolean;
}

interface StaffingTotals {
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  totaal: number;
}

interface Props {
  periodId: string;
}

type Counter = 'AVOND' | 'WEEKEND' | 'FEESTDAG';

// One colour per shift type, so the three columns read apart at a glance.
// The number always stays next to the bar - colour alone must never be the
// only carrier of the information (CLAUDE.md: readable in black and white).
const BAR_COLORS: Record<Counter, string> = {
  AVOND: 'bg-blue-500',
  WEEKEND: 'bg-emerald-500',
  FEESTDAG: 'bg-violet-500',
};

/**
 * A number plus a horizontal bar. Full width is the highest count in that
 * column, every other bar is relative to it - so comparing who has more of
 * one shift type is a matter of glancing down the column.
 */
function CountBar({ value, max, counter }: { value: number; max: number; counter: Counter }) {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-right tabular-nums">{value}</span>
      <div className="flex-1 min-w-[4rem] h-2.5 rounded bg-neutral-100 overflow-hidden" aria-hidden="true">
        <div className={`h-full rounded ${BAR_COLORS[counter]}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export function StaffingOverview({ periodId }: Props) {
  const [staff, setStaff] = useState<StaffingRow[]>([]);
  const [totals, setTotals] = useState<StaffingTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(withBasePath(`/api/planner/period/${periodId}/staffing-overview`));
        if (!res.ok) throw new Error('Laden van dienstdoende-overzicht mislukt');
        const data = await res.json();
        if (cancelled) return;
        setStaff(data.data.staff);
        setTotals(data.data.totals);
      } catch {
        if (!cancelled) setError('Laden van dienstdoende-overzicht mislukt. Probeer het opnieuw.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  if (loading) {
    return <p className="text-sm text-neutral-500">Laden...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (staff.length === 0) {
    return <p className="text-sm text-neutral-500">Nog niemand ingedeeld in deze periode.</p>;
  }

  const max: Record<Counter, number> = {
    AVOND: Math.max(...staff.map((s) => s.AVOND)),
    WEEKEND: Math.max(...staff.map((s) => s.WEEKEND)),
    FEESTDAG: Math.max(...staff.map((s) => s.FEESTDAG)),
  };

  const header = (counter: Counter, label: string) => (
    <th className="px-4 py-2 font-medium min-w-[9rem]">
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block w-2.5 h-2.5 rounded-sm ${BAR_COLORS[counter]}`} aria-hidden="true" />
        {label}
      </span>
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left">
            <th className="px-4 py-2 font-medium">Codenaam</th>
            {header('AVOND', 'Avonddiensten')}
            {header('WEEKEND', 'Weekenddiensten')}
            {header('FEESTDAG', 'Feestdagdiensten')}
            <th className="px-4 py-2 font-medium text-right">Totaal</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.person_id} className="border-b border-neutral-100">
              <td className="px-4 py-2 whitespace-nowrap">
                {s.codenaam}
                {s.fellow && <FellowBadge />}
              </td>
              <td className="px-4 py-2"><CountBar value={s.AVOND} max={max.AVOND} counter="AVOND" /></td>
              <td className="px-4 py-2">
                {/* A fellow has no weekends: "n.v.t." rather than a 0 that looks like a gap. */}
                {s.fellow && s.WEEKEND === 0 ? (
                  <span className="text-neutral-500" title="Fellow: geen weekenddiensten">
                    n.v.t.
                  </span>
                ) : (
                  <CountBar value={s.WEEKEND} max={max.WEEKEND} counter="WEEKEND" />
                )}
              </td>
              <td className="px-4 py-2"><CountBar value={s.FEESTDAG} max={max.FEESTDAG} counter="FEESTDAG" /></td>
              <td className="px-4 py-2 text-right font-medium">{s.totaal}</td>
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-medium">
              <td className="px-4 py-2 whitespace-nowrap">
                Totaal ({staff.length} {staff.length === 1 ? 'persoon' : 'personen'})
              </td>
              <td className="px-4 py-2"><span className="inline-block min-w-[1.5rem] text-right tabular-nums">{totals.AVOND}</span></td>
              <td className="px-4 py-2"><span className="inline-block min-w-[1.5rem] text-right tabular-nums">{totals.WEEKEND}</span></td>
              <td className="px-4 py-2"><span className="inline-block min-w-[1.5rem] text-right tabular-nums">{totals.FEESTDAG}</span></td>
              <td className="px-4 py-2 text-right">{totals.totaal}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

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

interface StaffingRow {
  person_id: string;
  codenaam: string;
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  totaal: number;
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
        const res = await fetch(`/api/planner/period/${periodId}/staffing-overview`);
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

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left">
            <th className="px-4 py-2 font-medium">Codenaam</th>
            <th className="px-4 py-2 font-medium text-right">Avonddiensten</th>
            <th className="px-4 py-2 font-medium text-right">Weekenddiensten</th>
            <th className="px-4 py-2 font-medium text-right">Feestdagdiensten</th>
            <th className="px-4 py-2 font-medium text-right">Totaal</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.person_id} className="border-b border-neutral-100">
              <td className="px-4 py-2">{s.codenaam}</td>
              <td className="px-4 py-2 text-right">{s.AVOND}</td>
              <td className="px-4 py-2 text-right">{s.WEEKEND}</td>
              <td className="px-4 py-2 text-right">{s.FEESTDAG}</td>
              <td className="px-4 py-2 text-right font-medium">{s.totaal}</td>
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t-2 border-neutral-300 font-medium">
              <td className="px-4 py-2">
                Totaal ({staff.length} {staff.length === 1 ? 'persoon' : 'personen'})
              </td>
              <td className="px-4 py-2 text-right">{totals.AVOND}</td>
              <td className="px-4 py-2 text-right">{totals.WEEKEND}</td>
              <td className="px-4 py-2 text-right">{totals.FEESTDAG}</td>
              <td className="px-4 py-2 text-right">{totals.totaal}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

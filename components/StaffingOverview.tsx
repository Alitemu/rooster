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
import { bereikVak } from '@/lib/bereikVak';
import type { StreefbereikRij } from '@/lib/streefbereikPerPersoon';

interface StaffingRow {
  person_id: string;
  codenaam: string;
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  totaal: number;
  fellow: boolean;
  streefbereik: StreefbereikRij | null;
  uitkomst: Record<Counter, string> | null;
  bereik: Record<Counter, { min: number; max: number } | null> | null;
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
 * column (or the highest edge of a box), every other bar is relative to it
 * - so comparing who has more of one shift type is a matter of glancing down
 * the column. Under the bar the person's streefbereik, saldo included, in
 * brackets; for evenings and weekends also a dashed box over the bar
 * (2.3.0, lib/bereikVak.ts). Outside the range a red
 * arrow says more or fewer, so neither the colour nor the box carries it alone.
 */
function CountBar({ value, max, counter, bereik, onder }: { value: number; max: number; counter: Counter; bereik: { min: number; max: number } | null; onder?: string }) {
  const deel = (n: number) => (max > 0 ? (n / max) * 100 : 0);
  const af = !bereik ? 0 : value > bereik.max ? 1 : value < bereik.min ? -1 : 0;
  const vak = bereikVak(bereik);
  const breedte = vak ? deel(vak.tot) - deel(vak.van) : 0;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="w-6 text-right tabular-nums">{value}</span>
        <span className="w-3 text-xs leading-none text-red-600" aria-hidden="true" data-testid="bereik-pijl">
          {af > 0 ? '▲' : af < 0 ? '▼' : ''}
        </span>
        <div className="relative flex-1 min-w-[4rem] h-3 rounded bg-neutral-100" aria-hidden="true">
          <div className={`h-full rounded ${BAR_COLORS[counter]}`} style={{ width: `${deel(value)}%` }} />
          {vak && (
            <div
              className="absolute -inset-y-0.5 rounded-sm border border-dashed border-neutral-600"
              style={{ left: `${deel(vak.van)}%`, width: `${breedte}%` }}
              data-testid="bereik-vlak"
            />
          )}
        </div>
      </div>
      {onder && <div className="ml-12 mt-0.5 text-xs text-neutral-500" data-testid="bereik-onder">[{onder}]</div>}
    </div>
  );
}

const SOORTEN = [
  ['AVOND', 'Avond'],
  ['WEEKEND', 'Weekend'],
  ['FEESTDAG', 'Feestdag'],
] as const;

/**
 * The last column: per kind of dienst whether the count fits the range under its bar ("goed", in red "1 te
 * veel" or "2 tekort", once there is a roster) and how much of that range came from the saldo.
 */
function StatusCel({ s }: { s: StaffingRow }) {
  if (!s.streefbereik) return <span className="text-neutral-400">−</span>;
  return (
    <div className="text-xs leading-5 min-w-[10rem]" data-testid="streefbereik-cel">
      {SOORTEN.map(([c, label]) => {
        const status = s.uitkomst?.[c] ?? null;
        if (!status && !s.streefbereik![c].toelichting) return null;
        return (
          <div key={c}>
            <span className="whitespace-nowrap">
              {label}: {status === 'goed' && status}
              {status && status !== 'goed' && (
                <span
                  className="font-medium text-red-600"
                  data-testid="buiten-bereik"
                  title="Buiten het eigen bereik. Is het rooster gepubliceerd, dan telt dit verschil mee in de volgende periode."
                >
                  {status}
                </span>
              )}
            </span>
            {s.streefbereik![c].toelichting && <span className="block text-neutral-500">({s.streefbereik![c].toelichting})</span>}
          </div>
        );
      })}
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

  // The scale holds every bar and every box, so a box never runs off the bar; feestdag has no box.
  const schaal = (c: Counter) =>
    Math.max(...staff.map((s) => Math.max(s[c], c === 'FEESTDAG' ? 0 : (bereikVak(s.bereik?.[c] ?? null)?.tot ?? 0))));
  const max: Record<Counter, number> = { AVOND: schaal('AVOND'), WEEKEND: schaal('WEEKEND'), FEESTDAG: schaal('FEESTDAG') };

  const header = (counter: Counter, label: string) => (
    <th className="px-4 py-2 font-medium min-w-[9rem]">
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block w-2.5 h-2.5 rounded-sm ${BAR_COLORS[counter]}`} aria-hidden="true" />
        {label}
      </span>
    </th>
  );

  return (
    <div className="space-y-2">
      <p className="text-sm text-neutral-600" data-testid="dienstdoende-uitleg">
        De breedte van de balk wordt bepaald door de hoogste waarde in die kolom. Onder elke balk staat het
        [streefbereik] van die persoon, inclusief de correctie uit het saldo. Bij avond- en weekenddiensten is dit
        streefbereik grafisch weergegeven door het gestippelde vak.
        <br />
        <span className="text-red-600">▲</span> is meer dan het bereik en <span className="text-red-600">▼</span> is
        minder.
      </p>
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left">
            <th className="px-4 py-2 font-medium">Codenaam</th>
            {header('AVOND', 'Avonddiensten')}
            {header('WEEKEND', 'Weekenddiensten')}
            {header('FEESTDAG', 'Feestdagdiensten')}
            <th className="px-4 py-2 font-medium text-right">Totaal</th>
            <th className="px-4 py-2 font-medium">Streefbereik</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.person_id} className="border-b border-neutral-100">
              <td className="px-4 py-2 whitespace-nowrap">
                {s.codenaam}
                {s.fellow && <FellowBadge />}
              </td>
              <td className="px-4 py-2"><CountBar value={s.AVOND} max={max.AVOND} counter="AVOND" bereik={s.bereik?.AVOND ?? null} onder={s.streefbereik?.AVOND.tekst} /></td>
              <td className="px-4 py-2">
                {/* A fellow has no weekends: "n.v.t." rather than a 0 that looks like a gap. */}
                {s.fellow && s.WEEKEND === 0 ? (
                  <span className="text-neutral-500" title="Fellow: geen weekenddiensten">
                    n.v.t.
                  </span>
                ) : (
                  <CountBar value={s.WEEKEND} max={max.WEEKEND} counter="WEEKEND" bereik={s.bereik?.WEEKEND ?? null} onder={s.streefbereik?.WEEKEND.tekst} />
                )}
              </td>
              <td className="px-4 py-2"><CountBar value={s.FEESTDAG} max={max.FEESTDAG} counter="FEESTDAG" bereik={null} onder={s.streefbereik?.FEESTDAG.tekst} /></td>
              <td className="px-4 py-2 text-right font-medium">{s.totaal}</td>
              <td className="px-4 py-2 align-top">
                <StatusCel s={s} />
              </td>
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
              <td className="px-4 py-2" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
    </div>
  );
}

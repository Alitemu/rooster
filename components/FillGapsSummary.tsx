'use client';

/**
 * Fill Gaps Summary
 *
 * The content behind PlannerDashboard's "Rooster vooraf invullen" section -
 * a freshly opened period has every one of its slots unfilled (the solver
 * hasn't run yet), so showing the full per-slot pick-someone list
 * immediately and unconditionally meant a planner opening a brand new
 * period saw a wall of a hundred-plus rows before anything else on the
 * page. This shows just the count and links to a dedicated page
 * (/planner/period/[id]/fill-gaps) with the full list, so reviewing gaps
 * is something a planner navigates to on purpose rather than something
 * dropped in front of them by default.
 *
 * Renders as bare content (no card of its own) - the caller wraps this in
 * a collapsible Section that already supplies the title, and reads
 * onCountChange to build that section's always-visible hint text.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';

interface Props {
  periodId: string;
  onCountChange?: (count: number) => void;
  /**
   * Bumped by the parent after anything that can open or close a gap.
   * A refetch in place, not a remount (it used to be the element's `key`):
   * a remount flashed "Laden..." for a moment, and because this box sits
   * above the roster, that brief change in height made the whole page
   * jump right after every assignment.
   */
  refreshKey?: number;
}

export function FillGapsSummary({ periodId, onCountChange, refreshKey }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/unfilled-slots/count`));
      const data = await res.json();
      if (!res.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Laden van openstaande diensten mislukt');
      setLoadError(null);
      setCount(data.data.count);
      onCountChange?.(data.data.count);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Laden van openstaande diensten mislukt');
    }
    // onCountChange is PlannerDashboard's stable setState setter (see
    // RebalanceSuggestions' identical reasoning for its own onCountChange).
  }, [periodId, onCountChange]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (loadError) {
    return (
      <div className="p-3 rounded bg-red-50 border border-red-200 flex items-center justify-between gap-3">
        <p className="text-sm text-red-800">⚠️ {loadError}</p>
        <button
          onClick={() => load()}
          className="shrink-0 px-3 py-1.5 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700"
        >
          Opnieuw proberen
        </button>
      </div>
    );
  }

  if (count === null) {
    return <p className="text-sm text-neutral-600">Laden...</p>;
  }

  if (count === 0) {
    return (
      <div className="p-3 rounded bg-green-50 border border-green-200">
        <p className="text-sm text-green-900 font-medium">
          ✓ Elke dienst in dit rooster is ingevuld.
        </p>
      </div>
    );
  }

  return (
    <div className="p-3 rounded bg-amber-50 border border-amber-200 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <p className="text-sm font-semibold text-amber-900">
          ⚠️ {count} dienst{count === 1 ? '' : 'en'} nog niet ingevuld
        </p>
        <p className="text-xs text-amber-800 mt-0.5">
          Vul deze rustig in, per dienst, wanneer het jou uitkomt.
        </p>
      </div>
      <Link
        href={`/planner/period/${periodId}/fill-gaps`}
        className="shrink-0 px-4 py-2 rounded font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
      >
        📝 Rooster vooraf invullen
      </Link>
    </div>
  );
}

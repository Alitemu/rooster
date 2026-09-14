'use client';

/**
 * Fill Gaps Summary
 *
 * Compact stand-in for the full FillGapsPanel on the period dashboard - a
 * freshly opened period has every one of its slots unfilled (the solver
 * hasn't run yet), so showing the full per-slot pick-someone list
 * immediately and unconditionally meant a planner opening a brand new
 * period saw a wall of a hundred-plus rows before anything else on the
 * page. This shows just the count and links to a dedicated page
 * (/planner/period/[id]/fill-gaps) with the full list, so reviewing gaps
 * is something a planner navigates to on purpose rather than something
 * dropped in front of them by default.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

interface Props {
  periodId: string;
}

export function FillGapsSummary({ periodId }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/planner/period/${periodId}/unfilled-slots/count`);
      const data = await res.json();
      if (!res.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Laden van openstaande diensten mislukt');
      setLoadError(null);
      setCount(data.data.count);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Laden van openstaande diensten mislukt');
    }
  }, [periodId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loadError) {
    return (
      <div className="card p-4 bg-red-50 border border-red-200 flex items-center justify-between gap-3">
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
    return null;
  }

  if (count === 0) {
    return (
      <div className="card p-4 bg-green-50 border border-green-200">
        <p className="text-sm text-green-900 font-medium">
          ✓ Elke dienst in dit rooster is ingevuld.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-4 bg-amber-50 border border-amber-200 flex items-center justify-between gap-3 flex-wrap">
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

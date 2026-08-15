'use client';

/**
 * Week Coverage Chart
 *
 * Per ISO week: how many pool members are still coverable, with a
 * red/orange/green status. Polls periodically since staff preferences
 * change this live as they get submitted.
 */

import { useState, useEffect } from 'react';

interface WeekCoverageEntry {
  iso_jaar: number;
  iso_week: number;
  pool_size: number;
  available_count: number;
  status: 'red' | 'orange' | 'green';
}

interface Props {
  periodId: string;
}

const STATUS_STYLES: Record<WeekCoverageEntry['status'], string> = {
  red: 'bg-red-100 text-red-800',
  orange: 'bg-amber-100 text-amber-800',
  green: 'bg-green-100 text-green-800',
};

const POLL_INTERVAL_MS = 30000;

export function WeekCoverageChart({ periodId }: Props) {
  const [weeks, setWeeks] = useState<WeekCoverageEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/planner/period/${periodId}/coverage-by-week`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setWeeks(data.data.weeks);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [periodId]);

  if (loading) {
    return <div className="card p-6 text-center text-neutral-600">Loading week coverage...</div>;
  }

  if (weeks.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-2">Week Coverage</h3>
        <p className="text-neutral-600">No slots generated yet for this period</p>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h3 className="font-bold text-lg mb-1">Week Coverage</h3>
      <p className="text-sm text-neutral-600 mb-4">
        How many staff are still available per week, based on submitted preferences
      </p>
      <div className="space-y-1">
        {weeks.map((week) => (
          <div key={`${week.iso_jaar}-${week.iso_week}`} className="flex items-center gap-3">
            <span className="text-sm text-neutral-600 w-24 shrink-0">
              {week.iso_jaar} W{String(week.iso_week).padStart(2, '0')}
            </span>
            <div className="flex-1 bg-neutral-100 rounded-full h-4 overflow-hidden">
              <div
                className={`h-4 rounded-full ${STATUS_STYLES[week.status].split(' ')[0]}`}
                style={{ width: `${Math.min(100, (week.available_count / week.pool_size) * 100)}%` }}
              />
            </div>
            <span
              className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium w-24 text-center shrink-0 ${STATUS_STYLES[week.status]}`}
            >
              {week.available_count} of {week.pool_size}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

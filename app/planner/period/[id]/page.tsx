/**
 * Planner Period Dashboard Page
 *
 * Shows period progress, staff status, and controls
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { PlannerDashboard } from '@/components/PlannerDashboard';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  gepubliceerd_op?: string | null;
}

export default function PlannerPeriodPage() {
  const params = useParams();
  const periodId = params.id as string;

  const [period, setPeriod] = useState<Period | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPeriod = async () => {
      try {
        const res = await fetch(`/api/periods/${periodId}`);
        if (!res.ok) throw new Error('Failed to load period');

        const data = await res.json();
        setPeriod(data.data);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load period');
        setLoading(false);
      }
    };

    loadPeriod();
  }, [periodId]);

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center">
          <p className="text-lg text-neutral-600">Loading period...</p>
        </div>
      </div>
    );
  }

  if (error || !period) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 bg-red-50 border border-red-200">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Error</h1>
          <p className="text-neutral-700">{error || 'Period not found'}</p>
        </div>
      </div>
    );
  }

  const statusColors: Record<string, { bg: string; text: string }> = {
    CONCEPT: { bg: 'bg-neutral-100', text: 'text-neutral-800' },
    OPEN: { bg: 'bg-blue-100', text: 'text-blue-800' },
    GESLOTEN: { bg: 'bg-amber-100', text: 'text-amber-800' },
    GEGENEREERD: { bg: 'bg-green-100', text: 'text-green-800' },
    GEPUBLICEERD: { bg: 'bg-emerald-100', text: 'text-emerald-800' },
  };

  const statusColor = statusColors[period.status] || statusColors.CONCEPT;

  return (
    <div className="container-main py-8 space-y-6">
      {/* Header */}
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-neutral-900 mb-2">{period.naam}</h1>
            <p className="text-neutral-600 mb-2">
              {new Date(period.start_datum).toLocaleDateString()} to{' '}
              {new Date(period.eind_datum).toLocaleDateString()}
            </p>
            <p className="text-sm text-neutral-600">
              Deadline: {new Date(period.deadline).toLocaleString()}
            </p>
          </div>
          <div>
            <div className={`px-4 py-2 rounded font-semibold ${statusColor.bg} ${statusColor.text}`}>
              {period.status === 'CONCEPT' && '⚙️ Concept'}
              {period.status === 'OPEN' && '📖 Open'}
              {period.status === 'GESLOTEN' && '🔒 Closed'}
              {period.status === 'GEGENEREERD' && '🤖 Generated'}
              {period.status === 'GEPUBLICEERD' && (
                <>
                  ✅ Published
                  {period.gepubliceerd_op && (
                    <span className="ml-2 font-normal text-sm">
                      · Published on {new Date(period.gepubliceerd_op).toLocaleString()}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Period Actions */}
      {period.status === 'CONCEPT' && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-900">
            Period is still in concept. Visit{' '}
            <a href={`/planner/setup/${periodId}`} className="font-medium underline">
              setup wizard
            </a>{' '}
            to configure and open it.
          </p>
        </div>
      )}

      {period.status === 'OPEN' && (
        <div className="flex gap-3">
          <button className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors">
            📧 Send Deadline Reminder
          </button>
          <button className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors">
            🔒 Close Period
          </button>
        </div>
      )}

      {/* Dashboard */}
      <PlannerDashboard periodId={periodId} />
    </div>
  );
}

'use client';

/**
 * Planner Dashboard Component
 *
 * Shows:
 * - Submission progress per staff member
 * - Live week coverage
 * - Large imbalances
 * - Part-time patterns status
 * - Submit on behalf button
 * - Export/reminder options
 */

import { useState, useEffect } from 'react';

interface PersonProgress {
  person_id: string;
  codenaam: string;
  submission_status: string | null;
  submitted_at: string | null;
  has_parttime_patterns: boolean;
  blocked_days_count: number;
  has_absences: boolean;
}

interface ImbalanceItem {
  person_id: string;
  codenaam: string;
  counter: string;
  delta: number;
  from_period: string;
}

interface DashboardData {
  period_id: string;
  period_name: string;
  status: string;
  submission_stats: {
    not_started: number;
    in_progress: number;
    confirmed: number;
  };
  large_imbalances: ImbalanceItem[];
  total_staff: number;
  staff_with_parttime: number;
}

interface Props {
  periodId: string;
}

export function PlannerDashboard({ periodId }: Props) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [progress, setProgress] = useState<PersonProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submittingFor, setSubmittingFor] = useState<string | null>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [dashRes, progRes] = await Promise.all([
          fetch(`/api/planner/period/${periodId}/dashboard`),
          fetch(`/api/planner/period/${periodId}/progress`),
        ]);

        if (!dashRes.ok || !progRes.ok) throw new Error('Failed to load dashboard');

        const dashData = await dashRes.json();
        const progData = await progRes.json();

        setDashboard(dashData.data);
        setProgress(progData.data);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        setLoading(false);
      }
    };

    loadData();
  }, [periodId]);

  const handleSubmitOnBehalf = async (personId: string) => {
    setSubmittingFor(personId);
    try {
      const res = await fetch(`/api/planner/person/${personId}/submit-on-behalf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: periodId,
          submitted_by_person_id: 'current-user', // TODO: Get from auth context
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to submit');
      }

      // Reload progress
      const progRes = await fetch(`/api/planner/period/${periodId}/progress`);
      const progData = await progRes.json();
      setProgress(progData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit');
    } finally {
      setSubmittingFor(null);
    }
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Loading dashboard...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-8 bg-red-50 border border-red-200">
        <p className="text-red-700">{error}</p>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="card p-8">
        <p className="text-neutral-600">No dashboard data available</p>
      </div>
    );
  }

  const stats = dashboard.submission_stats;
  const totalSubmissions = stats.not_started + stats.in_progress + stats.confirmed;
  const submissionProgress =
    totalSubmissions > 0 ? Math.round((stats.confirmed / totalSubmissions) * 100) : 0;

  const counterDisplayName: Record<string, string> = {
    AVOND: 'Evening',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Holiday',
  };

  return (
    <div className="space-y-6">
      {/* Submission Progress Summary */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Submission Progress</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center">
            <div className="text-3xl font-bold text-blue-600">{stats.not_started}</div>
            <div className="text-sm text-neutral-600">Not started</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-amber-600">{stats.in_progress}</div>
            <div className="text-sm text-neutral-600">In progress</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-green-600">{stats.confirmed}</div>
            <div className="text-sm text-neutral-600">Confirmed</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-neutral-200 rounded-full h-2 mb-2">
          <div
            className="bg-green-600 h-2 rounded-full transition-all"
            style={{ width: `${submissionProgress}%` }}
          />
        </div>
        <p className="text-sm text-neutral-600 text-center">
          {submissionProgress}% confirmed ({stats.confirmed} of {totalSubmissions})
        </p>
      </div>

      {/* Large Imbalances */}
      {dashboard.large_imbalances.length > 0 && (
        <div className="card p-6 bg-amber-50 border border-amber-200">
          <h3 className="font-bold text-lg mb-3">⚠️ Large Imbalances (≥2 shift difference)</h3>
          <div className="space-y-2">
            {dashboard.large_imbalances.slice(0, 8).map((item) => (
              <div key={`${item.person_id}-${item.counter}`} className="flex justify-between text-sm">
                <span className="font-medium">{item.codenaam}</span>
                <span className="text-amber-800">
                  {item.delta > 0 ? '+' : ''}{item.delta} {counterDisplayName[item.counter]}
                </span>
              </div>
            ))}
            {dashboard.large_imbalances.length > 8 && (
              <p className="text-xs text-amber-700 pt-2">
                ... and {dashboard.large_imbalances.length - 8} more imbalances
              </p>
            )}
          </div>
        </div>
      )}

      {/* Pool Info */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-4">
          <p className="text-sm text-neutral-600">Total staff</p>
          <p className="text-2xl font-bold text-neutral-900">{dashboard.total_staff}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-neutral-600">With part-time patterns</p>
          <p className="text-2xl font-bold text-neutral-900">{dashboard.staff_with_parttime}</p>
        </div>
      </div>

      {/* Staff Status Table */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Staff Status</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Name</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-center font-semibold">Blocked Days</th>
                <th className="px-3 py-2 text-center font-semibold">Part-time</th>
                <th className="px-3 py-2 text-center font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {progress.map((person) => (
                <tr key={person.person_id} className="hover:bg-neutral-50">
                  <td className="px-3 py-2 font-medium">{person.codenaam}</td>
                  <td className="px-3 py-2">
                    {!person.submission_status ? (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-red-100 text-red-800">
                        Not started
                      </span>
                    ) : person.submission_status === 'BEZIG' ? (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-amber-100 text-amber-800">
                        In progress
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-green-100 text-green-800">
                        ✓ Confirmed
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">{person.blocked_days_count}</td>
                  <td className="px-3 py-2 text-center">
                    {person.has_parttime_patterns ? (
                      <span className="text-green-600 font-bold">✓</span>
                    ) : (
                      <span className="text-neutral-400">−</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {!person.submission_status && (
                      <button
                        onClick={() => handleSubmitOnBehalf(person.person_id)}
                        disabled={submittingFor === person.person_id}
                        className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
                      >
                        {submittingFor === person.person_id ? 'Submitting...' : 'Submit'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Export & Reminders */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Export & Communications</h3>
        <div className="flex gap-3 flex-wrap">
          <button className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors">
            📧 Send Reminders
          </button>
          <button className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors">
            📊 Export Invitations
          </button>
          <button className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors">
            📋 Download Status Report
          </button>
        </div>
      </div>
    </div>
  );
}

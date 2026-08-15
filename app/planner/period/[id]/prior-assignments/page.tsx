/**
 * Prior Assignments (Overloop) Screen
 *
 * Lets a planner review, auto-derive, manually fill in, and confirm the
 * carry-over assignments from the last (windowWeeks - 1) weeks of the
 * previous published period, before roster generation is allowed to run.
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';

interface PriorAssignment {
  datum: string;
  iso_week: number;
  teller: string;
  person_codenaam: string | null;
  bron: string;
}

interface PriorAssignmentsData {
  period_id: string;
  date_range: [string, string];
  total_entries: number;
  assignments: PriorAssignment[];
  status: 'partial' | 'complete';
}

interface Period {
  id: string;
  naam: string;
  pool_id: string;
  overloop_bevestigd_op: string | null;
}

interface StaffMember {
  person_id: string;
  codenaam: string;
}

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'Evening',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Holiday',
};

const BRON_LABELS: Record<string, string> = {
  AFGELEID: 'Auto-derived',
  HANDMATIG: 'Manual',
  ONBEKEND: 'Unknown',
};

export default function PriorAssignmentsPage() {
  const params = useParams();
  const periodId = params.id as string;

  const [period, setPeriod] = useState<Period | null>(null);
  const [data, setData] = useState<PriorAssignmentsData | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [deriving, setDeriving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmResult, setConfirmResult] = useState<string | null>(null);

  const load = async () => {
    try {
      const periodRes = await fetch(`/api/periods/${periodId}`);
      const periodData = await periodRes.json();
      setPeriod(periodData.data);

      const assignmentsRes = await fetch(`/api/periods/${periodId}/prior-assignments`);
      const assignmentsData = await assignmentsRes.json();
      setData(assignmentsData.data);

      if (periodData.data?.pool_id) {
        const staffRes = await fetch(`/api/planner/pool/${periodData.data.pool_id}/members`);
        const staffData = await staffRes.json();
        setStaff(
          (staffData.data || []).map((m: { person_id: string; codenaam: string }) => ({
            person_id: m.person_id,
            codenaam: m.codenaam,
          }))
        );
      }
    } catch {
      setError('Failed to load prior assignments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  const handleAutoDerive = async () => {
    setDeriving(true);
    setError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments/auto-derive`, {
        method: 'POST',
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || 'Auto-derive failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auto-derive failed');
    } finally {
      setDeriving(false);
    }
  };

  const handleAssign = async (datum: string, teller: string, codenaam: string | null) => {
    const key = `${datum}-${teller}`;
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datum, teller, person_codenaam: codenaam }),
      });
      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error?.message || 'Failed to save');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingKey(null);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    setConfirmResult(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments/confirm`, {
        method: 'PATCH',
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || 'Confirmation failed');
      setConfirmResult('Prior assignments confirmed.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setConfirming(false);
    }
  };

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">Loading prior assignments...</div>
      </div>
    );
  }

  if (!period || !data) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 bg-red-50 border border-red-200">
          <p className="text-red-700">{error || 'Failed to load prior assignments'}</p>
        </div>
      </div>
    );
  }

  const knownCount = data.assignments.filter((a) => a.person_codenaam).length;

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <h1 className="text-2xl font-bold text-neutral-900 mb-1">Prior Assignments</h1>
        <p className="text-neutral-600">
          {period.naam} · carry-over window {data.date_range[0]} to {data.date_range[1]}
        </p>
        {period.overloop_bevestigd_op && (
          <p className="text-sm text-green-700 mt-2">
            ✓ Confirmed on {new Date(period.overloop_bevestigd_op).toLocaleString()}
          </p>
        )}
      </div>

      <div className="card p-4 flex items-center justify-between">
        <p className="text-sm font-medium">
          {knownCount} of {data.total_entries} assigned{' '}
          {data.status === 'complete' ? '(all entries present)' : '(entries still missing)'}
        </p>
        <button
          onClick={handleAutoDerive}
          disabled={deriving}
          className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
        >
          {deriving ? 'Deriving...' : 'Auto-derive from previous period'}
        </button>
      </div>

      {error && (
        <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
      )}
      {confirmResult && (
        <div className="card p-4 bg-green-50 border border-green-200 text-sm text-green-700">
          {confirmResult}
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Week</th>
              <th className="px-3 py-2 text-left">Shift</th>
              <th className="px-3 py-2 text-left">Assigned to</th>
              <th className="px-3 py-2 text-left">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.assignments.map((a) => {
              const key = `${a.datum}-${a.teller}`;
              return (
                <tr key={key} className={!a.person_codenaam ? 'bg-amber-50' : ''}>
                  <td className="px-3 py-2 font-mono">{a.datum}</td>
                  <td className="px-3 py-2">W{a.iso_week}</td>
                  <td className="px-3 py-2">{TELLER_LABELS[a.teller] || a.teller}</td>
                  <td className="px-3 py-2">
                    <select
                      value={a.person_codenaam || ''}
                      disabled={savingKey === key}
                      onChange={(e) => handleAssign(a.datum, a.teller, e.target.value || null)}
                      className="px-2 py-1 border rounded text-sm w-full"
                    >
                      <option value="">Unknown</option>
                      {staff.map((s) => (
                        <option key={s.person_id} value={s.codenaam}>
                          {s.codenaam}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-600">
                    {BRON_LABELS[a.bron] || a.bron}
                  </td>
                </tr>
              );
            })}
            {data.assignments.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-neutral-500">
                  No entries yet - try auto-deriving from the previous period
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <button
        onClick={handleConfirm}
        disabled={confirming || data.status !== 'complete'}
        className={`w-full py-3 px-4 rounded font-semibold text-white transition-colors ${
          confirming || data.status !== 'complete'
            ? 'bg-neutral-400 cursor-not-allowed'
            : 'bg-green-600 hover:bg-green-700'
        }`}
      >
        {confirming
          ? 'Confirming...'
          : data.status !== 'complete'
            ? 'Fill in all entries before confirming'
            : 'Confirm Prior Assignments'}
      </button>
    </div>
  );
}

/**
 * Planner Landing Page
 *
 * Lists existing periods and lets a planner create a new one.
 */

'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  pool_id: string;
}

interface Pool {
  id: string;
  naam: string;
  type: string;
  member_count: number;
}

const statusLabels: Record<string, string> = {
  CONCEPT: '⚙️ Concept',
  OPEN: '📖 Open',
  GESLOTEN: '🔒 Closed',
  GEGENEREERD: '🤖 Generated',
  GEPUBLICEERD: '✅ Published',
};

export default function PlannerHomePage() {
  const router = useRouter();
  const [periods, setPeriods] = useState<Period[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    naam: '',
    pool_id: '',
    start_datum: '',
    eind_datum: '',
    deadline: '',
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [periodsRes, poolsRes] = await Promise.all([
        fetch('/api/periods'),
        fetch('/api/planner/pools'),
      ]);
      const periodsData = await periodsRes.json();
      const poolsData = await poolsRes.json();
      setPeriods(periodsData.data || []);
      setPools(poolsData.data || []);
      if (poolsData.data?.length && !form.pool_id) {
        setForm((f) => ({ ...f, pool_id: poolsData.data[0].id }));
      }
    } catch {
      setError('Failed to load periods');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    setError(null);

    if (!form.naam || !form.pool_id || !form.start_datum || !form.eind_datum || !form.deadline) {
      setError('All fields are required');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/planner/periods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error?.message || 'Failed to create period');
      }

      router.push(`/planner/setup/${data.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create period');
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  };

  return (
    <div className="container-main py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-neutral-900">Periods</h1>
        <div className="flex gap-3">
          <button onClick={() => setShowCreate(!showCreate)} className="btn-primary">
            {showCreate ? 'Cancel' : '+ New Period'}
          </button>
          <button onClick={handleLogout} className="btn-secondary">
            Log out
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="card card-padding space-y-4">
          <h2 className="text-lg font-semibold">Create New Period</h2>

          <div className="form-group">
            <label className="label">Period Name</label>
            <input
              type="text"
              className="input w-full"
              value={form.naam}
              onChange={(e) => setForm({ ...form, naam: e.target.value })}
              placeholder="e.g., 2027-2"
            />
          </div>

          <div className="form-group">
            <label className="label">Pool</label>
            <select
              className="input w-full"
              value={form.pool_id}
              onChange={(e) => setForm({ ...form, pool_id: e.target.value })}
            >
              {pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.naam} ({p.member_count} members)
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="form-group">
              <label className="label">Start Date</label>
              <input
                type="date"
                className="input w-full"
                value={form.start_datum}
                onChange={(e) => setForm({ ...form, start_datum: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="label">End Date</label>
              <input
                type="date"
                className="input w-full"
                value={form.eind_datum}
                onChange={(e) => setForm({ ...form, eind_datum: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="label">Deadline</label>
              <input
                type="date"
                className="input w-full"
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button onClick={handleCreate} disabled={creating} className="btn-primary">
            {creating ? 'Creating...' : 'Create and Continue to Setup'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="card p-8 text-center text-neutral-600">Loading periods...</div>
      ) : periods.length === 0 ? (
        <div className="card p-8 text-center text-neutral-600">
          No periods yet. Create one to get started.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-neutral-100">
              <tr>
                <th className="px-4 py-2 text-left text-sm font-medium">Name</th>
                <th className="px-4 py-2 text-left text-sm font-medium">Dates</th>
                <th className="px-4 py-2 text-left text-sm font-medium">Status</th>
                <th className="px-4 py-2 text-left text-sm font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {periods.map((p) => (
                <tr key={p.id} className="hover:bg-neutral-50">
                  <td className="px-4 py-2 text-sm font-medium">{p.naam}</td>
                  <td className="px-4 py-2 text-sm text-neutral-600">
                    {p.start_datum} to {p.eind_datum}
                  </td>
                  <td className="px-4 py-2 text-sm">{statusLabels[p.status] || p.status}</td>
                  <td className="px-4 py-2 text-sm">
                    <Link
                      href={p.status === 'CONCEPT' ? `/planner/setup/${p.id}` : `/planner/period/${p.id}`}
                      className="text-blue-600 hover:text-blue-700 font-medium"
                    >
                      {p.status === 'CONCEPT' ? 'Continue setup' : 'Open'} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

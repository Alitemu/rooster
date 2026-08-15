'use client';

/**
 * Assignment Grid Component
 *
 * Shows all assignments for a period in a table view.
 * Supports filtering and pagination.
 */

import { useState, useEffect, useCallback } from 'react';

interface Assignment {
  id: string;
  person_id: string;
  slot_id: string;
  codenaam: string;
  datum: string;
  iso_week: number;
  shift_type_id: string;
  teller: string;
  bron: string;
}

interface Props {
  periodId: string;
  /** Removing from a published roster requires a reason (enforced server-side). */
  periodStatus?: string;
  onChanged?: () => void;
}

export function AssignmentGrid({ periodId, periodStatus, onChanged }: Props) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filterPerson, setFilterPerson] = useState('');
  const [filterShiftType, setFilterShiftType] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);

  const isPublished = periodStatus === 'GEPUBLICEERD';

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      let url = `/api/planner/period/${periodId}/assignments?page=${page}`;
      if (filterPerson) url += `&person_id=${filterPerson}`;
      if (filterShiftType) url += `&shift_type=${filterShiftType}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load assignments');

      const data = await res.json();
      setAssignments(data.data.assignments);
      setTotalPages(data.data.pagination.total_pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assignments');
    } finally {
      setLoading(false);
    }
  }, [periodId, page, filterPerson, filterShiftType]);

  useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

  const handleRemove = async (assignmentId: string) => {
    setRemoving(assignmentId);
    setError(null);
    try {
      const res = await fetch(
        `/api/planner/period/${periodId}/assignments/${assignmentId}/delete`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() || null }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove assignment');

      setConfirmingId(null);
      setReason('');
      await loadAssignments();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove assignment');
    } finally {
      setRemoving(null);
    }
  };

  const shiftTypeNames: Record<string, string> = {
    AVOND: 'Evening',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Holiday',
  };

  const sourceColors: Record<string, string> = {
    SOLVER: 'bg-blue-100 text-blue-800',
    MANUAL: 'bg-amber-100 text-amber-800',
    OVERRIDE: 'bg-purple-100 text-purple-800',
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Loading assignments...</p>
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

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="card p-4 bg-neutral-50">
        <div className="grid grid-cols-2 gap-4">
          <input
            type="text"
            placeholder="Filter by person code"
            value={filterPerson}
            onChange={(e) => {
              setFilterPerson(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 border rounded text-sm"
          />
          <select
            value={filterShiftType}
            onChange={(e) => {
              setFilterShiftType(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 border rounded text-sm"
          >
            <option value="">All shift types</option>
            <option value="AVOND">Evening</option>
            <option value="WEEKEND">Weekend</option>
            <option value="FEESTDAG">Holiday</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card p-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">Week</th>
                <th className="px-3 py-2 text-left font-semibold">Person</th>
                <th className="px-3 py-2 text-left font-semibold">Shift Type</th>
                <th className="px-3 py-2 text-left font-semibold">Source</th>
                <th className="px-3 py-2 text-left font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assignments.map((a) => (
                <tr key={a.id} className="hover:bg-neutral-50">
                  <td className="px-3 py-2 font-medium">{a.datum}</td>
                  <td className="px-3 py-2 text-neutral-600">W{a.iso_week}</td>
                  <td className="px-3 py-2">{a.codenaam}</td>
                  <td className="px-3 py-2">{shiftTypeNames[a.teller] || a.teller}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${sourceColors[a.bron] || 'bg-neutral-100'}`}>
                      {a.bron}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {confirmingId === a.id ? (
                      <div className="flex items-center justify-end gap-2">
                        <input
                          type="text"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder={isPublished ? 'Reason (required)' : 'Reason (optional)'}
                          className="px-2 py-1 border rounded text-xs w-44"
                        />
                        <button
                          onClick={() => handleRemove(a.id)}
                          disabled={removing === a.id || (isPublished && !reason.trim())}
                          className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:bg-neutral-300"
                        >
                          {removing === a.id ? 'Removing…' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => {
                            setConfirmingId(null);
                            setReason('');
                          }}
                          className="text-xs px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setConfirmingId(a.id);
                          setReason('');
                        }}
                        className="text-xs text-red-600 hover:text-red-800 font-medium"
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {assignments.length === 0 && (
          <div className="text-center py-8">
            <p className="text-neutral-500">No assignments found</p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="px-3 py-2 rounded border disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            Previous
          </button>
          <span className="px-3 py-2">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="px-3 py-2 rounded border disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

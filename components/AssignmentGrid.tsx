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

interface EligiblePerson {
  id: string;
  codenaam: string;
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
  const [reassigningId, setReassigningId] = useState<string | null>(null);
  const [eligiblePeople, setEligiblePeople] = useState<EligiblePerson[] | null>(null);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [reassignPersonId, setReassignPersonId] = useState('');
  const [reassignReason, setReassignReason] = useState('');
  const [reassigning, setReassigning] = useState<string | null>(null);

  const isPublished = periodStatus === 'GEPUBLICEERD';

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      let url = `/api/planner/period/${periodId}/assignments?page=${page}`;
      if (filterPerson) url += `&person_id=${filterPerson}`;
      if (filterShiftType) url += `&shift_type=${filterShiftType}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error('Laden van toewijzingen mislukt');

      const data = await res.json();
      setAssignments(data.data.assignments);
      setTotalPages(data.data.pagination.total_pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Laden van toewijzingen mislukt');
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
      if (!res.ok) throw new Error(data.error || 'Verwijderen van toewijzing mislukt');

      setConfirmingId(null);
      setReason('');
      await loadAssignments();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verwijderen van toewijzing mislukt');
    } finally {
      setRemoving(null);
    }
  };

  const openReassign = async (assignmentId: string) => {
    setConfirmingId(null);
    setReassigningId(assignmentId);
    setReassignPersonId('');
    setReassignReason('');
    setEligiblePeople(null);
    setEligibleLoading(true);
    try {
      const res = await fetch(
        `/api/planner/period/${periodId}/assignments/${assignmentId}/eligible-people`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ophalen van beschikbare collega\'s mislukt');
      setEligiblePeople(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ophalen van beschikbare collega\'s mislukt');
      setEligiblePeople([]);
    } finally {
      setEligibleLoading(false);
    }
  };

  const handleReassign = async (assignmentId: string) => {
    if (!reassignPersonId) return;
    setReassigning(assignmentId);
    setError(null);
    try {
      const res = await fetch(
        `/api/planner/period/${periodId}/assignments/${assignmentId}/reassign`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: reassignPersonId, reason: reassignReason.trim() || null }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Wisselen van toewijzing mislukt');

      setReassigningId(null);
      setReassignPersonId('');
      setReassignReason('');
      setEligiblePeople(null);
      await loadAssignments();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wisselen van toewijzing mislukt');
    } finally {
      setReassigning(null);
    }
  };

  const shiftTypeNames: Record<string, string> = {
    AVOND: 'Avond',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Feestdag',
  };

  const sourceColors: Record<string, string> = {
    SOLVER: 'bg-blue-100 text-blue-800',
    MANUAL: 'bg-amber-100 text-amber-800',
    OVERRIDE: 'bg-purple-100 text-purple-800',
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Toewijzingen laden...</p>
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
            placeholder="Filter op codenaam"
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
            <option value="">Alle diensttypes</option>
            <option value="AVOND">Avond</option>
            <option value="WEEKEND">Weekend</option>
            <option value="FEESTDAG">Feestdag</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="card p-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Datum</th>
                <th className="px-3 py-2 text-left font-semibold">Week</th>
                <th className="px-3 py-2 text-left font-semibold">Persoon</th>
                <th className="px-3 py-2 text-left font-semibold">Diensttype</th>
                <th className="px-3 py-2 text-left font-semibold">Bron</th>
                <th className="px-3 py-2 text-left font-semibold">Acties</th>
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
                          placeholder={isPublished ? 'Reden (verplicht)' : 'Reden (optioneel)'}
                          className="px-2 py-1 border rounded text-xs w-44"
                        />
                        <button
                          onClick={() => handleRemove(a.id)}
                          disabled={removing === a.id || (isPublished && !reason.trim())}
                          className="text-xs px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:bg-neutral-300"
                        >
                          {removing === a.id ? 'Bezig…' : 'Bevestigen'}
                        </button>
                        <button
                          onClick={() => {
                            setConfirmingId(null);
                            setReason('');
                          }}
                          className="text-xs px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300"
                        >
                          Annuleren
                        </button>
                      </div>
                    ) : reassigningId === a.id ? (
                      <div className="flex items-center justify-end gap-2">
                        {eligibleLoading || eligiblePeople === null ? (
                          <span className="text-xs text-neutral-500">Collega&apos;s laden…</span>
                        ) : eligiblePeople.length === 0 ? (
                          <span className="text-xs text-red-600">Niemand anders komt in aanmerking</span>
                        ) : (
                          <select
                            value={reassignPersonId}
                            onChange={(e) => setReassignPersonId(e.target.value)}
                            className="text-xs border border-neutral-300 rounded px-2 py-1"
                          >
                            <option value="">Kies iemand…</option>
                            {eligiblePeople.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.codenaam}
                              </option>
                            ))}
                          </select>
                        )}
                        <input
                          type="text"
                          value={reassignReason}
                          onChange={(e) => setReassignReason(e.target.value)}
                          placeholder={isPublished ? 'Reden (verplicht)' : 'Reden (optioneel)'}
                          className="px-2 py-1 border rounded text-xs w-36"
                        />
                        <button
                          onClick={() => handleReassign(a.id)}
                          disabled={
                            reassigning === a.id ||
                            !reassignPersonId ||
                            (isPublished && !reassignReason.trim())
                          }
                          className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300"
                        >
                          {reassigning === a.id ? 'Bezig…' : 'Bevestigen'}
                        </button>
                        <button
                          onClick={() => {
                            setReassigningId(null);
                            setEligiblePeople(null);
                            setReassignReason('');
                          }}
                          className="text-xs px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300"
                        >
                          Annuleren
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => openReassign(a.id)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Wisselen
                        </button>
                        <button
                          onClick={() => {
                            setReassigningId(null);
                            setConfirmingId(a.id);
                            setReason('');
                          }}
                          className="text-xs text-red-600 hover:text-red-800 font-medium"
                        >
                          Niemand toewijzen
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {assignments.length === 0 && (
          <div className="text-center py-8">
            <p className="text-neutral-500">Geen toewijzingen gevonden</p>
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
            Vorige
          </button>
          <span className="px-3 py-2">
            Pagina {page} van {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="px-3 py-2 rounded border disabled:bg-neutral-100 disabled:text-neutral-400"
          >
            Volgende
          </button>
        </div>
      )}
    </div>
  );
}

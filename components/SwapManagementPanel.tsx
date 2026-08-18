'use client';

/**
 * Swap Management Panel
 *
 * Display pending swap requests for planner or staff member.
 * Shows requests where user is requester or respondent.
 */

import { useState, useEffect } from 'react';

interface SwapRequest {
  id: string;
  periode_id: string;
  status: string;
  aangemaakt_op: string;
  aanvrager_person_id: string;
  aanvrager_codenaam: string;
  respondent_person_id: string;
  respondent_codenaam: string;
  aangeboden_datum: string;
  aangeboden_type: string;
  gevraagde_datum: string;
  gevraagde_type: string;
}

interface Props {
  personId: string;
  periodId: string;
}

export function SwapManagementPanel({ personId, periodId }: Props) {
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState('PENDING');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    const loadSwaps = async () => {
      setLoading(true);
      setError(null);

      try {
        let url = `/api/person/${personId}/swap-requests?period_id=${periodId}`;
        if (filterStatus) url += `&status=${filterStatus}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('Laden van ruilverzoeken mislukt');

        const data = await res.json();
        setSwapRequests(data.data.swap_requests);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Laden van ruilverzoeken mislukt');
      } finally {
        setLoading(false);
      }
    };

    loadSwaps();
  }, [personId, periodId, filterStatus]);

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 5000);
  };

  const handleApprove = async (swapId: string) => {
    try {
      const res = await fetch(`/api/person/${personId}/swap-requests/${swapId}/approve`, {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Goedkeuren van ruil mislukt');

      setSwapRequests(swapRequests.filter((s) => s.id !== swapId));
      showSuccess('Ruil goedgekeurd');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Goedkeuren van ruil mislukt');
    }
  };

  const handleReject = async (swapId: string, reason?: string) => {
    try {
      const res = await fetch(`/api/person/${personId}/swap-requests/${swapId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      });

      if (!res.ok) throw new Error('Weigeren van ruil mislukt');

      setSwapRequests(swapRequests.filter((s) => s.id !== swapId));
      setRejectingId(null);
      setRejectionReason('');
      showSuccess('Ruil geweigerd');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Weigeren van ruil mislukt');
    }
  };

  const shiftTypeNames: Record<string, string> = {
    AVOND: 'Avond',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Feestdag',
  };

  const statusBadges: Record<string, string> = {
    PENDING: 'bg-amber-100 text-amber-800',
    GOEDGEKEURD: 'bg-green-100 text-green-800',
    AFGEWEZEN: 'bg-red-100 text-red-800',
    INGETROKKEN: 'bg-neutral-100 text-neutral-800',
  };

  const statusLabels: Record<string, string> = {
    PENDING: 'In behandeling',
    GOEDGEKEURD: 'Goedgekeurd',
    AFGEWEZEN: 'Geweigerd',
    INGETROKKEN: 'Ingetrokken',
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Ruilverzoeken laden...</p>
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
    <div className="space-y-4">
      {successMessage && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
          {successMessage}
        </div>
      )}

      {/* Filter */}
      <div className="card p-4 bg-neutral-50">
        <select
          name="status-filter"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border rounded text-sm"
        >
          <option value="">Alle statussen</option>
          <option value="PENDING">In behandeling</option>
          <option value="GOEDGEKEURD">Goedgekeurd</option>
          <option value="AFGEWEZEN">Geweigerd</option>
          <option value="INGETROKKEN">Ingetrokken</option>
        </select>
      </div>

      {/* Swap Requests */}
      {swapRequests.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-neutral-600">Geen ruilverzoeken gevonden</p>
        </div>
      )}

      <div className="space-y-3">
        {swapRequests.map((swap) => {
          const isRequester = swap.aanvrager_person_id === personId;
          const isRespondent = swap.respondent_person_id === personId;
          const isPending = swap.status === 'PENDING';

          return (
            <div
              key={swap.id}
              data-status={swap.status}
              className="card p-4 border-l-4 border-blue-600"
            >
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${statusBadges[swap.status]}`}>
                      {statusLabels[swap.status]}
                    </span>
                    {isRequester && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                        Door jou aangevraagd
                      </span>
                    )}
                    {isRespondent && isPending && (
                      <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">
                        Wacht op jouw goedkeuring
                      </span>
                    )}
                  </div>

                  <div className="text-sm mb-2">
                    <p className="font-semibold text-neutral-900">
                      {isRequester
                        ? `Jij → ${swap.respondent_codenaam}`
                        : `${swap.aanvrager_codenaam} → Jij`}
                    </p>
                  </div>

                  <div className="bg-neutral-50 rounded p-3 text-sm space-y-1 mb-2">
                    <div className="flex justify-between">
                      <span className="text-neutral-600">Aangeboden:</span>
                      <span className="font-medium">
                        {swap.aangeboden_datum} ({shiftTypeNames[swap.aangeboden_type]})
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-600">Gevraagd:</span>
                      <span className="font-medium">
                        {swap.gevraagde_datum} ({shiftTypeNames[swap.gevraagde_type]})
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-neutral-500">
                    {new Date(swap.aangemaakt_op).toLocaleDateString()}
                  </p>
                </div>

                {/* Actions */}
                {isPending && isRespondent && rejectingId !== swap.id && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(swap.id)}
                      className="px-3 py-1 rounded text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
                    >
                      Goedkeuren
                    </button>
                    <button
                      onClick={() => {
                        setRejectingId(swap.id);
                        setRejectionReason('');
                      }}
                      className="px-3 py-1 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
                    >
                      Weigeren
                    </button>
                  </div>
                )}
              </div>

              {isPending && isRespondent && rejectingId === swap.id && (
                <div className="mt-3 pt-3 border-t space-y-2">
                  <label className="block text-xs font-medium text-neutral-700">
                    Reden (optioneel)
                  </label>
                  <textarea
                    name="rejection-reason"
                    value={rejectionReason}
                    onChange={(e) => setRejectionReason(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleReject(swap.id, rejectionReason)}
                      className="px-3 py-1 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
                    >
                      Weigeren
                    </button>
                    <button
                      onClick={() => setRejectingId(null)}
                      className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
                    >
                      Annuleren
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

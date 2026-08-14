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

  useEffect(() => {
    const loadSwaps = async () => {
      setLoading(true);
      setError(null);

      try {
        let url = `/api/person/${personId}/swap-requests?period_id=${periodId}`;
        if (filterStatus) url += `&status=${filterStatus}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load swap requests');

        const data = await res.json();
        setSwapRequests(data.data.swap_requests);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load swap requests');
      } finally {
        setLoading(false);
      }
    };

    loadSwaps();
  }, [personId, periodId, filterStatus]);

  const handleApprove = async (swapId: string) => {
    try {
      const res = await fetch(`/api/person/${personId}/swap-requests/${swapId}/approve`, {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to approve swap');

      // Reload swaps
      setSwapRequests(swapRequests.filter((s) => s.id !== swapId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve swap');
    }
  };

  const handleReject = async (swapId: string, reason?: string) => {
    try {
      const res = await fetch(`/api/person/${personId}/swap-requests/${swapId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      });

      if (!res.ok) throw new Error('Failed to reject swap');

      setSwapRequests(swapRequests.filter((s) => s.id !== swapId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject swap');
    }
  };

  const shiftTypeNames: Record<string, string> = {
    AVOND: 'Evening',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Holiday',
  };

  const statusBadges: Record<string, string> = {
    PENDING: 'bg-amber-100 text-amber-800',
    GOEDGEKEURD: 'bg-green-100 text-green-800',
    AFGEWEZEN: 'bg-red-100 text-red-800',
    INGETROKKEN: 'bg-neutral-100 text-neutral-800',
  };

  const statusLabels: Record<string, string> = {
    PENDING: 'Pending',
    GOEDGEKEURD: 'Approved',
    AFGEWEZEN: 'Rejected',
    INGETROKKEN: 'Withdrawn',
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Loading swap requests...</p>
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
      {/* Filter */}
      <div className="card p-4 bg-neutral-50">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border rounded text-sm"
        >
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="GOEDGEKEURD">Approved</option>
          <option value="AFGEWEZEN">Rejected</option>
          <option value="INGETROKKEN">Withdrawn</option>
        </select>
      </div>

      {/* Swap Requests */}
      {swapRequests.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-neutral-600">No swap requests found</p>
        </div>
      )}

      <div className="space-y-3">
        {swapRequests.map((swap) => {
          const isRequester = swap.aanvrager_person_id === personId;
          const isRespondent = swap.respondent_person_id === personId;
          const isPending = swap.status === 'PENDING';

          return (
            <div key={swap.id} className="card p-4 border-l-4 border-blue-600">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-block px-2 py-1 rounded text-xs font-medium ${statusBadges[swap.status]}`}>
                      {statusLabels[swap.status]}
                    </span>
                    {isRequester && (
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                        You requested
                      </span>
                    )}
                    {isRespondent && (
                      <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded">
                        Waiting for your response
                      </span>
                    )}
                  </div>

                  <div className="text-sm mb-2">
                    <p className="font-semibold text-neutral-900">
                      {isRequester
                        ? `You → ${swap.respondent_codenaam}`
                        : `${swap.aanvrager_codenaam} → You`}
                    </p>
                  </div>

                  <div className="bg-neutral-50 rounded p-3 text-sm space-y-1 mb-2">
                    <div className="flex justify-between">
                      <span className="text-neutral-600">Offered:</span>
                      <span className="font-medium">
                        {swap.aangeboden_datum} ({shiftTypeNames[swap.aangeboden_type]})
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-600">Requested:</span>
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
                {isPending && isRespondent && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(swap.id)}
                      className="px-3 py-1 rounded text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReject(swap.id)}
                      className="px-3 py-1 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

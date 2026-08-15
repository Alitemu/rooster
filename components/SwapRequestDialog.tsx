'use client';

/**
 * Swap Request Dialog
 *
 * Dialog for staff to request a shift swap with another staff member.
 */

import { useState, useEffect } from 'react';

interface Assignment {
  id: string;
  person_id: string;
  slot_id: string;
  datum: string;
  teller: string;
}

interface OtherAssignment extends Assignment {
  codenaam: string;
}

interface Props {
  personId: string;
  periodId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function SwapRequestDialog({ personId, periodId, isOpen, onClose, onSuccess }: Props) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [otherAssignments, setOtherAssignments] = useState<OtherAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offeredSlotId, setOfferedSlotId] = useState('');
  const [requestedSlotId, setRequestedSlotId] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    const loadAssignments = async () => {
      setLoading(true);
      setError(null);

      try {
        const [ownRes, othersRes] = await Promise.all([
          fetch(`/api/person/${personId}/roster/${periodId}`),
          fetch(`/api/person/${personId}/roster/${periodId}/others`),
        ]);
        if (!ownRes.ok || !othersRes.ok) throw new Error('Failed to load roster');

        const ownData = await ownRes.json();
        const othersData = await othersRes.json();
        setAssignments(ownData.data.assignments);
        setOtherAssignments(othersData.data.assignments);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load roster');
      } finally {
        setLoading(false);
      }
    };

    loadAssignments();
  }, [personId, periodId, isOpen]);

  const handleSubmit = async () => {
    if (!offeredSlotId || !requestedSlotId) {
      setError('Please select both slots');
      return;
    }

    if (offeredSlotId === requestedSlotId) {
      setError('Cannot swap same slot with itself');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/person/${personId}/swap-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: periodId,
          offered_slot_id: offeredSlotId,
          requested_slot_id: requestedSlotId,
          notes: notes || null,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create swap request');
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create swap request');
    } finally {
      setSubmitting(false);
    }
  };

  const getOfferedSlot = () => assignments.find(a => a.slot_id === offeredSlotId);
  const getRequestedSlot = () => otherAssignments.find(a => a.slot_id === requestedSlotId);

  const shiftTypeNames: Record<string, string> = {
    AVOND: 'Evening',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Holiday',
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* Header */}
        <div className="border-b p-6">
          <h2 className="text-xl font-bold">Request Shift Swap</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Select a shift you want to give and one you want to receive
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {loading && (
            <div className="text-center py-8">
              <p className="text-neutral-600">Loading your assignments...</p>
            </div>
          )}

          {!loading && (
            <>
              {/* Offered Slot */}
              <div>
                <label className="block text-sm font-semibold text-neutral-900 mb-2">
                  Shift you offer
                </label>
                <select
                  name="offered-slot"
                  value={offeredSlotId}
                  onChange={(e) => setOfferedSlotId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                >
                  <option value="">Select a shift</option>
                  {assignments.map((a) => (
                    <option key={a.slot_id} value={a.slot_id}>
                      {a.datum} - {shiftTypeNames[a.teller]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Requested Slot */}
              <div>
                <label className="block text-sm font-semibold text-neutral-900 mb-2">
                  Shift you want (from another person)
                </label>
                <select
                  name="requested-slot"
                  value={requestedSlotId}
                  onChange={(e) => setRequestedSlotId(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                >
                  <option value="">Select a shift</option>
                  {otherAssignments.length === 0 && (
                    <option value="" disabled>
                      No other shifts available
                    </option>
                  )}
                  {otherAssignments.map((a) => (
                    <option key={a.slot_id} value={a.slot_id}>
                      {a.codenaam}: {a.datum} - {shiftTypeNames[a.teller]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Preview */}
              {getOfferedSlot() && getRequestedSlot() && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="font-semibold text-sm text-blue-900 mb-2">Swap Preview</h3>
                  <div className="space-y-1 text-sm text-blue-800">
                    <p>
                      You offer: <span className="font-semibold">{getOfferedSlot()?.datum}</span>
                    </p>
                    <p>
                      You receive: <span className="font-semibold">{getRequestedSlot()?.datum}</span>
                    </p>
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-sm font-semibold text-neutral-900 mb-2">
                  Optional notes
                </label>
                <textarea
                  name="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Why do you need this swap? (optional)"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                  rows={3}
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-6 flex gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !offeredSlotId || !requestedSlotId || loading}
            className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
          >
            {submitting ? 'Sending...' : 'Send Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

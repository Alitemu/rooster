'use client';

/**
 * Fill Gaps Panel
 *
 * Shows shift slots the solver couldn't fully cover (capacity/band limits
 * are soft constraints - see solver/constraints.py) and lets the planner
 * assign someone to each one by hand, in consultation with the person on
 * duty. Calls the same manual-assign endpoint used for any manual
 * override, so the usual hard-block (ABSOLUUT) check still applies.
 */

import { useState, useEffect, useCallback } from 'react';

interface EligiblePerson {
  id: string;
  codenaam: string;
}

interface UnfilledSlot {
  slot_id: string;
  datum: string;
  iso_week: number;
  teller: string;
  benodigd_aantal_personen: number;
  assigned_count: number;
  shortfall: number;
  eligible_people: EligiblePerson[];
}

interface Props {
  periodId: string;
  onAllFilled?: () => void;
}

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'Evening',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Holiday',
};

export function FillGapsPanel({ periodId, onAllFilled }: Props) {
  const [slots, setSlots] = useState<UnfilledSlot[] | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/planner/period/${periodId}/unfilled-slots`);
    const data = await res.json();
    if (res.ok) {
      setSlots(data.data);
      if (data.data.length === 0 && onAllFilled) onAllFilled();
    }
  }, [periodId, onAllFilled]);

  useEffect(() => {
    load();
  }, [load]);

  const handleAssign = async (slotId: string) => {
    const personId = selection[slotId];
    if (!personId) return;

    setAssigning(slotId);
    setError(null);
    try {
      const res = await fetch(`/api/planner/period/${periodId}/assignments/manual-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_id: personId, slot_id: slotId, reason: 'Handmatig aangevuld' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to assign');

      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign');
    } finally {
      setAssigning(null);
    }
  };

  if (slots === null) {
    return null;
  }

  if (slots.length === 0) {
    return (
      <div className="card p-4 bg-green-50 border border-green-200">
        <p className="text-sm text-green-900 font-medium">
          ✓ Every shift in this roster is covered.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6 bg-amber-50 border border-amber-200">
      <h3 className="font-semibold text-amber-900 mb-1">
        ⚠️ {slots.length} shift{slots.length === 1 ? '' : 's'} still need{slots.length === 1 ? 's' : ''} someone
      </h3>
      <p className="text-sm text-amber-800 mb-4">
        The solver couldn&apos;t find anyone for these within the configured limits. Fill them in yourself,
        in consultation with whoever is available.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {slots.map((slot) => (
          <div
            key={slot.slot_id}
            className="flex items-center justify-between gap-3 p-3 rounded bg-white border border-amber-200"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-900">
                {new Date(slot.datum).toLocaleDateString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                })}{' '}
                · {TELLER_LABELS[slot.teller] || slot.teller}
              </p>
              <p className="text-xs text-neutral-500">
                Week {slot.iso_week} · {slot.assigned_count}/{slot.benodigd_aantal_personen} filled
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {slot.eligible_people.length === 0 ? (
                <span className="text-xs text-red-600">No one is eligible (all blocked)</span>
              ) : (
                <>
                  <select
                    className="text-sm border border-neutral-300 rounded px-2 py-1"
                    value={selection[slot.slot_id] || ''}
                    onChange={(e) =>
                      setSelection((prev) => ({ ...prev, [slot.slot_id]: e.target.value }))
                    }
                  >
                    <option value="">Choose someone…</option>
                    {slot.eligible_people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.codenaam}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleAssign(slot.slot_id)}
                    disabled={!selection[slot.slot_id] || assigning === slot.slot_id}
                    className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300 transition-colors"
                  >
                    {assigning === slot.slot_id ? 'Assigning…' : 'Assign'}
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

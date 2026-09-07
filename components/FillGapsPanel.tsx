'use client';

/**
 * Fill Gaps Panel
 *
 * Shows shift slots the solver couldn't fully cover (capacity/band limits
 * are soft constraints - see solver/constraints.py) and lets the planner
 * assign someone to each one by hand, in consultation with the person on
 * duty. Calls the same manual-assign endpoint used for any manual
 * override - everyone in the pool is offered, grouped by category so a
 * blocked or window-conflicted person is never hidden, just clearly
 * marked before the planner picks them.
 */

import { useState, useEffect, useCallback } from 'react';

type EligibilityCategory = 'BESCHIKBAAR' | 'VENSTERBLOK' | 'PARTTIME' | 'GEBLOKKEERD';

interface EligiblePerson {
  id: string;
  codenaam: string;
  category: EligibilityCategory;
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
  AVOND: 'Avond',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Feestdag',
};

// Display order for the grouped menu, and the group headings.
const CATEGORY_ORDER: EligibilityCategory[] = ['BESCHIKBAAR', 'VENSTERBLOK', 'PARTTIME', 'GEBLOKKEERD'];

const CATEGORY_GROUP_LABELS: Record<EligibilityCategory, string> = {
  BESCHIKBAAR: 'Beschikbaar',
  VENSTERBLOK: 'Dienst valt in vensterblok',
  PARTTIME: 'Part-time dag',
  GEBLOKKEERD: 'Geblokkeerd',
};

// Short note shown next to a selected non-available person.
const CATEGORY_NOTES: Record<EligibilityCategory, string> = {
  BESCHIKBAAR: '',
  VENSTERBLOK: 'heeft al een dienst binnen het venster',
  PARTTIME: 'heeft parttime-vrij op deze dag',
  GEBLOKKEERD: 'heeft deze dag geblokkeerd',
};

function groupByCategory(people: EligiblePerson[]): Array<[EligibilityCategory, EligiblePerson[]]> {
  return CATEGORY_ORDER.map(
    (cat): [EligibilityCategory, EligiblePerson[]] => [cat, people.filter((p) => p.category === cat)]
  ).filter(([, group]) => group.length > 0);
}

export function FillGapsPanel({ periodId, onAllFilled }: Props) {
  const [slots, setSlots] = useState<UnfilledSlot[] | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

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
    setWarning(null);
    try {
      const res = await fetch(`/api/planner/period/${periodId}/assignments/manual-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person_id: personId, slot_id: slotId, reason: 'Handmatig aangevuld' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Toewijzen mislukt');
      if (data.data?.warning) setWarning(data.data.warning.message);

      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toewijzen mislukt');
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
          ✓ Elke dienst in dit rooster is ingevuld.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6 bg-amber-50 border border-amber-200">
      <h3 className="font-semibold text-amber-900 mb-1">
        ⚠️ {slots.length} dienst{slots.length === 1 ? '' : 'en'} nog niet ingevuld
      </h3>
      <p className="text-sm text-amber-800 mb-4">
        De solver kon hiervoor niemand vinden binnen de ingestelde grenzen. Vul ze zelf in,
        in overleg met wie beschikbaar is.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      {warning && (
        <div className="mb-4 p-3 rounded bg-orange-50 border border-orange-300 text-sm text-orange-900">
          ⚠️ {warning}
        </div>
      )}

      <div className="space-y-2">
        {slots.map((slot) => {
          const selectedPerson = slot.eligible_people.find((p) => p.id === selection[slot.slot_id]);
          const groups = groupByCategory(slot.eligible_people);
          return (
            <div
              key={slot.slot_id}
              className="flex items-center justify-between gap-3 p-3 rounded bg-white border border-amber-200"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900">
                  {new Date(slot.datum).toLocaleDateString('nl-NL', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                  })}{' '}
                  · {TELLER_LABELS[slot.teller] || slot.teller}
                </p>
                <p className="text-xs text-neutral-500">
                  Week {slot.iso_week} · {slot.assigned_count}/{slot.benodigd_aantal_personen} ingevuld
                </p>
                {selectedPerson && selectedPerson.category !== 'BESCHIKBAAR' && (
                  <p className="text-xs text-orange-700 mt-1">
                    ⚠️ {selectedPerson.codenaam} {CATEGORY_NOTES[selectedPerson.category]}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {slot.eligible_people.length === 0 ? (
                  <span className="text-xs text-red-600">Niemand in de pool beschikbaar</span>
                ) : (
                  <>
                    <select
                      className="text-sm border border-neutral-300 rounded px-2 py-1"
                      value={selection[slot.slot_id] || ''}
                      onChange={(e) =>
                        setSelection((prev) => ({ ...prev, [slot.slot_id]: e.target.value }))
                      }
                    >
                      <option value="">Kies iemand…</option>
                      {groups.map(([category, people]) => (
                        <optgroup
                          key={category}
                          label={`${CATEGORY_GROUP_LABELS[category]} (${people.length})`}
                        >
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.codenaam}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <button
                      onClick={() => handleAssign(slot.slot_id)}
                      disabled={!selection[slot.slot_id] || assigning === slot.slot_id}
                      className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300 transition-colors"
                    >
                      {assigning === slot.slot_id ? 'Bezig…' : 'Toewijzen'}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

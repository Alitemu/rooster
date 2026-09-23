'use client';

/**
 * Swap Request Dialog
 *
 * Dialog for staff to request a shift swap with another staff member.
 */

import { useState, useEffect } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';

interface Assignment {
  id: string;
  person_id: string;
  slot_id: string;
  datum: string;
  teller: string;
}

type CandidateCategory = 'VOORKEUR' | 'BESCHIKBAAR' | 'LIEVER_NIET' | 'KORT_OP_ELKAAR' | 'GEBLOKKEERD';

interface Candidate {
  slot_id: string;
  person_id: string;
  codenaam: string;
  datum: string;
  teller: string;
  category: CandidateCategory;
  /** You would end up with two shifts close together yourself. */
  requester_te_dichtbij: boolean;
  /** You already asked this colleague for this shift, and they haven't answered yet. */
  al_gevraagd: boolean;
}

// Most promising first. The colleague would get the shift you offer, so
// each group says how they stand towards THAT day - see
// lib/swapCandidates.ts.
const CATEGORY_ORDER: CandidateCategory[] = [
  'VOORKEUR',
  'BESCHIKBAAR',
  'LIEVER_NIET',
  'KORT_OP_ELKAAR',
  'GEBLOKKEERD',
];

const CATEGORY_LABELS: Record<CandidateCategory, string> = {
  VOORKEUR: 'Heeft voorkeur voor die dag',
  BESCHIKBAAR: 'Niets aangegeven voor die dag',
  LIEVER_NIET: 'Liever niet op die dag',
  KORT_OP_ELKAAR: 'Heeft dan twee diensten kort op elkaar',
  GEBLOKKEERD: 'Heeft die dag geblokkeerd (ook parttime of afwezig)',
};

interface Props {
  personId: string;
  periodId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

// Rest of the app formats dates via toLocaleDateString('nl-NL') rather than
// showing the raw YYYY-MM-DD - kept consistent here too.
function formatDatum(datum: string): string {
  return new Date(datum).toLocaleDateString('nl-NL');
}

export function SwapRequestDialog({ personId, periodId, isOpen, onClose, onSuccess }: Props) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offeredSlotId, setOfferedSlotId] = useState('');
  const [requestedSlotId, setRequestedSlotId] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    // This component never unmounts between opens (isOpen just toggles
    // its own rendering), so without an explicit reset a selection from a
    // previous, cancelled session stays in state - the <select> visually
    // falls back to its placeholder once the reloaded roster no longer
    // contains that slot id, but "Verzoek versturen" stayed enabled on
    // the stale id underneath.
    setOfferedSlotId('');
    setRequestedSlotId('');
    setNotes('');
    setError(null);

    const loadAssignments = async () => {
      setLoading(true);
      setError(null);

      try {
        const ownRes = await fetch(`/api/person/${personId}/roster/${periodId}`);
        if (!ownRes.ok) throw new Error('Laden van rooster mislukt');

        const ownData = await ownRes.json();
        setAssignments(ownData.data.assignments);
        setCandidates(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Laden van rooster mislukt');
      } finally {
        setLoading(false);
      }
    };

    loadAssignments();
  }, [personId, periodId, isOpen]);

  // Who could take the offered shift, and how each of them stands towards
  // that day - fetched per offered shift, since that is what it depends on.
  useEffect(() => {
    if (!isOpen || !offeredSlotId) {
      setCandidates(null);
      return;
    }
    let current = true;
    setCandidatesLoading(true);
    fetch(`/api/person/${personId}/swap-requests/candidates?period_id=${periodId}&offered_slot_id=${offeredSlotId}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Laden van collega\'s mislukt');
        if (current) setCandidates(data.data.candidates);
      })
      .catch((err) => {
        if (!current) return;
        setCandidates([]);
        setError(err instanceof Error ? err.message : 'Laden van collega\'s mislukt');
      })
      .finally(() => {
        if (current) setCandidatesLoading(false);
      });
    return () => {
      current = false;
    };
  }, [isOpen, offeredSlotId, personId, periodId]);

  const handleSubmit = async () => {
    if (!offeredSlotId || !requestedSlotId) {
      setError('Selecteer beide diensten');
      return;
    }

    if (offeredSlotId === requestedSlotId) {
      setError('Je kunt een dienst niet met zichzelf ruilen');
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
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Aanmaken van ruilverzoek mislukt');
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aanmaken van ruilverzoek mislukt');
    } finally {
      setSubmitting(false);
    }
  };

  const getOfferedSlot = () => assignments.find(a => a.slot_id === offeredSlotId);
  const getRequestedSlot = () => candidates?.find((c) => c.slot_id === requestedSlotId);

  // Only same-teller shifts come back from the candidates endpoint - the
  // backend rejects a cross-counter pair outright (an unequal trade goes
  // through the planner's saldo-correcties instead).
  const offeredTeller = getOfferedSlot()?.teller;
  const groupedCandidates = CATEGORY_ORDER.map(
    (category) => [category, (candidates ?? []).filter((c) => c.category === category)] as const
  ).filter(([, list]) => list.length > 0);

  const shiftTypeNames: Record<string, string> = {
    AVOND: 'Avond',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Feestdag',
  };

  useBodyScrollLock(isOpen);
  // Mirrors the Annuleren button below (disabled={submitting}).
  const dismissBackdrop = useDialogDismiss(isOpen, onClose, !submitting);

  if (!isOpen) return null;

  return (
    <div
      onClick={dismissBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="Ruilverzoek indienen"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-full flex flex-col">
        {/* Header */}
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Ruilverzoek indienen</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Kies een dienst die je wilt afstaan en een die je wilt ontvangen
          </p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto min-h-0">
          {loading && (
            <div className="text-center py-8">
              <p className="text-neutral-600">Je diensten laden...</p>
            </div>
          )}

          {!loading && (
            <>
              {/* Offered Slot */}
              <div>
                <label className="block text-sm font-semibold text-neutral-900 mb-2">
                  Dienst die je aanbiedt
                </label>
                <select
                  name="offered-slot"
                  value={offeredSlotId}
                  onChange={(e) => {
                    setOfferedSlotId(e.target.value);
                    // Changing the offered slot can change its teller,
                    // which may make the already-picked requested slot an
                    // invalid (cross-counter) pair - clear it rather than
                    // silently carry a stale, now-mismatched selection.
                    setRequestedSlotId('');
                  }}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                >
                  <option value="">Kies een dienst</option>
                  {assignments.map((a) => (
                    <option key={a.slot_id} value={a.slot_id}>
                      {formatDatum(a.datum)} - {shiftTypeNames[a.teller]}
                    </option>
                  ))}
                </select>
              </div>

              {/* Requested Slot */}
              <div>
                <label className="block text-sm font-semibold text-neutral-900 mb-2">
                  Dienst die je wilt (van iemand anders)
                </label>
                <select
                  name="requested-slot"
                  value={requestedSlotId}
                  onChange={(e) => setRequestedSlotId(e.target.value)}
                  disabled={!offeredSlotId || candidatesLoading}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                >
                  <option value="">{candidatesLoading ? 'Collega\'s laden…' : 'Kies een dienst'}</option>
                  {offeredSlotId && !candidatesLoading && candidates?.length === 0 && (
                    <option value="" disabled>
                      Geen andere {shiftTypeNames[offeredTeller ?? '']}diensten beschikbaar
                    </option>
                  )}
                  {groupedCandidates.map(([category, list]) => (
                    <optgroup key={category} label={`${CATEGORY_LABELS[category]} (${list.length})`}>
                      {list.map((c) => (
                        <option key={c.slot_id} value={c.slot_id} disabled={c.al_gevraagd}>
                          {c.codenaam}: {formatDatum(c.datum)} - {shiftTypeNames[c.teller]}
                          {c.al_gevraagd
                            ? ' (al gevraagd, wacht op antwoord)'
                            : c.requester_te_dichtbij
                              ? ' (jij hebt dan twee diensten kort op elkaar)'
                              : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="text-xs text-neutral-500 mt-1">
                  {offeredSlotId
                    ? `Je collega krijgt jouw dienst op ${formatDatum(getOfferedSlot()?.datum ?? '')}. De groepen laten zien hoe collega's tegenover die dag staan: bovenaan staan wie de meeste kans geven op een "ja". Je kunt alleen ruilen met hetzelfde diensttype (${shiftTypeNames[offeredTeller ?? '']}).`
                    : 'Kies eerst een dienst die je aanbiedt'}
                </p>
                {offeredSlotId && (
                  <p className="text-xs text-neutral-500 mt-1">
                    Je kunt dezelfde dienst aan meerdere collega&apos;s aanbieden. Wie het eerst goedkeurt,
                    ruilt met je. Je andere verzoeken voor deze dienst worden dan vanzelf ingetrokken.
                  </p>
                )}
              </div>

              {/* Preview */}
              {getOfferedSlot() && getRequestedSlot() && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="font-semibold text-sm text-blue-900 mb-2">Voorbeeld van de ruil</h3>
                  <div className="space-y-1 text-sm text-blue-800">
                    <p>
                      Je biedt aan: <span className="font-semibold">{getOfferedSlot() && formatDatum(getOfferedSlot()!.datum)}</span>
                    </p>
                    <p>
                      Je ontvangt: <span className="font-semibold">{getRequestedSlot() && formatDatum(getRequestedSlot()!.datum)}</span>
                    </p>
                    <p>
                      Van: <span className="font-semibold">{getRequestedSlot()!.codenaam}</span>
                    </p>
                  </div>
                  {getRequestedSlot()!.requester_te_dichtbij && (
                    <p className="text-sm text-amber-800 mt-2">
                      ⚠️ Na deze ruil heb je zelf twee diensten kort op elkaar. Dat mag, als je dat zelf wilt.
                    </p>
                  )}
                  {['GEBLOKKEERD', 'LIEVER_NIET', 'KORT_OP_ELKAAR'].includes(getRequestedSlot()!.category) && (
                    <p className="text-sm text-amber-800 mt-2">
                      ⚠️ {getRequestedSlot()!.codenaam}{' '}
                      {getRequestedSlot()!.category === 'GEBLOKKEERD'
                        ? 'heeft die dag geblokkeerd'
                        : getRequestedSlot()!.category === 'LIEVER_NIET'
                          ? 'werkt die dag liever niet'
                          : 'heeft dan twee diensten kort op elkaar'}
                      . Het verzoek kan wel, maar de kans op een "ja" is kleiner.
                    </p>
                  )}
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-sm font-semibold text-neutral-900 mb-2">
                  Opmerking (optioneel)
                </label>
                <textarea
                  name="notes"
                  maxLength={1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Waarom wil je deze ruil? (optioneel)"
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
        <div className="border-t p-6 flex gap-3 flex-shrink-0">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
          >
            Annuleren
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !offeredSlotId || !requestedSlotId || loading}
            className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
          >
            {submitting ? 'Versturen...' : 'Verzoek versturen'}
          </button>
        </div>
      </div>
    </div>
  );
}

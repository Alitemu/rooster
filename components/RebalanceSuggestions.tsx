/**
 * "Voorstellen voor herverdeling" - suggested manual reassignments that
 * would bring people currently over their streefbereik back within it, by
 * moving a dienst to someone who still has room. Never applies anything
 * itself: accepting a suggestion is a normal reassign, so warnings (a
 * liever-niet day, a broken vensterblok) and the published-period reason
 * requirement work exactly like they already do in the assignments grid.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

interface Suggestion {
  assignment_id: string;
  slot_id: string;
  datum: string;
  teller: 'AVOND' | 'WEEKEND' | 'FEESTDAG';
  from_person_id: string;
  from_codenaam: string;
  from_count: number;
  from_max: number;
  to_person_id: string;
  to_codenaam: string;
  to_count: number;
  to_max: number;
  category: 'BESCHIKBAAR' | 'VOORKEUR' | 'LIEVER_NIET' | 'VENSTERBLOK';
  warning: string | null;
}

const TELLER_LABEL: Record<Suggestion['teller'], string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

interface Props {
  periodId: string;
  isPublished: boolean;
  onApplied?: () => void;
}

export function RebalanceSuggestions({ periodId, isPublished, onApplied }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ assignmentId: string; message: string } | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/planner/period/${periodId}/rebalance-suggestions`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Laden van voorstellen mislukt');
      setSuggestions(data.data || []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Laden van voorstellen mislukt');
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApply = async (suggestion: Suggestion) => {
    const reason = (reasonById[suggestion.assignment_id] || '').trim();
    setApplyingId(suggestion.assignment_id);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/planner/period/${periodId}/assignments/${suggestion.assignment_id}/reassign`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: suggestion.to_person_id, reason: reason || null }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Toepassen mislukt');
      }
      // Accepting one suggestion changes who still has room, so the rest of
      // the list can genuinely no longer be accurate - reload rather than
      // just removing this one row.
      await load();
      onApplied?.();
    } catch (err) {
      setActionError({
        assignmentId: suggestion.assignment_id,
        message: err instanceof Error ? err.message : 'Toepassen mislukt',
      });
    } finally {
      setApplyingId(null);
    }
  };

  if (loading) {
    return (
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-2">Voorstellen voor herverdeling</h3>
        <p className="text-sm text-neutral-600">Voorstellen laden...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-2">Voorstellen voor herverdeling</h3>
        <p className="text-sm text-red-700">{loadError}</p>
      </div>
    );
  }

  if (!suggestions || suggestions.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-2">Voorstellen voor herverdeling</h3>
        <p className="text-sm text-neutral-600">
          Geen voorstellen op dit moment - niemand zit boven zijn streefbereik, of er is niemand
          met ruimte om een dienst over te nemen.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6">
      <h3 className="font-bold text-lg mb-1">Voorstellen voor herverdeling</h3>
      <p className="text-xs text-neutral-500 mb-4">
        Diensten die verschoven kunnen worden naar iemand met nog ruimte in zijn streefbereik.
        Niets wordt automatisch aangepast - controleer elk voorstel en pas toe wat je wilt
        overnemen.
      </p>
      <div className="space-y-3">
        {suggestions.map((s) => (
          <div key={s.assignment_id} className="border rounded p-3">
            <p className="text-sm">
              Verschuif de {TELLER_LABEL[s.teller]} op <span className="font-medium">{s.datum}</span> van{' '}
              <span className="font-medium">{s.from_codenaam}</span> ({s.from_count} van {s.from_max}, 1
              boven bereik) naar <span className="font-medium">{s.to_codenaam}</span> ({s.to_count} van{' '}
              {s.to_max}).
            </p>
            {s.warning && <p className="text-xs text-amber-700 mt-1">{s.warning}</p>}
            {actionError?.assignmentId === s.assignment_id && (
              <p className="text-xs text-red-700 mt-1">{actionError.message}</p>
            )}
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={reasonById[s.assignment_id] || ''}
                onChange={(e) =>
                  setReasonById({ ...reasonById, [s.assignment_id]: e.target.value })
                }
                placeholder={isPublished ? 'Reden (verplicht)' : 'Reden (optioneel)'}
                className="flex-1 px-2 py-1 border rounded text-sm"
              />
              <button
                onClick={() => handleApply(s)}
                disabled={
                  applyingId === s.assignment_id ||
                  (isPublished && !(reasonById[s.assignment_id] || '').trim())
                }
                className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors shrink-0"
              >
                {applyingId === s.assignment_id ? 'Bezig...' : 'Toepassen'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

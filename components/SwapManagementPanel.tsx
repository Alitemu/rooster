'use client';

/**
 * Swap Management Panel
 *
 * Display pending swap requests for planner or staff member.
 * Shows requests where user is requester or respondent.
 */

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { RuilHerinnering } from '@/components/RuilHerinnering';

/** "di 5 jan 2027": a stored YYYY-MM-DD as people read it. */
function datumTekst(datum: string): string {
  // Noon, so no timezone can move it to the day before.
  return new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

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
  opmerkingen: string | null;
  reden_afwijzing: string | null;
  laatste_herinnering_op: string | null;
  laatste_herinnering_door: string | null;
  // Only ever true for a request still waiting - see the list route.
  aanvrager_te_dichtbij?: boolean;
  respondent_te_dichtbij?: boolean;
}

interface Props {
  personId: string;
  periodId: string;
  /**
   * Bumped by the parent after this person submits a new request. The
   * panel stays mounted while it's open, so without this a request you
   * had just made only showed up after reloading the whole page.
   */
  refreshKey?: number;
  /**
   * Called when a swap involving this person has changed - approved here,
   * or found changed by a background refresh (the other side acted). An
   * approved swap moves shifts, so the parent reloads the roster itself.
   */
  onSwapsChanged?: () => void;
}

const FILTER_STATUSSEN = [
  ['PENDING', 'In afwachting'],
  ['GOEDGEKEURD', 'Goedgekeurd'],
  ['AFGEWEZEN', 'Afgewezen'],
  ['INGETROKKEN', 'Ingetrokken'],
] as const;

/** One category of requests (sent or received) with its own status filter, the number behind every option. */
function Categorie({
  titel,
  testid,
  naam,
  alle,
  filter,
  setFilter,
  kaart,
  leeg,
}: {
  titel: string;
  testid: string;
  naam: string;
  alle: SwapRequest[];
  filter: string;
  setFilter: (value: string) => void;
  kaart: (swap: SwapRequest) => ReactNode;
  leeg: string;
}) {
  const zichtbaar = filter ? alle.filter((s) => s.status === filter) : alle;
  return (
    <section className="space-y-3" data-testid={testid}>
      <h3 className="text-lg font-semibold">{titel}</h3>
      <div className="card p-4 bg-neutral-50">
        <select
          name={naam}
          aria-label={`Filter op status: ${titel}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-2 border rounded text-sm"
        >
          <option value="">Alle statussen ({alle.length})</option>
          {FILTER_STATUSSEN.map(([waarde, label]) => (
            <option key={waarde} value={waarde}>
              {label} ({alle.filter((s) => s.status === waarde).length})
            </option>
          ))}
        </select>
      </div>
      {zichtbaar.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-neutral-600">{alle.length === 0 ? leeg : 'Geen ruilverzoeken met deze status.'}</p>
        </div>
      ) : (
        <div className="space-y-3">{zichtbaar.map((swap) => kaart(swap))}</div>
      )}
    </section>
  );
}

export function SwapManagementPanel({ personId, periodId, refreshKey = 0, onSwapsChanged }: Props) {
  // What the last load returned, to notice a background refresh bringing
  // back something different (see onSwapsChanged).
  const lastSignature = useRef<string | null>(null);
  const [swapRequests, setSwapRequests] = useState<SwapRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Separate from `error` (the initial-load failure, which replaces the
  // whole panel below) - an approve/reject/cancel failure must not hide
  // the filter and the rest of the list, just report itself.
  const [actionError, setActionError] = useState<string | null>(null);
  // One filter per category: "Jouw ruilverzoeken" (sent) and "Ontvangen ruilverzoeken" (received).
  const [filterVerzonden, setFilterVerzonden] = useState('PENDING');
  const [filterOntvangen, setFilterOntvangen] = useState('PENDING');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // Bumped after a reminder, so the card shows when it went.
  const [herlaad, setHerlaad] = useState(0);

  useEffect(() => {
    // Same reason as NotificationCenter's list: changing the status filter
    // re-runs this while the previous request may still be on its way, and
    // an older reply landing last would show one filter's results under
    // another filter's button.
    let current = true;

    // `silent` for the background refreshes below: keep the list on screen
    // instead of flashing "laden" (and making the page jump) every time.
    const loadSwaps = async (silent = false) => {
      if (!silent) setLoading(true);
      if (!silent) setError(null);

      try {
        // All of them: the counts behind the filters need every status.
        const url = withBasePath(`/api/person/${personId}/swap-requests?period_id=${periodId}`);

        const res = await fetch(url);
        if (!res.ok) throw new Error('Laden van ruilverzoeken mislukt');

        const data = await res.json();
        if (!current) return;
        const list = data.data.swap_requests as Array<{ id: string; status: string }>;
        const signature = list.map((s) => `${s.id}:${s.status}`).join('|');
        if (silent && lastSignature.current !== null && signature !== lastSignature.current) {
          onSwapsChanged?.();
        }
        lastSignature.current = signature;
        setSwapRequests(data.data.swap_requests);
      } catch (err) {
        if (!current) return;
        setError(err instanceof Error ? err.message : 'Laden van ruilverzoeken mislukt');
      } finally {
        if (current) setLoading(false);
      }
    };

    loadSwaps();

    // The other side of a swap acts somewhere else: a colleague approving
    // or rejecting your request never touched this page, so the list kept
    // showing it as "In afwachting" until a full reload. Refresh when you
    // come back to the tab, and every 20 seconds while it's visible.
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') loadSwaps(true);
    };
    const interval = setInterval(refreshIfVisible, 20_000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    window.addEventListener('focus', refreshIfVisible);
    return () => {
      current = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('focus', refreshIfVisible);
    };
  }, [personId, periodId, refreshKey, herlaad]);

  // A new request is always "in afwachting" - switch to that filter so it
  // is actually in the list you're looking at, whichever one was chosen.
  useEffect(() => {
    if (refreshKey > 0) setFilterVerzonden('PENDING');
  }, [refreshKey]);

  const showSuccess = (message: string) => {
    setSuccessMessage(message);
    setTimeout(() => setSuccessMessage(null), 5000);
  };

  // Updates the swap's status in place: the lists filter on it themselves,
  // so a swap whose new status no longer matches a filter leaves that list
  // as a fresh reload would show it, and the counts behind the filters follow.
  const updateSwapStatus = (swapId: string, newStatus: string) => {
    setSwapRequests((prev) => prev.map((s) => (s.id === swapId ? { ...s, status: newStatus } : s)));
  };

  const handleApprove = async (swapId: string) => {
    setActionError(null);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/swap-requests/${swapId}/approve`), {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Goedkeuren van ruil mislukt');
      }

      const data = await res.json().catch(() => null);
      // Approving closes every other open request on either shift, the
      // approver's own offers of the shift they just gave away included.
      const afgesloten = (data?.data?.afgesloten ?? []) as Array<{ id: string; status: string }>;
      const eigen = afgesloten.filter((a) =>
        swapRequests.some((s) => s.id === a.id && s.aanvrager_person_id === personId)
      ).length;
      updateSwapStatus(swapId, 'GOEDGEKEURD');
      afgesloten.forEach((a) => updateSwapStatus(a.id, a.status));
      showSuccess(
        eigen === 0
          ? 'Ruil goedgekeurd'
          : eigen === 1
            ? 'Ruil goedgekeurd. Je eigen ruilverzoek voor die dienst is ingetrokken.'
            : `Ruil goedgekeurd. Je ${eigen} eigen ruilverzoeken voor die dienst zijn ingetrokken.`
      );
      // The two shifts just changed hands - the roster above must show it.
      onSwapsChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Goedkeuren van ruil mislukt');
    }
  };

  const handleReject = async (swapId: string, reason?: string) => {
    setActionError(null);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/swap-requests/${swapId}/reject`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Afwijzen van ruil mislukt');
      }

      updateSwapStatus(swapId, 'AFGEWEZEN');
      setRejectingId(null);
      setRejectionReason('');
      showSuccess('Ruil afgewezen');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Afwijzen van ruil mislukt');
    }
  };

  const handleCancel = async (swapId: string) => {
    setActionError(null);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/swap-requests/${swapId}/cancel`), {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Intrekken van ruilverzoek mislukt');
      }

      updateSwapStatus(swapId, 'INGETROKKEN');
      showSuccess('Ruilverzoek ingetrokken');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Intrekken van ruilverzoek mislukt');
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
    PENDING: 'In afwachting',
    GOEDGEKEURD: 'Goedgekeurd',
    AFGEWEZEN: 'Afgewezen',
    INGETROKKEN: 'Ingetrokken',
  };

  const kaart = (swap: SwapRequest) => {
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
                        {datumTekst(swap.aangeboden_datum)} ({shiftTypeNames[swap.aangeboden_type]})
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-600">Gevraagd:</span>
                      <span className="font-medium">
                        {datumTekst(swap.gevraagde_datum)} ({shiftTypeNames[swap.gevraagde_type]})
                      </span>
                    </div>
                  </div>

                  {swap.opmerkingen && (
                    <p className="text-sm text-neutral-700 italic mb-2">
                      &ldquo;{swap.opmerkingen}&rdquo;
                    </p>
                  )}

                  {swap.status === 'PENDING' &&
                    ((swap.respondent_person_id === personId && swap.respondent_te_dichtbij) ||
                      (swap.aanvrager_person_id === personId && swap.aanvrager_te_dichtbij)) && (
                      <p className="text-sm text-amber-800 mb-2">
                        ⚠️ Na deze ruil heb je twee diensten kort op elkaar (binnen het venster tussen
                        diensten). Dat mag, als je dat zelf wilt.
                      </p>
                    )}

                  {swap.reden_afwijzing && (
                    <p className="text-sm text-neutral-700 mb-2">
                      Reden van afwijzen: &ldquo;{swap.reden_afwijzing}&rdquo;
                    </p>
                  )}

                  <p className="text-xs text-neutral-500">
                    {new Date(swap.aangemaakt_op).toLocaleDateString('nl-NL')}
                  </p>

                  {isPending && isRequester && (
                    <RuilHerinnering
                      stuur={() => fetch(withBasePath(`/api/person/${personId}/swap-requests/${swap.id}/remind`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bevestigd: true }) })}
                      laatste={swap.laatste_herinnering_op}
                      door={swap.laatste_herinnering_door}
                      eigen
                      onKlaar={() => setHerlaad((n) => n + 1)}
                    />
                  )}
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
                      Afwijzen
                    </button>
                  </div>
                )}
                {isPending && isRequester && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleCancel(swap.id)}
                      className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
                    >
                      Intrekken
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
                    maxLength={1000}
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
                      Afwijzen
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

      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start justify-between gap-3">
          <p className="text-sm text-red-700">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="shrink-0 px-3 py-1 rounded border border-red-300 bg-white text-red-700 text-sm font-medium hover:bg-red-100"
          >
            Sluiten
          </button>
        </div>
      )}

      <Categorie
        titel="Jouw ruilverzoeken"
        testid="swap-verzonden"
        naam="status-filter-verzonden"
        alle={swapRequests.filter((s) => s.aanvrager_person_id === personId)}
        filter={filterVerzonden}
        setFilter={setFilterVerzonden}
        kaart={kaart}
        leeg="Je hebt geen ruilverzoeken gedaan."
      />
      <Categorie
        titel="Ontvangen ruilverzoeken"
        testid="swap-ontvangen"
        naam="status-filter-ontvangen"
        alle={swapRequests.filter((s) => s.respondent_person_id === personId)}
        filter={filterOntvangen}
        setFilter={setFilterOntvangen}
        kaart={kaart}
        leeg="Je hebt geen ruilverzoeken ontvangen."
      />
    </div>
  );
}

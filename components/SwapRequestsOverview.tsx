'use client';

/**
 * Swap Requests Overview ("Ruilverzoeken") Component
 *
 * The planner's read-only view of every swap request in this period, the
 * fourth view under Dienstrooster next to Lijst, Kalender and Dienstdoende.
 * Swaps are agreed between participants themselves (see
 * SwapManagementPanel), so without this a planner had no way to see which
 * requests were still waiting, which were declined and why, or whether the
 * colleague had even read the request yet.
 */

import { useState, useEffect } from 'react';
import { swapStatusLabel } from '@/lib/statusLabels';

interface SwapRequestRow {
  id: string;
  status: 'PENDING' | 'GOEDGEKEURD' | 'AFGEWEZEN' | 'INGETROKKEN';
  aangemaakt_op: string;
  beantwoord_op: string | null;
  aanvrager_codenaam: string;
  respondent_codenaam: string;
  aangeboden_datum: string;
  aangeboden_teller: string;
  gevraagde_datum: string;
  gevraagde_teller: string;
  opmerkingen: string | null;
  reden_afwijzing: string | null;
  gelezen: boolean | null;
}

interface Props {
  periodId: string;
}

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  GOEDGEKEURD: 'bg-green-100 text-green-800',
  AFGEWEZEN: 'bg-red-100 text-red-800',
  INGETROKKEN: 'bg-neutral-100 text-neutral-700',
};

const formatDatum = (datum: string) =>
  new Date(`${datum}T00:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

// Older rows were stored with a date only, newer ones with a full
// timestamp - show the time only when there is one.
const formatMoment = (value: string) =>
  value.length > 10
    ? new Date(value).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : new Date(`${value}T00:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function SwapRequestsOverview({ periodId }: Props) {
  const [requests, setRequests] = useState<SwapRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/planner/period/${periodId}/swap-requests`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Laden van ruilverzoeken mislukt');
        }
        if (!cancelled) setRequests(data.data.swap_requests);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Laden van ruilverzoeken mislukt');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [periodId]);

  if (loading) return <div className="p-4 text-center text-neutral-600">Ruilverzoeken laden...</div>;
  if (error) return <div className="p-4 text-center text-red-600">{error}</div>;

  const visible = statusFilter ? requests.filter((r) => r.status === statusFilter) : requests;
  const pendingCount = requests.filter((r) => r.status === 'PENDING').length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600">
        Ruilverzoeken die medewerkers onderling hebben gedaan. De collega die het verzoek krijgt, keurt het zelf goed
        of wijst het af. Je ziet hier ook of die collega de melding over het verzoek al heeft gelezen.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 border rounded text-sm"
          aria-label="Filter op status"
        >
          <option value="">Alle statussen ({requests.length})</option>
          {(['PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN'] as const).map((s) => (
            <option key={s} value={s}>
              {capitalize(swapStatusLabel(s))} ({requests.filter((r) => r.status === s).length})
            </option>
          ))}
        </select>
        {pendingCount > 0 && (
          <span className="text-sm text-amber-800">
            {pendingCount} {pendingCount === 1 ? 'verzoek wacht' : 'verzoeken wachten'} nog op antwoord
          </span>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-neutral-500 text-center py-6">
          {requests.length === 0 ? 'Er zijn in deze periode nog geen ruilverzoeken gedaan.' : 'Geen ruilverzoeken met deze status.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-neutral-50">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Aangevraagd</th>
                <th className="px-3 py-2 text-left font-semibold">Van</th>
                <th className="px-3 py-2 text-left font-semibold">Aan</th>
                <th className="px-3 py-2 text-left font-semibold">Ruil</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Gelezen</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-neutral-600">{formatMoment(r.aangemaakt_op)}</td>
                  <td className="px-3 py-2 font-medium">{r.aanvrager_codenaam}</td>
                  <td className="px-3 py-2 font-medium">{r.respondent_codenaam}</td>
                  <td className="px-3 py-2">
                    <div>
                      Geeft {TELLER_LABELS[r.aangeboden_teller] ?? r.aangeboden_teller} van{' '}
                      {formatDatum(r.aangeboden_datum)}
                    </div>
                    <div>
                      Krijgt {TELLER_LABELS[r.gevraagde_teller] ?? r.gevraagde_teller} van {formatDatum(r.gevraagde_datum)}
                    </div>
                    {r.opmerkingen && <div className="text-xs text-neutral-600 italic mt-1">&ldquo;{r.opmerkingen}&rdquo;</div>}
                    {r.reden_afwijzing && (
                      <div className="text-xs text-red-700 mt-1">Reden van afwijzen: &ldquo;{r.reden_afwijzing}&rdquo;</div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[r.status] ?? ''}`}>
                      {capitalize(swapStatusLabel(r.status))}
                    </span>
                    {r.beantwoord_op && (
                      <div className="text-xs text-neutral-500 mt-1">op {formatMoment(r.beantwoord_op)}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.gelezen === null ? (
                      <span className="text-neutral-400" title="Dit verzoek is gedaan voordat dit werd bijgehouden">
                        Onbekend
                      </span>
                    ) : r.gelezen ? (
                      <span className="text-green-700">✓ Gelezen</span>
                    ) : (
                      <span className="text-amber-700">Nog niet gelezen</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

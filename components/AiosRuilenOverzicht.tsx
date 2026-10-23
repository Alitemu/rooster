'use client';

/**
 * The swaps of an AIOS period for the planner (lib/aiosRuilen.ts): who
 * asked whom, what for what, how it stands, whether the colleague has
 * opened their requests, and when the last reminder went, with a button to
 * send one. The AIOS swap without the planner (L1, L2); the Roosterbureau is
 * mailed when one goes through, with the planner in the CC. The tab
 * Ruilverzoeken of the section Dienstrooster (components/AiosDienstrooster.tsx);
 * before the roster is definitief it is there and empty.
 *
 * The same table as the achterwacht's (components/SwapRequestsOverview.tsx),
 * a copy of it for the AIOS's own words and routes.
 */

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosRuilHerinnering } from '@/components/AiosRuilHerinnering';
import type { EenheidUit, RuilStatus, RuilUit } from '@/lib/aiosRuilen';
import { foutTekst } from '@/lib/aiosFoutTekst';

const kort = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const wat = (e: EenheidUit) => (e.van === e.tot ? `${e.naam}, ${kort(e.van)}` : `${e.naam}, ${kort(e.van)} t/m ${kort(e.tot)}`);

const STATUSSEN: Array<[RuilStatus, string]> = [
  ['IN_BEHANDELING', 'In afwachting'],
  ['GOEDGEKEURD', 'Goedgekeurd'],
  ['AFGEWEZEN', 'Afgewezen'],
  ['INGETROKKEN', 'Ingetrokken'],
];
const STATUS_STIJL: Record<RuilStatus, string> = {
  IN_BEHANDELING: 'bg-amber-100 text-amber-800',
  GOEDGEKEURD: 'bg-green-100 text-green-800',
  AFGEWEZEN: 'bg-red-100 text-red-800',
  INGETROKKEN: 'bg-neutral-100 text-neutral-700',
};
const STATUS_LABEL = Object.fromEntries(STATUSSEN) as Record<RuilStatus, string>;

const moment = (iso: string) => new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function AiosRuilenOverzicht({ periodId, gepubliceerd }: { periodId: string; gepubliceerd: boolean }) {
  const [ruilen, setRuilen] = useState<RuilUit[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Bumped after a reminder, so the list shows when it went.
  const [vers, setVers] = useState(0);

  useEffect(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/ruilen`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden is mislukt');
        setRuilen(data.data);
      })
      .catch((err) => setFout(foutTekst(err, 'Laden is mislukt')));
  }, [periodId, vers]);

  const zichtbaar = ruilen ? (filter ? ruilen.filter((r) => r.status === filter) : ruilen) : [];
  const wachten = ruilen ? ruilen.filter((r) => r.status === 'IN_BEHANDELING').length : 0;

  return (
    <div className="space-y-4" data-testid="aios-ruilen-overzicht">
      <p className="text-sm text-neutral-700">
        De AIOS ruilen onderling, zonder jou. De collega die het verzoek krijgt keurt het goed of wijst het af. Je ziet hier ook of die collega zijn of
        haar verzoeken al heeft geopend. Gaat een ruil door, dan krijgt het Roosterbureau een bericht, met jou en de twee AIOS in de CC.
      </p>
      {!gepubliceerd && <p className="text-sm text-neutral-600">Ruilen kan pas als het rooster definitief is.</p>}
      {fout && (
        <p role="alert" className="text-sm text-red-700">
          {fout}
        </p>
      )}
      {ruilen && (
        <div className="flex items-center gap-3 flex-wrap">
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="px-3 py-2 border rounded text-sm" aria-label="Filter op status">
            <option value="">Alle statussen ({ruilen.length})</option>
            {STATUSSEN.map(([waarde, label]) => (
              <option key={waarde} value={waarde}>
                {label} ({ruilen.filter((r) => r.status === waarde).length})
              </option>
            ))}
          </select>
          {wachten > 0 && (
            <span className="text-sm text-amber-800">
              {wachten} {wachten === 1 ? 'verzoek wacht' : 'verzoeken wachten'} nog op antwoord
            </span>
          )}
        </div>
      )}
      {ruilen && zichtbaar.length === 0 && (
        <p className="text-sm text-neutral-500 text-center py-6">{ruilen.length === 0 ? 'Er zijn nog geen ruilverzoeken gedaan.' : 'Geen ruilverzoeken met deze status.'}</p>
      )}
      {zichtbaar.length > 0 && (
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
              {zichtbaar.map((r) => (
                <tr key={r.id} className="align-top" data-testid="aios-ruil-rij" data-status={r.status}>
                  <td className="px-3 py-2 whitespace-nowrap text-neutral-600">{moment(r.aangemaakt_op)}</td>
                  <td className="px-3 py-2 font-medium">{r.aanvrager}</td>
                  <td className="px-3 py-2 font-medium">{r.respondent}</td>
                  <td className="px-3 py-2">
                    <div>Geeft {wat(r.aangeboden)}</div>
                    <div>Krijgt {wat(r.gevraagd)}</div>
                    {r.toelichting && <div className="text-xs text-neutral-600 italic mt-1">&ldquo;{r.toelichting}&rdquo;</div>}
                    {r.reden_afwijzing && (
                      <div className="text-xs text-red-700 mt-1">
                        {r.status === 'AFGEWEZEN' ? 'Reden van afwijzen' : 'Reden'}: &ldquo;{r.reden_afwijzing}&rdquo;
                      </div>
                    )}
                    {r.status === 'IN_BEHANDELING' && (
                      <AiosRuilHerinnering
                        stuur={() => fetch(withBasePath(`/api/aios/periode/${periodId}/ruilen/${r.id}/herinneren`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bevestigd: true }) })}
                        laatste={r.laatste_herinnering_op}
                        door={r.laatste_herinnering_door}
                        eigen={false}
                        onKlaar={() => setVers((v) => v + 1)}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${STATUS_STIJL[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    {r.beantwoord_op && <div className="text-xs text-neutral-500 mt-1">op {moment(r.beantwoord_op)}</div>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.gezien_op || r.status === 'GOEDGEKEURD' || r.status === 'AFGEWEZEN' ? (
                      <span className="text-green-700">✓ Gelezen{r.gezien_op ? ` (${moment(r.gezien_op)})` : ''}</span>
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

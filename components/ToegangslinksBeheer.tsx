'use client';

/**
 * "Persoonlijke links" on the achterwacht's period page, for the beheerder
 * only: which personal links were issued for the period, when each was made
 * and last used, and a button to revoke one (lib/toegangslinks.ts). The
 * link itself is never shown: only its hash is stored.
 *
 * The AIOS has a copy on its own routes (components/AiosToegangslinks.tsx,
 * docs/development/diensten.md "Copied, not changed").
 */

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { foutTekst } from '@/lib/foutTekst';

interface Link {
  id: string;
  person_id: string;
  codenaam: string;
  aangemaakt_op: string;
  laatst_gebruikt_op: string | null;
  ingetrokken_op: string | null;
  werkende_links: number;
}

function moment(iso: string): string {
  return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ToegangslinksBeheer({ periodId }: { periodId: string }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  // The link that asks "weet je het zeker?", and the one being revoked.
  const [vraagOp, setVraagOp] = useState<string | null>(null);
  const [bezig, setBezig] = useState<string | null>(null);

  const laad = useCallback(async () => {
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/toegangslinks`));
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Laden van de links is mislukt');
      setLinks(data.data);
      setFout(null);
    } catch (err) {
      setFout(foutTekst(err, 'Laden van de links is mislukt'));
    }
  }, [periodId]);

  useEffect(() => {
    laad();
  }, [laad]);

  const trekIn = async (link: Link) => {
    setBezig(link.id);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/toegangslinks/${link.id}/intrekken`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Intrekken is mislukt');
      setMelding(`De link van ${link.codenaam} is ingetrokken. ${link.codenaam} is overal uitgelogd.`);
      setVraagOp(null);
      await laad();
    } catch (err) {
      setFout(foutTekst(err, 'Intrekken is mislukt'));
    } finally {
      setBezig(null);
    }
  };

  return (
    <div data-testid="toegangslinks">
      <p className="text-sm text-neutral-600 mb-3">
        Dit zijn de persoonlijke links die voor deze periode zijn uitgegeven. De link zelf is hier niet te zien. Een
        ingetrokken link werkt niet meer en wie er via binnenkwam, is meteen uitgelogd. Alleen de beheerder ziet dit.
        Een medewerker met een andere werkende link komt daar weer mee binnen.
      </p>
      {fout && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {fout}
        </p>
      )}
      {melding && (
        <p role="status" className="mb-3 text-sm text-green-800">
          {melding}
        </p>
      )}
      {!links && !fout && <p className="text-sm text-neutral-600">Links laden...</p>}
      {links && links.length === 0 && <p className="text-sm text-neutral-600">Voor deze periode zijn nog geen persoonlijke links uitgegeven.</p>}
      {links && links.length > 0 && (
        <ul className="divide-y divide-neutral-100">
          {links.map((link) => {
            const werkt = link.ingetrokken_op === null;
            return (
              <li key={link.id} data-testid="toegangslink" className="py-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className={`font-medium ${werkt ? 'text-neutral-900' : 'text-neutral-500 line-through'}`}>{link.codenaam}</p>
                  <p className="text-sm text-neutral-600">
                    Gemaakt op {moment(link.aangemaakt_op)}.{' '}
                    {link.laatst_gebruikt_op ? `Voor het laatst gebruikt op ${moment(link.laatst_gebruikt_op)}.` : 'Nog niet gebruikt.'}
                  </p>
                  <p className="text-sm font-medium text-neutral-800">
                    {werkt ? 'Werkt' : `Ingetrokken op ${moment(link.ingetrokken_op!)}`}
                  </p>
                </div>
                {werkt && vraagOp !== link.id && (
                  <button
                    type="button"
                    onClick={() => setVraagOp(link.id)}
                    className="px-3 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
                    aria-label={`Link van ${link.codenaam} intrekken`}
                  >
                    Intrekken
                  </button>
                )}
                {werkt && vraagOp === link.id && (
                  <div role="alertdialog" aria-label={`Link van ${link.codenaam} intrekken`} className="w-full sm:w-auto sm:max-w-sm p-3 rounded border border-amber-300 bg-amber-50 text-sm">
                    <p className="mb-2 text-amber-900">
                      Weet je zeker dat je deze link van {link.codenaam} wilt intrekken? {link.codenaam} wordt overal uitgelogd.
                      {link.werkende_links <= 1 && ` Dit is de enige werkende link van ${link.codenaam}. Daarna komt ${link.codenaam} er pas weer in met een nieuwe link.`}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => trekIn(link)}
                        disabled={bezig === link.id}
                        className="px-3 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                      >
                        Ja, intrekken
                      </button>
                      <button
                        type="button"
                        onClick={() => setVraagOp(null)}
                        disabled={bezig === link.id}
                        className="px-3 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 transition-colors"
                      >
                        Annuleren
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

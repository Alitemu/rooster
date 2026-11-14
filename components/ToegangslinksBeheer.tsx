'use client';

/**
 * "Persoonlijke links" on the achterwacht's period page, for the beheerder
 * only: which personal links were issued for the period, when each was made
 * and last used, a button to revoke one, all links of one person at once
 * (1.3.0) or every link of the period (lib/toegangslinks.ts). The
 * link itself is never shown: only its hash is stored.
 *
 * The AIOS has a copy on its own routes (components/AiosToegangslinks.tsx,
 * docs/development/diensten.md "Copied, not changed").
 */

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { telwoord } from '@/lib/telwoord';
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
  // "Alles intrekken" asks first as well.
  const [vraagAlles, setVraagAlles] = useState(false);
  // "Alle links van één medewerker" (audit 1.2.2: 14 links of one person took 14 times "Intrekken").
  const [gekozen, setGekozen] = useState('');
  const [vraagPersoon, setVraagPersoon] = useState(false);

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

  const werkend = (links ?? []).filter((l) => l.ingetrokken_op === null);
  const werkendePersonen = new Set(werkend.map((l) => l.person_id)).size;
  const perPersoon = [
    ...werkend.reduce(
      (m, l) => m.set(l.person_id, { codenaam: l.codenaam, aantal: (m.get(l.person_id)?.aantal ?? 0) + 1 }),
      new Map<string, { codenaam: string; aantal: number }>()
    ),
  ]
    .map(([person_id, v]) => ({ person_id, ...v }))
    .sort((a, b) => a.codenaam.localeCompare(b.codenaam));
  const keuze = perPersoon.find((p) => p.person_id === gekozen) ?? null;

  const trekPersoonIn = async () => {
    if (!keuze) return;
    setBezig('persoon');
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/toegangslinks/persoon/${keuze.person_id}/intrekken`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Intrekken is mislukt');
      const { aantal } = data.data as { aantal: number };
      setMelding(`${aantal === 1 ? `1 link van ${keuze.codenaam} is` : `${aantal} links van ${keuze.codenaam} zijn`} ingetrokken. ${keuze.codenaam} is overal uitgelogd.`);
      setVraagPersoon(false);
      setGekozen('');
      await laad();
    } catch (err) {
      setFout(foutTekst(err, 'Intrekken is mislukt'));
    } finally {
      setBezig(null);
    }
  };

  const trekAllesIn = async () => {
    setBezig('alles');
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/toegangslinks/alles-intrekken`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Intrekken is mislukt');
      const { aantal, personen } = data.data as { aantal: number; personen: number };
      setMelding(`${aantal === 1 ? '1 link is' : `${aantal} links zijn`} ingetrokken. ${telwoord(personen, 'medewerker is', 'medewerkers zijn')} overal uitgelogd.`);
      setVraagAlles(false);
      await laad();
    } catch (err) {
      setFout(foutTekst(err, 'Intrekken is mislukt'));
    } finally {
      setBezig(null);
    }
  };

  return (
    <div data-testid="toegangslinks">
      {werkend.length > 0 && !vraagAlles && !vraagPersoon && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm text-neutral-800">
              <span className="block mb-1">Alle links van één medewerker</span>
              <select
                value={gekozen}
                onChange={(e) => setGekozen(e.target.value)}
                className="px-2 py-2 rounded border border-neutral-300 bg-white text-neutral-900"
              >
                <option value="">Kies een medewerker</option>
                {perPersoon.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {p.codenaam} ({telwoord(p.aantal, 'werkende link', 'werkende links')})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setVraagPersoon(true)}
              disabled={!keuze}
              className="px-3 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 transition-colors"
            >
              Links van medewerker intrekken
            </button>
          </div>
          <button
            type="button"
            onClick={() => setVraagAlles(true)}
            className="px-4 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            Alles intrekken
          </button>
        </div>
      )}
      {vraagPersoon && keuze && (
        <div role="alertdialog" aria-label={`Alle links van ${keuze.codenaam} intrekken`} className="mb-3 p-3 rounded border border-amber-300 bg-amber-50 text-sm">
          <p className="mb-2 text-amber-900">
            Weet je zeker dat je {keuze.aantal === 1 ? 'de werkende link' : `alle ${keuze.aantal} werkende links`} van {keuze.codenaam} voor deze periode wilt
            intrekken? {keuze.codenaam} wordt overal uitgelogd. Links voor andere periodes blijven werken.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={trekPersoonIn}
              disabled={bezig === 'persoon'}
              className="px-3 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              Ja, alles van {keuze.codenaam} intrekken
            </button>
            <button
              type="button"
              onClick={() => setVraagPersoon(false)}
              disabled={bezig === 'persoon'}
              className="px-3 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 transition-colors"
            >
              Annuleren
            </button>
          </div>
        </div>
      )}
      {vraagAlles && (
        <div role="alertdialog" aria-label="Alle links intrekken" className="mb-3 p-3 rounded border border-amber-300 bg-amber-50 text-sm">
          <p className="mb-2 text-amber-900">
            Weet je zeker dat je alle {werkend.length} werkende links van deze periode wilt intrekken? {telwoord(werkendePersonen, 'medewerker wordt', 'medewerkers worden')} overal uitgelogd.
            Wie geen andere werkende link heeft, komt er pas weer in met een nieuwe link.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={trekAllesIn}
              disabled={bezig === 'alles'}
              className="px-3 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
            >
              Ja, alles intrekken
            </button>
            <button
              type="button"
              onClick={() => setVraagAlles(false)}
              disabled={bezig === 'alles'}
              className="px-3 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 transition-colors"
            >
              Annuleren
            </button>
          </div>
        </div>
      )}
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

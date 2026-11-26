/**
 * The AIOS's mail on the period page: whether it can go, and for the
 * beheerder the address of the AIOS's own Power Automate flow. It sits under
 * "Exporteren & communicatie" (components/AiosExporteren.tsx), where the
 * achterwacht's page has its mail settings.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { foutTekst } from '@/lib/aiosFoutTekst';

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

/** The AIOS's mail: whether it can go, and for the beheerder the AIOS's flow mailbox. */
export function AiosMailPaneel({ beheerder, onChanged }: { beheerder: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState<{ ingesteld: boolean; account: boolean; uitgeschakeld: boolean; verzendlijst_aan: string | null; laatste_fout: { melding: string } | null; wachtrij: number } | null>(null);
  const [adres, setAdres] = useState('');
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath('/api/aios/mail-instellingen'))
      .then((res) => antwoord(res, 'Laden van de mailinstellingen is mislukt'))
      .then((data) => {
        setStatus(data);
        setAdres(data.verzendlijst_aan ?? '');
      })
      .catch((err) => setFout(foutTekst(err, 'Laden van de mailinstellingen is mislukt')));
  }, []);
  useEffect(() => {
    laad();
  }, [laad]);

  const opslaan = async () => {
    setBezig(true);
    setFout(null);
    try {
      await antwoord(
        await fetch(withBasePath('/api/aios/mail-instellingen'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ verzendlijst_aan: adres }),
        }),
        'Opslaan is mislukt'
      );
      laad();
      onChanged();
    } catch (err) {
      setFout(foutTekst(err, 'Opslaan is mislukt'));
    } finally {
      setBezig(false);
    }
  };

  if (!status) return fout ? <p className="text-sm text-red-700">{fout}</p> : null;
  return (
    <div className="space-y-2 rounded border border-neutral-200 p-3 text-sm">
      <p className="font-medium text-neutral-900">Mail naar de AIOS</p>
      {status.uitgeschakeld && <p className="text-red-800">Versturen staat uit op deze installatie (MAIL_UITGESCHAKELD).</p>}
      {!status.account && (
        <p className="text-amber-900">
          Het Gmail-account is nog niet ingesteld. Dat doet de beheerder bij Mailinstellingen op de pagina van een periode van
          de achterwacht. Hetzelfde account verstuurt de mail van de AIOS.
        </p>
      )}
      <p className="text-neutral-700">
        De AIOS hebben een eigen Power Automate-stroom met een eigen adressenlijst. Hun verzendlijst gaat naar:{' '}
        <strong>{status.verzendlijst_aan ?? 'nog niet ingesteld'}</strong>
      </p>
      {status.laatste_fout && <p className="text-red-800">Laatste keer mislukt: {status.laatste_fout.melding}</p>}
      {status.wachtrij > 0 && (
        <p className="text-amber-900" data-testid="aios-mail-wachtrij">
          {status.wachtrij} {status.wachtrij === 1 ? 'ruilmail wacht' : 'ruilmails wachten'} tot het versturen weer lukt. Ze gaan vanzelf, elk uur een nieuwe poging.
        </p>
      )}
      {beheerder && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="aios-stroom" className="block text-xs font-medium text-neutral-600 mb-1">
              Verzendlijst van de AIOS sturen naar
            </label>
            <input
              id="aios-stroom"
              type="email"
              autoComplete="off"
              value={adres}
              onChange={(e) => setAdres(e.target.value)}
              placeholder="het adres waar de stroom van de AIOS op let"
              className="w-full px-2 py-1 border rounded text-sm"
            />
          </div>
          <button type="button" onClick={opslaan} disabled={bezig} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {bezig ? 'Bezig...' : 'Opslaan'}
          </button>
        </div>
      )}
      {!beheerder && <p className="text-neutral-600">Alleen de beheerder kan dit adres wijzigen.</p>}
      {fout && <p className="text-red-700">{fout}</p>}
    </div>
  );
}

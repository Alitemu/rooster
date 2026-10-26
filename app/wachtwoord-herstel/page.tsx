/**
 * Choosing a new password with the link mailed to the beheerder
 * (lib/wachtwoordHerstel.ts). The token is after the # of the address, which
 * a browser keeps to itself.
 */

'use client';

import Link from 'next/link';
import { useEffect, useState, FormEvent } from 'react';
import { withBasePath } from '@/lib/basePath';

export default function WachtwoordHerstelPage() {
  const [token, setToken] = useState<string | null>(null);
  const [wachtwoord, setWachtwoord] = useState('');
  const [herhaling, setHerhaling] = useState('');
  const [fout, setFout] = useState<string | null>(null);
  const [bezig, setBezig] = useState(false);
  const [klaar, setKlaar] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '');
  }, []);

  const verstuur = async (e: FormEvent) => {
    e.preventDefault();
    setFout(null);
    if (wachtwoord !== herhaling) {
      setFout('De wachtwoorden komen niet overeen.');
      return;
    }
    setBezig(true);
    try {
      const res = await fetch(withBasePath('/api/auth/wachtwoord-herstel'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, wachtwoord }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setFout(data?.error?.message ?? 'Het instellen is niet gelukt. Probeer het opnieuw.');
        return;
      }
      // Nothing to keep: the address held the token.
      window.history.replaceState(null, '', window.location.pathname);
      setKlaar(true);
    } catch {
      setFout('Geen verbinding met de server. Controleer je netwerk en probeer het opnieuw.');
    } finally {
      setBezig(false);
    }
  };

  if (token === null) return null;

  return (
    <div className="container-main">
      <div className="max-w-sm mx-auto">
        <div className="card card-padding">
          <h1 className="text-xl font-bold text-neutral-900 mb-2">Nieuw wachtwoord instellen</h1>
          {klaar ? (
            <div role="status">
              <p className="text-sm text-neutral-700 mb-4">Je nieuwe wachtwoord is ingesteld. Log in met dit wachtwoord.</p>
              <Link href="/planner/login" className="btn-primary inline-block">
                Naar inloggen
              </Link>
            </div>
          ) : token === '' ? (
            <div role="alert" data-testid="herstel-geen-link">
              <p className="text-sm text-neutral-700 mb-4">
                Deze pagina werkt alleen met de link uit de e-mail. Vraag op de startpagina onder Link kwijt een nieuwe aan met het Gmail-adres.
              </p>
              <Link href="/" className="btn-primary inline-block">
                Naar de startpagina
              </Link>
            </div>
          ) : (
            <form onSubmit={verstuur}>
              <p className="text-sm text-neutral-600 mb-4">
                Kies een wachtwoord van minimaal 8 tekens met kleine letters, hoofdletters, cijfers en een speciaal teken.
              </p>
              <div className="form-group mb-4">
                <label className="label" htmlFor="herstel-wachtwoord">
                  Nieuw wachtwoord
                </label>
                <input
                  id="herstel-wachtwoord"
                  className="input w-full"
                  type="password"
                  autoComplete="new-password"
                  value={wachtwoord}
                  onChange={(e) => setWachtwoord(e.target.value)}
                  required
                />
              </div>
              <div className="form-group mb-4">
                <label className="label" htmlFor="herstel-herhaling">
                  Herhaal het wachtwoord
                </label>
                <input
                  id="herstel-herhaling"
                  className="input w-full"
                  type="password"
                  autoComplete="new-password"
                  value={herhaling}
                  onChange={(e) => setHerhaling(e.target.value)}
                  required
                />
              </div>
              {fout && (
                <p role="alert" data-testid="herstel-fout" className="text-sm text-red-700 mb-4">
                  {fout}
                </p>
              )}
              <button type="submit" className="btn-primary" disabled={bezig}>
                {bezig ? 'Bezig…' : 'Wachtwoord instellen'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

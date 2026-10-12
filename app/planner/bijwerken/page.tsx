'use client';

/**
 * Bijwerken: which version runs, which is released, and the button that
 * goes to it - for an ADMIN (lib/appUpdate.ts, /api/admin/update). The
 * updater container does the work; this page only asks and then follows
 * along while the app restarts underneath it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';

interface Overzicht {
  huidig: string;
  updater_actief: boolean;
  volgt: string | null;
  beschikbaar: string | null;
  richting: 'NIEUWER' | 'OUDER' | null;
  gecontroleerd_op: string | null;
  controle_fout: string | null;
  bezig: { naar: string; stap: string; sinds: string } | null;
  aangevraagd: boolean;
  laatste: { uitkomst: string; reden: string | null; van: string | null; naar: string | null; op: string } | null;
}

const STAP: Record<string, string> = {
  CONTROLEREN: 'Nakijken welke versie is vrijgegeven.',
  OPHALEN: 'De nieuwe versie downloaden.',
  HERSTARTEN: 'Herstarten. De app is zo even niet bereikbaar.',
  TERUGZETTEN: 'De nieuwe versie startte niet goed. Terug naar de vorige versie.',
};

const CONTROLE_FOUT: Record<string, string> = {
  REGISTER_ONBEREIKBAAR:
    'De server kon niet nagaan welke versie is vrijgegeven. Misschien kan hij GitHub op dit moment niet bereiken.',
  NIET_VIA_COMPOSE:
    'De updater is niet goed gestart. Vraag IT om de app te starten met docker compose vanuit de map van de app.',
  GEEN_WEB: 'De updater vindt de app niet. Vraag IT om de server na te kijken.',
};

const POLL_MS = 3000;
// The updater gives up on a version that isn't healthy after 5 minutes and
// then puts the old one back; well past that, something else is wrong.
const TE_LANG_MS = 12 * 60 * 1000;

function tijd(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
}

function laatsteTekst(l: NonNullable<Overzicht['laatste']>): string {
  const naar = l.naar ? `versie ${l.naar}` : 'een nieuwe versie';
  switch (l.uitkomst) {
    case 'GELUKT':
      return l.van ? `Van versie ${l.van} naar ${l.naar} is gelukt.` : `Bijwerken naar ${naar} is gelukt.`;
    case 'TERUGGEZET':
      return `Bijwerken naar ${naar} is mislukt: de nieuwe versie startte niet goed. De server draait weer ${
        l.van ? `versie ${l.van}` : 'de vorige versie'
      }. Er is niets verloren gegaan.`;
    case 'MISLUKT':
      return `Bijwerken naar ${naar} is mislukt en teruggaan naar de vorige versie ook. Vraag IT om de server na te kijken.`;
    default:
      switch (l.reden) {
        case 'OPHALEN':
          return `${naar[0].toUpperCase()}${naar.slice(1)} kon niet worden gedownload. Er is niets veranderd.`;
        case 'ANDERE_VERSIE':
          return 'Intussen was een andere versie vrijgegeven. Er is niets veranderd.';
        case 'ONDERBROKEN':
          return 'Het bijwerken werd onderbroken, bijvoorbeeld door een herstart van de server. Kijk hieronder welke versie nu draait.';
        default:
          return 'Het bijwerken is niet begonnen. Er is niets veranderd.';
      }
  }
}

export default function BijwerkenPage() {
  const [o, setO] = useState<Overzicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bevestigen, setBevestigen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set once this page asked for an update: from then on it follows along.
  // `sinds` is the server's time of the request: the updater's outcome
  // carries the server's clock too, the browser's may be off.
  const [volgen, setVolgen] = useState<{ naar: string; sinds: string } | null>(null);
  const [onbereikbaar, setOnbereikbaar] = useState(false);
  const [nakijken, setNakijken] = useState(false);
  const [teLang, setTeLang] = useState(false);
  const reloaded = useRef(false);

  const load = useCallback(async (): Promise<Overzicht | null> => {
    try {
      const res = await fetch(withBasePath('/api/admin/update'), { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setError('Alleen een beheerder kan de app bijwerken.');
        return null;
      }
      if (!res.ok) throw new Error();
      const data = (await res.json()).data as Overzicht;
      setO(data);
      setOnbereikbaar(false);
      return data;
    } catch {
      setOnbereikbaar(true);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While an update runs (this page asked, or one was already under way
  // when it opened): poll, through the restart, until it is done.
  const loopt = !!volgen || !!o?.bezig || !!o?.aangevraagd;
  useEffect(() => {
    if (!loopt) return;
    const t = setInterval(async () => {
      const d = await load();
      if (!d || !volgen) return;
      // The updater writes whole seconds.
      const klaar = !d.bezig && !d.aangevraagd && d.laatste && Date.parse(d.laatste.op) >= Date.parse(volgen.sinds) - 1000;
      if (klaar && d.laatste!.uitkomst === 'GELUKT' && d.huidig === volgen.naar && !reloaded.current) {
        // The page itself is still the old version's: load the new one.
        reloaded.current = true;
        window.location.reload();
      } else if (klaar) {
        setVolgen(null);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [loopt, volgen, load]);

  useEffect(() => {
    setTeLang(false);
    if (!volgen) return;
    const t = setTimeout(() => setTeLang(true), TE_LANG_MS);
    return () => clearTimeout(t);
  }, [volgen]);

  // Asked to check now: poll until the updater has written a newer check.
  useEffect(() => {
    if (!nakijken) return;
    const voor = o?.gecontroleerd_op ?? '';
    const t = setInterval(async () => {
      const d = await load();
      if (d && (d.gecontroleerd_op ?? '') !== voor) setNakijken(false);
    }, 2000);
    const stop = setTimeout(() => setNakijken(false), 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [nakijken]);

  const checkNow = async () => {
    setError(null);
    const res = await fetch(withBasePath('/api/admin/update/check'), { method: 'POST' }).catch(() => null);
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError(data?.error?.message || 'Nakijken lukte niet.');
      return;
    }
    setNakijken(true);
  };

  const startUpdate = async () => {
    if (!o?.beschikbaar) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath('/api/admin/update'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versie: o.beschikbaar }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || 'Bijwerken kon niet starten.');
      setVolgen({ naar: o.beschikbaar, sinds: data.data.aangevraagd_op });
      setBevestigen(false);
      setO(data.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bijwerken kon niet starten.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!o) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">
          {error ?? (onbereikbaar ? 'De app is op dit moment niet bereikbaar.' : 'Laden...')}
        </div>
      </div>
    );
  }

  const naar = volgen?.naar ?? o.bezig?.naar ?? o.beschikbaar;

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6 space-y-2">
        <Link href="/planner" className="text-sm text-blue-700 hover:underline">
          ← Periodes
        </Link>
        <h1 className="text-2xl font-bold text-neutral-900">Bijwerken</h1>
        <p className="text-sm text-neutral-700">
          Deze server draait versie <strong data-testid="huidige-versie">{o.huidig}</strong>.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}

      {loopt ? (
        <div className="card p-6 space-y-3" data-testid="bijwerken-bezig" aria-live="polite">
          <h2 className="text-lg font-semibold">Bezig met bijwerken naar versie {naar}</h2>
          <p className="text-sm text-neutral-700">
            {onbereikbaar
              ? 'De app herstart. Deze pagina wacht tot hij terug is.'
              : o.bezig
                ? STAP[o.bezig.stap] ?? 'Bezig.'
                : 'Wachten tot de updater begint.'}
          </p>
          <p className="text-sm text-neutral-600">
            Vlak voor het bijwerken is een back-up van de database gemaakt in data/backups/database/.
          </p>
          {volgen && teLang && (
            <p className="text-sm text-red-800">Dit duurt langer dan verwacht. Vraag IT om de server na te kijken.</p>
          )}
        </div>
      ) : !o.updater_actief ? (
        <div className="card p-6 space-y-2" data-testid="updater-uit">
          <h2 className="text-lg font-semibold">Bijwerken vanuit de app staat uit</h2>
          <p className="text-sm text-neutral-700">
            Op deze server draait de updater niet. IT werkt de app dan bij met <code>docker compose pull</code> en{' '}
            <code>docker compose up -d</code>. In de handleiding (README, Bijwerken vanuit de app) staat hoe het aan gaat.
          </p>
        </div>
      ) : (
        <div className="card p-6 space-y-4">
          {o.controle_fout && <p className="text-sm text-red-800">{CONTROLE_FOUT[o.controle_fout] ?? CONTROLE_FOUT.GEEN_WEB}</p>}

          {o.beschikbaar && o.richting === 'NIEUWER' && (
            <p className="text-sm text-neutral-900" data-testid="nieuwe-versie">
              Versie <strong>{o.beschikbaar}</strong> is vrijgegeven.
            </p>
          )}
          {o.beschikbaar && o.richting === 'OUDER' && (
            <p className="text-sm text-neutral-900" data-testid="nieuwe-versie">
              Vrijgegeven is versie <strong>{o.beschikbaar}</strong>. Die is ouder dan deze. Dat gebeurt als een nieuwe
              versie is teruggedraaid.
            </p>
          )}
          {o.beschikbaar && !o.richting && <p className="text-sm text-neutral-700">Dit is de vrijgegeven versie.</p>}
          {o.volgt === 'test' && <p className="text-sm text-neutral-600">Deze server volgt de testversies.</p>}
          {o.volgt && /^\d+\.\d+\.\d+$/.test(o.volgt) && (
            <p className="text-sm text-neutral-600">Deze server staat vast op versie {o.volgt}.</p>
          )}

          <p className="text-xs text-neutral-500">
            {o.gecontroleerd_op ? `Nagekeken op ${tijd(o.gecontroleerd_op)}. ` : ''}
            De server kijkt elke zes uur zelf.{' '}
            <button
              onClick={checkNow}
              disabled={nakijken}
              className="text-blue-700 hover:underline disabled:text-neutral-400 disabled:no-underline"
            >
              {nakijken ? 'Bezig met nakijken...' : 'Nu nakijken'}
            </button>
          </p>

          {o.richting &&
            o.laatste &&
            (o.laatste.uitkomst === 'TERUGGEZET' || o.laatste.uitkomst === 'MISLUKT') &&
            o.laatste.naar === o.beschikbaar && (
              <p className="text-sm text-amber-900" data-testid="eerder-mislukt">
                Deze versie startte de vorige keer niet goed. Probeer het alleen opnieuw als bekend is waarom.
              </p>
            )}

          {o.richting && !bevestigen && (
            <button onClick={() => setBevestigen(true)} className="btn-primary">
              {o.richting === 'NIEUWER' ? `Bijwerken naar ${o.beschikbaar}` : `Teruggaan naar ${o.beschikbaar}`}
            </button>
          )}

          {o.richting && bevestigen && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3" data-testid="bijwerken-bevestigen">
              <p className="text-sm font-semibold text-amber-900">
                {o.richting === 'NIEUWER' ? `Bijwerken naar versie ${o.beschikbaar}?` : `Teruggaan naar versie ${o.beschikbaar}?`}
              </p>
              <ul className="text-sm text-amber-900 list-disc pl-5 space-y-1">
                <li>
                  De app is ongeveer een minuut niet bereikbaar. Wie op dat moment iets opslaat, krijgt een foutmelding
                  en moet het daarna opnieuw doen.
                </li>
                <li>Eerst wordt een back-up van de database gemaakt.</li>
                <li>Start de nieuwe versie niet goed, dan gaat de server vanzelf terug naar versie {o.huidig}.</li>
              </ul>
              <div className="flex flex-wrap gap-2 justify-end">
                <button onClick={() => setBevestigen(false)} disabled={busy} className="btn-secondary">
                  Annuleren
                </button>
                <button onClick={startUpdate} disabled={busy} className="btn-primary">
                  {busy ? 'Back-up maken...' : o.richting === 'NIEUWER' ? 'Ja, bijwerken' : 'Ja, teruggaan'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {o.laatste && !loopt && (
        <div className="card p-6 space-y-1" data-testid="laatste-update">
          <h2 className="text-sm font-semibold text-neutral-700">Laatste keer bijwerken, {tijd(o.laatste.op)}</h2>
          <p
            className={`text-sm ${o.laatste.uitkomst === 'GELUKT' ? 'text-neutral-800' : o.laatste.uitkomst === 'AFGEBROKEN' ? 'text-amber-900' : 'text-red-800'}`}
          >
            {laatsteTekst(o.laatste)}
          </p>
        </div>
      )}
    </div>
  );
}

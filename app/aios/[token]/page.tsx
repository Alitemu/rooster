/**
 * The AIOS's personal link page (/aios/<token>): Deeltijd, Voorkeuren,
 * Bevestigen, Ingediend; once the roster is published their own diensten
 * on top (components/AiosMijnRooster.tsx, step 4d) and swapping
 * (components/AiosRuilen.tsx, step 4f).
 *
 * The AIOS's own page, next to the achterwacht's app/person/[token], not a
 * change to it (docs/development/diensten.md, "Copied, not changed"). Shared
 * is only the login: the link is checked by /api/auth/verify-link, which
 * opens the session as for anyone. Everything after that goes through the
 * AIOS's routes (/api/aios/deelnemer/...).
 */

'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { withBasePath } from '@/lib/basePath';
import { deadlineTekst } from '@/lib/aiosVerzendlijst';
import { checkPeriodAcceptsInput } from '@/lib/aiosInvoer';
import { AiosDeeltijdEditor } from '@/components/AiosDeeltijdEditor';
import { AiosAfwezigheid, type Absence } from '@/components/AiosAfwezigheid';
import { AiosBevestigen, AiosVoorkeuren } from '@/components/AiosPreferences';
import { AiosMijnRooster } from '@/components/AiosMijnRooster';
import { AiosRuilen } from '@/components/AiosRuilen';
import { PeriodeVerwijderd } from '@/components/PeriodeVerwijderd';

type Stap = 'deeltijd' | 'voorkeuren' | 'bevestigen' | 'ingediend';
const STAPPEN: Stap[] = ['deeltijd', 'voorkeuren', 'bevestigen', 'ingediend'];
const STAP_LABEL: Record<Stap, string> = {
  deeltijd: '⏰ Deeltijd',
  voorkeuren: '📅 Voorkeuren',
  bevestigen: '✓ Bevestigen',
  ingediend: '✅ Ingediend',
};
const isStap = (v: string | null): v is Stap => !!v && (STAPPEN as string[]).includes(v);

interface Periode {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
}

interface Patroon {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

const datum = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL');

function AiosLinkPagina() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [stap, setStapState] = useState<Stap>(() => {
    const s = searchParams.get('stap');
    return isStap(s) ? s : 'deeltijd';
  });
  useEffect(() => {
    const s = searchParams.get('stap');
    const nu: Stap = isStap(s) ? s : 'deeltijd';
    setStapState((vorige) => (vorige === nu ? vorige : nu));
  }, [searchParams]);
  // Every step is a history entry, so the browser's back button steps back.
  const setStap = (s: Stap) => {
    setStapState(s);
    const q = new URLSearchParams(searchParams.toString());
    q.set('stap', s);
    router.push(`${pathname}?${q.toString()}`, { scroll: false });
  };

  const [laden, setLaden] = useState(true);
  const [verwijderd, setVerwijderd] = useState(false);
  const [fout, setFout] = useState<{ tekst: string; link: boolean } | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [periode, setPeriode] = useState<Periode | null>(null);
  const [patronen, setPatronen] = useState<Patroon[]>([]);
  const [afwezigheden, setAfwezigheden] = useState<Absence[]>([]);
  const [waarschuwing, setWaarschuwing] = useState<string | null>(null);
  // A swap changes their roster: the roster above loads again.
  const [geruild, setGeruild] = useState(0);

  useEffect(() => {
    const start = async () => {
      try {
        const res = await fetch(withBasePath(`/api/auth/verify-link?token=${encodeURIComponent(token)}`));
        if (res.status === 410) {
          setVerwijderd(true);
          return;
        }
        if (!res.ok) {
          setFout({ tekst: 'Ongeldige of verlopen toegangslink', link: true });
          return;
        }
        const { person_id, period_id } = (await res.json()).data as { person_id: string; period_id: string };
        setPersonId(person_id);
        const scherm = await fetch(withBasePath(`/api/aios/deelnemer/${person_id}/periode/${period_id}`));
        if (!scherm.ok) {
          setFout({ tekst: 'Deze link hoort niet bij het rooster van de AIOS.', link: true });
          return;
        }
        setPeriode((await scherm.json()).data.period as Periode);
        const [p, a] = await Promise.all([
          fetch(withBasePath(`/api/aios/deelnemer/${person_id}/deeltijd`)),
          fetch(withBasePath(`/api/aios/deelnemer/${person_id}/afwezigheid?period_id=${period_id}`)),
        ]);
        const missen: string[] = [];
        if (p.ok) setPatronen((await p.json()).data);
        else missen.push('je eerder opgegeven deeltijd');
        if (a.ok) setAfwezigheden((await a.json()).data);
        else missen.push('je eerder opgegeven afwezigheid');
        if (missen.length > 0) {
          setWaarschuwing(`Kon ${missen.join(' en ')} niet laden. Wat hieronder staat, is mogelijk niet actueel. Probeer de pagina te vernieuwen.`);
        }
      } catch {
        setFout({ tekst: 'Laden is mislukt. Probeer de pagina te vernieuwen.', link: false });
      } finally {
        setLaden(false);
      }
    };
    void start();
  }, [token]);

  const uitloggen = useCallback(async () => {
    try {
      await fetch(withBasePath('/api/auth/logout'), { method: 'POST' });
    } finally {
      // replace: the token is in this page's address.
      router.replace('/');
    }
  }, [router]);

  if (laden) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center">
          <p className="text-lg text-neutral-600">Voorkeuren laden...</p>
        </div>
      </div>
    );
  }

  if (verwijderd) return <PeriodeVerwijderd />;

  if (fout || !periode || !personId) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">{fout?.link ? 'Toegangsfout' : 'Laden mislukt'}</h1>
          <p className="text-neutral-700 mb-6">{fout?.tekst ?? 'Kon de periode niet laden'}</p>
          {fout?.link && (
            <div className="text-sm text-neutral-600 space-y-2">
              <p>Controleer of je de hele link uit de e-mail hebt gebruikt. De link kan ook verlopen zijn.</p>
              <p>
                Een nieuwe link vraag je aan op de{' '}
                <Link href="/" className="text-blue-600 underline hover:no-underline">
                  startpagina
                </Link>{' '}
                bij &quot;Link kwijt?&quot;, met je werk-e-mailadres.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const deadlineVoorbij = new Date() > new Date(periode.deadline);
  const invoerDicht = !checkPeriodAcceptsInput(periode).allowed;

  return (
    <div className="container-main py-8 space-y-6">
      {waarschuwing && <div className="card p-4 bg-amber-50 border border-amber-200 text-sm text-amber-900">{waarschuwing}</div>}

      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold text-neutral-900 mb-2 break-words">{periode.naam}</h1>
            <p className="text-neutral-600 mb-4">
              AIOS · {datum(periode.start_datum)} t/m {datum(periode.eind_datum)}
            </p>
            <p className="text-sm text-neutral-600">Deadline: {deadlineTekst(periode.deadline)}</p>
          </div>
          <button
            onClick={uitloggen}
            className="shrink-0 self-start px-4 py-2 rounded font-medium bg-white border border-neutral-300 text-neutral-700 hover:bg-neutral-100 transition-colors text-sm print:hidden"
          >
            Uitloggen
          </button>
        </div>
      </div>

      {periode.status === 'GEPUBLICEERD' && <AiosMijnRooster key={geruild} personId={personId} periodId={periode.id} />}
      {periode.status === 'GEPUBLICEERD' && <AiosRuilen personId={personId} periodId={periode.id} onGeruild={() => setGeruild((n) => n + 1)} />}

      {invoerDicht && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-900">
            {deadlineVoorbij
              ? '⏰ De deadline voor deze periode is verstreken. Je kunt hieronder nog zien wat je hebt ingevuld, maar wijzigen kan niet meer.'
              : '🔒 De roosteraar heeft deze periode gesloten. Je kunt hieronder nog zien wat je hebt ingevuld, maar wijzigen kan niet meer.'}
          </p>
        </div>
      )}

      {/* Wraps: the four buttons side by side are wider than 375px. */}
      <div className="flex flex-wrap gap-2 justify-center">
        {STAPPEN.map((s) => (
          <button
            key={s}
            onClick={() => s !== 'ingediend' && setStap(s)}
            disabled={s === 'ingediend'}
            className={`px-4 py-2 rounded font-medium text-sm transition-colors ${
              stap === s
                ? 'bg-blue-600 text-white'
                : stap === 'ingediend'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'
            }`}
          >
            {STAP_LABEL[s]}
          </button>
        ))}
      </div>

      {stap === 'deeltijd' && (
        <div className="space-y-4">
          <AiosDeeltijdEditor
            personId={personId}
            patterns={patronen}
            defaultVanaf={periode.start_datum}
            defaultTot={periode.eind_datum}
            readOnly={deadlineVoorbij}
            onPatternsChange={setPatronen}
          />
          <AiosAfwezigheid
            personId={personId}
            periodId={periode.id}
            absences={afwezigheden}
            defaultVanaf={periode.start_datum}
            defaultTot={periode.eind_datum}
            readOnly={deadlineVoorbij}
            onAbsencesChange={setAfwezigheden}
          />
          <button
            onClick={() => setStap('voorkeuren')}
            className="w-full py-3 px-4 rounded font-semibold text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
          >
            Volgende: voorkeuren opgeven
          </button>
        </div>
      )}

      {stap === 'voorkeuren' && (
        <AiosVoorkeuren
          personId={personId}
          periodId={periode.id}
          readOnly={invoerDicht}
          onTerug={() => setStap('deeltijd')}
          onVolgende={() => setStap('bevestigen')}
        />
      )}

      {stap === 'bevestigen' && (
        <div className="space-y-4">
          <AiosBevestigen personId={personId} periodId={periode.id} readOnly={invoerDicht} onIngediend={() => setStap('ingediend')} />
          <button
            onClick={() => setStap('voorkeuren')}
            className="w-full py-3 px-4 rounded font-semibold bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            Terug
          </button>
        </div>
      )}

      {stap === 'ingediend' && (
        <div className="card p-8 bg-green-50 border-2 border-green-300 text-center space-y-4">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-green-900">Voorkeuren ingediend</h2>
          <p className="text-green-800">Je voorkeuren zijn ingediend.</p>
          <p className="text-sm text-green-700">
            {deadlineVoorbij
              ? `Je kunt dit venster sluiten. De deadline (${deadlineTekst(periode.deadline)}) is verstreken, dus wijzigen kan niet meer.`
              : `Je kunt dit venster sluiten. Tot de deadline (${deadlineTekst(periode.deadline)}) kun je nog iets aanpassen. Je laatste wijzigingen tellen dan vanzelf mee, ook zonder opnieuw in te dienen.`}
          </p>
          <button
            onClick={() => setStap('voorkeuren')}
            className="px-4 py-2 rounded font-medium bg-white border border-green-300 text-green-900 hover:bg-green-100 transition-colors"
          >
            {deadlineVoorbij ? 'Ingevoerde voorkeuren bekijken' : 'Voorkeuren aanpassen'}
          </button>
        </div>
      )}
    </div>
  );
}

// The step lives in the `stap` query parameter (useSearchParams), which
// needs a Suspense boundary.
export default function AiosLinkPage() {
  return (
    <Suspense
      fallback={
        <div className="container-main py-12">
          <div className="card p-8 text-center">
            <p className="text-lg text-neutral-600">Laden...</p>
          </div>
        </div>
      }
    >
      <AiosLinkPagina />
    </Suspense>
  );
}

/**
 * An AIOS period's page (docs/aios-rooster.md), in this order: the history
 * from before the app, the steps up to the preferences (open, invite,
 * remind, deadline, close), the voortgangstoets, "Status voorkeuren" per
 * AIOS with the 50% warnings, communication, making the roster and
 * publishing it, the dienstpercentage and saldo, the points the quarter holds
 * (how many fte the AIOS need together to stay under 25% on average) and,
 * last, the Dienstrooster with its list, calendar, dienstdoende and swaps.
 *
 * Generating, the roster per block and publishing come in the next steps;
 * until then the achterwacht's steps after closing refuse an AIOS period
 * (lib/aiosPeriod.ts).
 *
 * The new layout (1.13.0, the planner's wish, lib/aiosIndeling.ts), as the
 * achterwacht's page has it: the list of sections all the way left, one
 * section at a time, the header and the card that makes the roster as the
 * section "Periode", the period's name and status in the blue bar. The
 * new layout is the layout since 2.0.0; the accordion stays in the code, out
 * of sight (lib/aiosIndeling.ts aiosNieuweIndeling).
 */

'use client';

import { Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { withBasePath } from '@/lib/basePath';
import { AiosExporteren } from '@/components/AiosExporteren';
import { AiosToegangslinksSectie } from '@/components/AiosToegangslinks';
import { AiosDienstpercentage, AiosRoosterMaken } from '@/components/AiosRoosterMaken';
import { AiosGeschiedenis } from '@/components/AiosGeschiedenis';
import { AiosDienstrooster } from '@/components/AiosDienstrooster';
import { AiosVoortgangstoets } from '@/components/AiosVoortgangstoets';
import { AiosPeriodeStatus } from '@/components/AiosPeriodeStatus';
import { AiosHarmonica, AiosIndelingContext, AiosSectie, type AiosMelding } from '@/components/AiosSectie';
import { AiosInPlek } from '@/components/AiosInPlek';
import {
  AIOS_ADRES,
  AIOS_BOVENAAN,
  AIOS_GROEPEN,
  aiosActiefOnderdeel,
  aiosNieuweIndeling,
  aiosOnderdeelUitAdres,
  aiosStartOnderdeel,
  aiosStatusTekst,
  type AiosOnderdeel,
} from '@/lib/aiosIndeling';
import { leesIndeling, volgIndeling } from '@/lib/aiosIndelingOnthouden';
import { deadlineTekst } from '@/lib/aiosVerzendlijst';
import { periodStatusLabel } from '@/lib/aiosTeksten';
import { benodigdeFte, SOORT_LABELS } from '@/lib/aiosDiensten';
import type { AiosDienstenOverzicht } from '@/lib/aiosSlots';
import { bovenHelftPlanner, type AiosWens, type BlokkadeTeller, type MarkeringTelling } from '@/lib/aiosVoorkeur';
import { foutTekst } from '@/lib/aiosFoutTekst';
import { DatumTijdVeld } from '@/components/DatumVeld';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
}

const getal = (x: number) => x.toLocaleString('nl-NL', { maximumFractionDigits: 1 });

const datumLang = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

/** A datetime-local value for the input, from a stored deadline. */
function alsInvoer(deadline: string): string {
  return deadline.length >= 16 ? deadline.slice(0, 16) : deadline;
}

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

interface AiosStand {
  uitgenodigd_op: string | null;
  mail_ingesteld: boolean;
  aantal_deelnemers: number;
  definitief: boolean;
}

/** Open, invite, remind, close: the steps up to the preferences, on the AIOS's own routes. */
function Stappen({ period, stand, onChanged }: { period: Period; stand: AiosStand | null; onChanged: () => void }) {
  const [deadline, setDeadline] = useState(alsInvoer(period.deadline));
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  useEffect(() => {
    setDeadline(alsInvoer(period.deadline));
  }, [period.deadline]);

  const doe = async (url: string, method: string, body: unknown, fallback: string, klaar?: (data: { aantal?: number; overgeslagen?: number }) => string) => {
    setBezig(true);
    setFout(null);
    setMelding(null);
    try {
      const data = await antwoord(
        await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        fallback
      );
      if (klaar) setMelding(klaar(data));
      onChanged();
    } catch (err) {
      setFout(foutTekst(err, fallback));
    } finally {
      setBezig(false);
    }
  };

  const hint =
    period.status === 'OPEN' ? `Open tot ${deadlineTekst(period.deadline)}` : `Status: ${periodStatusLabel(period.status)}`;

  return (
    <AiosSectie sleutel="voorkeuren" titel="Voorkeuren van de AIOS" hint={hint}>
      {period.status === 'CONCEPT' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            Open de periode om de AIOS uit te nodigen voor hun voorkeuren. Verlof en parttimedagen die ze al hebben
            opgegeven, staan dan meteen in hun voorkeuren.
          </p>
          <div>
            <label htmlFor="aios-deadline" className="block text-sm font-medium text-neutral-800 mb-1">
              Deadline voor de voorkeuren
            </label>
            <DatumTijdVeld
              id="aios-deadline"
              value={deadline}
              onChange={(waarde) => setDeadline(waarde)}
              className="px-2 py-1 border rounded text-sm"
            />
            <p className="text-xs text-neutral-500 mt-1">Standaard 8 weken voor de start van het kwartaal, om 17:00.</p>
          </div>
          <button
            type="button"
            onClick={() => doe(withBasePath(`/api/aios/periode/${period.id}/openen`), 'POST', { deadline }, 'Openen van de periode is mislukt')}
            disabled={bezig || !deadline}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bezig ? 'Bezig...' : 'Periode openen'}
          </button>
        </div>
      )}

      {period.status === 'OPEN' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            De periode staat open. De AIOS kunnen hun voorkeuren opgeven tot {deadlineTekst(period.deadline)}.
            {stand?.uitgenodigd_op && ` De uitnodigingen zijn verstuurd op ${deadlineTekst(stand.uitgenodigd_op)}.`} Uitnodigingen en
            herinneringen verstuur je bij Exporteren &amp; communicatie.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="aios-deadline-wijzigen" className="block text-xs font-medium text-neutral-600 mb-1">
                Deadline verschuiven
              </label>
              <DatumTijdVeld
                id="aios-deadline-wijzigen"
                value={deadline}
                onChange={(waarde) => setDeadline(waarde)}
                className="px-2 py-1 border rounded text-sm"
              />
            </div>
            <button
              type="button"
              disabled={bezig || !deadline || deadline === alsInvoer(period.deadline)}
              onClick={() => doe(withBasePath(`/api/aios/periode/${period.id}/deadline`), 'PATCH', { deadline, was: period.deadline }, 'Aanpassen van de deadline is mislukt', () => 'De deadline is aangepast.')}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
            >
              Opslaan
            </button>
          </div>
        </div>
      )}

      {period.status === 'GESLOTEN' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            De periode is gesloten: de AIOS kunnen hun voorkeuren niet meer wijzigen. Maak bovenaan het rooster. De periode kan terug naar open met de knop in de kop van de pagina.
          </p>
        </div>
      )}

      {period.status === 'GEGENEREERD' && (
        <p className="text-sm text-neutral-700">
          De periode is gesloten en het rooster is gemaakt. Moet de periode terug naar open, verwijder dan eerst het rooster
          bovenaan.
        </p>
      )}

      {period.status === 'GEPUBLICEERD' && (
        <p className="text-sm text-neutral-700">
          Het rooster is gepubliceerd. De AIOS zien hun diensten op hun eigen pagina. Bovenaan maak je het definitief of trek je de
          publicatie in.
        </p>
      )}

      {melding && <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-900">{melding}</div>}
      {fout && (
        <div role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {fout}
        </div>
      )}
    </AiosSectie>
  );
}

interface Deelnemer {
  person_id: string;
  codenaam: string;
  status: 'NIET_BEGONNEN' | 'BEZIG' | 'INGEDIEND';
  ingediend_op: string | null;
  markeringen: MarkeringTelling;
  tellers: BlokkadeTeller[];
  wens: AiosWens;
}

const STATUS_LABEL: Record<Deelnemer['status'], string> = {
  NIET_BEGONNEN: 'Nog niets ingevuld',
  BEZIG: 'Bezig, nog niet ingediend',
  INGEDIEND: 'Ingediend',
};

function wensTekst(w: AiosWens): string[] {
  return [
    w.vier_avonden && '4 avonden',
    w.vier_nachten && '4 nachten',
    w.twee_dagdiensten && 'twee dagdiensten',
    w.inwerken_van && w.inwerken_tot && `inwerken ${datumKort(w.inwerken_van)} t/m ${datumKort(w.inwerken_tot)}`,
    w.onderbreking_van &&
      w.onderbreking_tot &&
      `onderbreking ${datumKort(w.onderbreking_van)} t/m ${datumKort(w.onderbreking_tot)}`,
  ].filter((x): x is string => Boolean(x));
}

/** "Status voorkeuren": per AIOS, with the 50% warnings. */
function StatusVoorkeuren({ periodId, refreshKey }: { periodId: string; refreshKey: string }) {
  const [deelnemers, setDeelnemers] = useState<Deelnemer[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/voorkeuren`))
      .then((res) => antwoord(res, 'Laden van de voorkeuren is mislukt'))
      .then((data) => {
        setDeelnemers(data.deelnemers);
        setFout(null);
      })
      .catch((err) => setFout(foutTekst(err, 'Laden van de voorkeuren is mislukt')));
  }, [periodId]);
  useEffect(() => {
    laad();
  }, [laad, refreshKey]);

  const ingediend = (deelnemers ?? []).filter((d) => d.status === 'INGEDIEND').length;

  return (
    // Kept loaded while closed: the hint says how many handed in.
    <AiosSectie sleutel="status" titel="Status voorkeuren" hint={deelnemers ? `${ingediend} van de ${deelnemers.length} ingediend` : undefined} blijfGeladen>
      {fout && <p className="text-sm text-red-700">{fout}</p>}
      {deelnemers && (
        <StatusLijst deelnemers={deelnemers} ingediend={ingediend} laad={laad} />
      )}
    </AiosSectie>
  );
}

function StatusLijst({ deelnemers, ingediend, laad }: { deelnemers: Deelnemer[]; ingediend: number; laad: () => void }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-neutral-700">
          {ingediend} van de {deelnemers.length} AIOS {ingediend === 1 ? 'heeft' : 'hebben'} ingediend.
        </p>
        <button type="button" onClick={laad} className="text-sm text-blue-600 hover:text-blue-700">
          Vernieuwen
        </button>
      </div>
      {deelnemers.length === 0 && (
        <p className="text-sm text-neutral-600">Er doet nog geen AIOS mee in dit kwartaal. Voeg ze toe bij Personeel.</p>
      )}
      <ul className="divide-y">
        {deelnemers.map((d) => {
          const wens = wensTekst(d.wens);
          const teVeel = d.tellers.filter((t) => t.boven_helft);
          return (
            <li key={d.person_id} className="py-2 space-y-1 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium text-neutral-900">{d.codenaam}</span>
                <span className={d.status === 'INGEDIEND' ? 'text-green-800' : 'text-neutral-600'}>
                  {d.status === 'INGEDIEND' ? '✓ ' : ''}
                  {STATUS_LABEL[d.status]}
                </span>
              </div>
              <p className="text-neutral-600">
                {d.markeringen.ABSOLUUT} geblokkeerd · {d.markeringen.LIEVER_NIET} liever niet · {d.markeringen.VOORKEUR}{' '}
                voorkeur
                {wens.length > 0 && ` · ${wens.join(', ')}`}
              </p>
              {teVeel.map((t) => (
                <p key={t.groep} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-950">
                  ⚠ {bovenHelftPlanner(t)}
                </p>
              ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// Every part folds, as on the achterwacht's period page (components/AiosSectie.tsx), or, in the new
// layout, is one item of the list. Suspense: the page reads the address (?indeling, ?onderdeel).
export function AiosPeriodOverview({ period }: { period: Period }) {
  return (
    <Suspense fallback={<div className="container-main py-8 text-sm text-neutral-600">Laden...</div>}>
      <AiosHarmonica>
        <Kader period={period} />
      </AiosHarmonica>
    </Suspense>
  );
}

/** A click that opens the link elsewhere (new tab, new window) is the browser's. */
const gewoneKlik = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** The chosen section on screen with its title, and the focus there, so a keyboard is in it at once. */
function toonOnderdeel(sleutel: AiosOnderdeel) {
  const sectie = document.querySelector<HTMLElement>(`[data-onderdeel="${sleutel}"]`);
  if (!sectie) return;
  const marge = parseFloat(getComputedStyle(sectie).scrollMarginTop) || 0;
  const top = sectie.getBoundingClientRect().top;
  if (top < marge || top > window.innerHeight * 0.6) sectie.scrollIntoView({ block: 'start' });
  sectie.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

/**
 * The layout around the page: the accordion as it was, or the new layout with the list of sections. Each
 * section tells the list itself that it is there (AiosSectie, `meld`), so the list holds exactly what the
 * page has for this status and this account.
 */
function Kader({ period }: { period: Period }) {
  const searchParams = useSearchParams();
  // The new layout since 2.0.0; the accordion only for ?indeling=oud or the hidden flag (lib/aiosIndelingOnthouden.ts).
  const oudeIndeling = useSyncExternalStore(volgIndeling, leesIndeling, () => null);
  const zijbalk = aiosNieuweIndeling(searchParams.get('indeling'), oudeIndeling);

  // What the sections said about themselves, and the status the page last read (for the first section).
  const [meldingen, setMeldingen] = useState<ReadonlyMap<AiosOnderdeel, AiosMelding>>(() => new Map());
  const meld = useCallback((sleutel: AiosOnderdeel, melding: AiosMelding | null) => {
    setMeldingen((nu) => {
      const was = nu.get(sleutel);
      if (melding ? was?.titel === melding.titel && was?.hint === melding.hint : !was) return nu;
      const volgende = new Map(nu);
      if (melding) volgende.set(sleutel, melding);
      else volgende.delete(sleutel);
      return volgende;
    });
  }, []);
  const [status, setStatus] = useState(period.status);
  const gekozen = aiosOnderdeelUitAdres(searchParams.get('onderdeel'));
  const actief = aiosActiefOnderdeel(gekozen, aiosStartOnderdeel(status), new Set(meldingen.keys()));

  // Another section: the address changes in the browser itself (Next follows history.pushState), so nothing
  // waits for the server; then its title comes on screen with the focus.
  const naWissel = useRef<AiosOnderdeel | null>(null);
  const adresVoor = (sleutel: AiosOnderdeel) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('onderdeel', AIOS_ADRES[sleutel]);
    return `?${params.toString()}`;
  };
  const kies = (sleutel: AiosOnderdeel) => {
    if (sleutel === actief) {
      toonOnderdeel(sleutel);
      return;
    }
    naWissel.current = sleutel;
    window.history.pushState(null, '', adresVoor(sleutel));
  };
  useEffect(() => {
    if (naWissel.current !== actief) return;
    naWissel.current = null;
    toonOnderdeel(actief);
  }, [actief]);

  // The section on screen stays when the status changes (2.0.1). Without a chosen section the page shows the
  // first section of the status, so making the roster in "Periode" jumped to "Dienstrooster" the moment it was
  // made, and opening a concept in "Voorkeuren van de AIOS" jumped to "Status voorkeuren": the planner lost the
  // answer to what they just did. The section that was on screen goes into the address instead.
  const vorigeStatus = useRef(status);
  const laatsteActief = useRef(actief);
  useEffect(() => {
    if (vorigeStatus.current === status) return;
    vorigeStatus.current = status;
    if (!gekozen) window.history.replaceState(null, '', adresVoor(laatsteActief.current));
  }, [status]);
  useEffect(() => {
    laatsteActief.current = actief;
  });

  // The blue bar sticks to the top below 1100 px while this layout is on the page (app/globals.css).
  useEffect(() => {
    if (!zijbalk) return;
    document.documentElement.dataset.kopPlakt = 'ja';
    return () => {
      delete document.documentElement.dataset.kopPlakt;
    };
  }, [zijbalk]);

  // The menu below 1100 px: its button in the blue bar, the list from the left under the bar.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTop, setMenuTop] = useState(0);
  const menuKnopRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!menuOpen) return;
    (menuRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? menuRef.current?.querySelector<HTMLElement>('a'))?.focus();
    const toets = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      menuKnopRef.current?.focus();
    };
    document.addEventListener('keydown', toets);
    return () => document.removeEventListener('keydown', toets);
  }, [menuOpen]);

  if (!zijbalk) return <Pagina period={period} zijbalk={false} onStatus={setStatus} />;

  /** "Periode" on top under no heading; the sections of a group moved in under its heading, with a line. */
  const lijst = (naKeuze?: () => void) => {
    const item = (k: AiosOnderdeel) => {
      const melding = meldingen.get(k);
      if (!melding) return null;
      const isActief = k === actief;
      return (
        <a
          key={k}
          href={adresVoor(k)}
          aria-current={isActief ? 'page' : undefined}
          onClick={(e) => {
            if (!gewoneKlik(e)) return;
            e.preventDefault();
            naKeuze?.();
            kies(k);
          }}
          className={`block px-3 py-2.5 rounded-lg ${isActief ? 'bg-blue-700 text-white' : 'hover:bg-neutral-50'}`}
        >
          <span className="block font-medium">{melding.titel}</span>
          {melding.hint && <span className={`block text-xs ${isActief ? 'text-blue-100' : 'text-neutral-600'}`}>{melding.hint}</span>}
        </a>
      );
    };
    return (
      <>
        {item(AIOS_BOVENAAN)}
        {AIOS_GROEPEN.map((groep) => {
          const items = groep.onderdelen.filter((k) => meldingen.has(k));
          if (items.length === 0) return null;
          return (
            <div key={groep.naam}>
              <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-neutral-600">{groep.naam}</p>
              <div className="ml-4 pl-1.5 border-l-2 border-neutral-300">{items.map((k) => item(k))}</div>
            </div>
          );
        })}
      </>
    );
  };

  return (
    <AiosIndelingContext.Provider value={{ actief, meld }}>
      <AiosInPlek plek="kop-links">
        <button
          ref={menuKnopRef}
          type="button"
          data-testid="onderdelen-menu"
          aria-label="Onderdelen van de periode"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => {
            if (!menuOpen) setMenuTop(Math.max(0, Math.round(menuKnopRef.current?.closest('header')?.getBoundingClientRect().bottom ?? 0)));
            setMenuOpen(!menuOpen);
          }}
          className="min-[1100px]:hidden -ml-2 w-11 h-11 flex items-center justify-center rounded hover:bg-white/10"
        >
          <svg className="w-7 h-7" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
      </AiosInPlek>
      {menuOpen && (
        <>
          {/* A tap next to the menu closes it. */}
          <div className="min-[1100px]:hidden fixed inset-x-0 bottom-0 z-30 bg-black/40" style={{ top: menuTop }} onClick={() => setMenuOpen(false)} data-testid="onderdelen-waas" />
          <nav
            ref={menuRef}
            id={menuId}
            aria-label="Onderdelen van de periode"
            className="min-[1100px]:hidden fixed left-0 bottom-0 z-30 w-[84%] max-w-xs bg-white shadow-xl p-2 overflow-y-auto overscroll-contain"
            style={{ top: menuTop }}
          >
            {lijst(() => setMenuOpen(false))}
          </nav>
        </>
      )}
      <div className="min-[1100px]:flex min-[1100px]:items-stretch" data-testid="indeling-nieuw">
        {/* All the way left on a wide screen, from the blue bar down; its own scroll bar on a low screen. */}
        <aside className="hidden min-[1100px]:block w-[17rem] flex-none bg-white border-r border-neutral-300">
          <nav aria-label="Onderdelen van de periode" className="sticky top-0 max-h-screen overflow-y-auto px-2 py-4">
            {lijst()}
          </nav>
        </aside>
        <div className="min-[1100px]:flex-1 min-[1100px]:min-w-0">
          <Pagina period={period} zijbalk onStatus={setStatus} />
        </div>
      </div>
    </AiosIndelingContext.Provider>
  );
}

/** The period in the app's blue bar, between "Dienstrooster" and the version: its name, the page's heading there, and its status. */
function PeriodeInKop({ naam, status }: { naam: string; status: string }) {
  return (
    <AiosInPlek plek="kop-midden">
      <div
        className="flex items-baseline gap-3 min-w-0 min-[1100px]:ml-2 min-[1100px]:pl-6 min-[1100px]:border-l min-[1100px]:border-white/40"
        data-testid="kop-periode"
      >
        <h1 className="text-base min-[1100px]:text-lg font-semibold truncate">{naam}</h1>
        <span className="shrink-0 px-2.5 py-0.5 rounded-full border border-white/70 bg-white/15 text-[0.8125rem] font-semibold whitespace-nowrap">
          {status}
        </span>
      </div>
    </AiosInPlek>
  );
}

function Pagina({
  period: begin,
  zijbalk,
  onStatus,
}: {
  period: Period;
  zijbalk: boolean;
  onStatus: (status: string) => void;
}) {
  const [overzicht, setOverzicht] = useState<AiosDienstenOverzicht | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page reloads the period from the AIOS's own route after each step:
  // the achterwacht's period page that renders this is not changed for it.
  const [period, setPeriod] = useState<Period>(begin);
  const [stand, setStand] = useState<AiosStand | null>(null);
  // Raised when the voortgangstoets changed: its night left the diensten (or came back).
  const [toetsVersie, setToetsVersie] = useState(0);
  // Raised when the roster was made, removed or published (the section Dienstrooster reads it again), and when it was changed by hand (the numbers of Rooster read it again).
  const [roosterVersie, setRoosterVersie] = useState(0);
  const [handmatigVersie, setHandmatigVersie] = useState(0);
  const herlaad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${begin.id}`))
      .then((res) => antwoord(res, 'Laden van de periode is mislukt'))
      .then((data) => {
        setPeriod((p) => ({ ...p, ...data.period }));
        setStand({ uitgenodigd_op: data.uitgenodigd_op, mail_ingesteld: data.mail_ingesteld, aantal_deelnemers: data.aantal_deelnemers, definitief: data.definitief === true });
      })
      .catch((err) => setError(foutTekst(err, 'Laden van de periode is mislukt')));
  }, [begin.id]);
  useEffect(() => {
    herlaad();
  }, [herlaad]);
  useEffect(() => {
    onStatus(period.status);
  }, [period.status, onStatus]);

  useEffect(() => {
    fetch(withBasePath(`/api/planner/period/${period.id}/aios-diensten`))
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Laden van de diensten mislukt');
        setOverzicht(data.data);
      })
      .catch((err) => setError(foutTekst(err, 'Laden van de diensten mislukt')));
  }, [period.id, toetsVersie]);

  // The header of the period: the card on top in the accordion, inside the section "Periode" in the new
  // layout, where the blue bar has the name (one heading on the page).
  const kop = (metNaam: boolean) => (
    <>
      {/* Stacked on a phone, side by side from sm up, as the achterwacht's header. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Link href="/planner" className="text-sm text-blue-600 hover:text-blue-700">
            ← Periodes
          </Link>
          {metNaam && <h1 className="text-3xl font-bold text-neutral-900 break-words">{period.naam}</h1>}
          <p className="text-neutral-600">
            AIOS · {datumLang(period.start_datum)} t/m {datumLang(period.eind_datum)}
            {overzicht && overzicht.dagen.length > 0 && ` · ${Math.ceil(overzicht.dagen.length / 7)} weken`}
          </p>
          <p className="text-sm text-neutral-600">Deadline voorkeuren: {deadlineTekst(period.deadline)}</p>
        </div>
        <AiosPeriodeStatus period={period} definitief={stand?.definitief === true} onChanged={herlaad} />
      </div>
    </>
  );
  // Making, publishing and withdrawing the roster come first, as on the achterwacht's page: a card, not a section.
  const rooster =
    period.status !== 'CONCEPT' && (
    <AiosRoosterMaken
      key={toetsVersie}
      periodId={period.id}
      status={period.status}
      versie={handmatigVersie}
      onChanged={() => {
        herlaad();
        setRoosterVersie((v) => v + 1);
      }}
    />
  );

  return (
    <div className="container-main py-8 space-y-6">
      {zijbalk ? (
        <>
          <PeriodeInKop naam={period.naam} status={aiosStatusTekst(period.status, stand?.definitief === true)} />
          {/* The header and the card that makes the roster are the section "Periode" (1.13.0). Kept loaded: a
              generation that runs is followed there. */}
          <AiosSectie sleutel="periode" titel="Periode" hint={aiosStatusTekst(period.status, stand?.definitief === true).toLowerCase()} blijfGeladen>
            {kop(false)}
            {rooster}
          </AiosSectie>
          {/* Where the section "Blokken rond de feestdagen" of the card above goes (components/AiosRoosterMaken.tsx). */}
          <div id="aios-feestdagblokken" className="empty:hidden" />
        </>
      ) : (
        <>
          <div className="card p-6">{kop(true)}</div>
          {rooster}
        </>
      )}

      {/* The history from before the app is the first section (the planner's wish): the quarter starts from it. */}
      <AiosGeschiedenis periodId={period.id} />
      <Stappen period={period} stand={stand} onChanged={herlaad} />
      <AiosVoortgangstoets periodId={period.id} status={period.status} onChanged={() => setToetsVersie((v) => v + 1)} />
      {period.status !== 'CONCEPT' && (
        <StatusVoorkeuren periodId={period.id} refreshKey={`${period.status}|${period.deadline}`} />
      )}
      {period.status !== 'CONCEPT' && <AiosExporteren period={period} stand={stand} onChanged={herlaad} />}
      {period.status !== 'CONCEPT' && <AiosToegangslinksSectie periodId={period.id} />}
      <AiosDienstpercentage periodId={period.id} status={period.status} versie={roosterVersie + handmatigVersie + toetsVersie} />

      {error && <div role="alert" className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>}
      {!overzicht && !error && <div className="card p-8 text-center text-neutral-600">Diensten laden...</div>}

      {overzicht && (
        <>
          <AiosSectie sleutel="punten" titel="Punten in dit kwartaal" hint={`${getal(overzicht.punten.totaal_punten)} punten`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-600">
                  <th className="py-1 font-medium">Soort</th>
                  <th className="py-1 font-medium text-right">Diensten</th>
                  <th className="py-1 font-medium text-right">Punten</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overzicht.punten.per_soort.map((t) => (
                  <tr key={t.soort}>
                    <td className="py-1 capitalize">{SOORT_LABELS[t.soort]}</td>
                    <td className="py-1 text-right">{t.aantal}</td>
                    <td className="py-1 text-right">{getal(t.punten)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-1">Samen</td>
                  <td className="py-1 text-right">
                    {overzicht.punten.per_soort.reduce((som, t) => som + t.aantal, 0)}
                  </td>
                  <td className="py-1 text-right">{getal(overzicht.punten.totaal_punten)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-sm text-neutral-700">
              Het kwartaal heeft {overzicht.punten.werkdagen} werkdagen (maandag tot en met vrijdag, zonder de
              feestdagen). Om gemiddeld onder 25% te blijven, hebben de AIOS samen minstens{' '}
              <strong>{getal(benodigdeFte(overzicht.punten, 0.25))} fte</strong> nodig. Voor gemiddeld 20% is dat{' '}
              {getal(benodigdeFte(overzicht.punten, 0.2))} fte.
            </p>
          </AiosSectie>

          <AiosDienstrooster
            periodId={period.id}
            status={period.status}
            overzicht={overzicht}
            versie={roosterVersie + toetsVersie}
            onHandmatig={() => {
              setHandmatigVersie((v) => v + 1);
              herlaad();
            }}
          />
        </>
      )}
    </div>
  );
}

'use client';

/**
 * Automatic reminders for one period (lib/autoReminders.ts): what goes out
 * next and to how many people, what already went out, and a switch to
 * pause them for this period.
 */

import { useCallback, useEffect, useState } from 'react';

interface Status {
  aan: boolean;
  mailIngesteld: boolean;
  adresBekend: boolean;
  periodeOpen: boolean;
  volgende: {
    moment: string;
    laatste: boolean;
    nogNietsIngevuld: number;
    nogNietIngediend: number;
  } | null;
  geschiedenis: Array<{
    dagen_voor_deadline: number;
    moment: string;
    uitkomst: 'VERSTUURD' | 'OVERGESLAGEN';
    aantal_niet_begonnen: number;
    aantal_bezig: number;
  }>;
}

interface Props {
  periodId: string;
  /** Changes whenever the dashboard reloads (a new deadline, a submission). */
  refreshKey?: unknown;
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function personen(n: number): string {
  return n === 1 ? '1 persoon' : `${n} personen`;
}

export function AutoReminderPanel({ periodId, refreshKey }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/planner/period/${periodId}/auto-reminders`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Laden mislukt');
      setStatus(data.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Laden mislukt');
    }
  }, [periodId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const toggle = async () => {
    if (!status) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/planner/period/${periodId}/auto-reminders`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aan: !status.aan }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message ?? 'Opslaan mislukt');
      setStatus(data.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan mislukt');
    } finally {
      setSaving(false);
    }
  };

  if (!status) {
    return error ? <p className="text-sm text-red-700">{error}</p> : null;
  }

  const verstuurd = status.geschiedenis.filter((h) => h.uitkomst === 'VERSTUURD');

  let regel: React.ReactNode;
  if (!status.mailIngesteld) {
    regel = 'Staan uit, want versturen is nog niet ingesteld. Dat doe je bij Mailinstellingen.';
  } else if (!status.periodeOpen) {
    regel = 'Alleen zolang de periode open staat en de deadline nog niet voorbij is.';
  } else if (!status.aan) {
    regel = 'Gepauzeerd voor deze periode. Handmatige herinneringen werken gewoon.';
  } else if (!status.volgende) {
    regel = 'Er staan voor deze deadline geen automatische herinneringen meer gepland.';
  } else {
    const v = status.volgende;
    const totaal = v.nogNietsIngevuld + v.nogNietIngediend;
    regel = (
      <>
        Volgende: {v.laatste ? 'laatste herinnering' : 'herinnering'} op {formatMoment(v.moment)}.{' '}
        {totaal === 0
          ? 'Op dit moment heeft iedereen ingediend.'
          : `Nu zou die naar ${personen(totaal)} gaan: ${v.nogNietsIngevuld} nog niets ingevuld en ${v.nogNietIngediend} nog niet ingediend.`}
      </>
    );
  }

  return (
    <div className="border border-neutral-200 rounded p-4 space-y-2" data-testid="auto-herinneringen">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-neutral-900">⏰ Automatische herinneringen</p>
          <p className="text-sm text-neutral-700 mt-1">{regel}</p>
          {status.mailIngesteld && status.periodeOpen && status.aan && !status.adresBekend && (
            <p className="text-sm text-amber-800 mt-1">
              Verstuur eerst de uitnodigingen. Daarmee weet de server welk adres in de links hoort.
            </p>
          )}
        </div>
        {status.mailIngesteld && status.periodeOpen && (
          <button
            onClick={toggle}
            disabled={saving}
            className="py-1.5 px-3 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 whitespace-nowrap"
          >
            {status.aan ? 'Pauzeren' : 'Weer aanzetten'}
          </button>
        )}
      </div>
      {verstuurd.length > 0 && (
        <ul className="text-xs text-neutral-600 space-y-0.5">
          {verstuurd.map((h) => (
            <li key={h.moment}>
              ✓ {formatMoment(h.moment)}: verstuurd aan {personen(h.aantal_niet_begonnen + h.aantal_bezig)}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

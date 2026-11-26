'use client';

/**
 * "Herinnering sturen" for one open swap request of the AIOS: the requester
 * on their own request, the planner on any. Shows when the last
 * reminder went, and only after a yes in the box does it send. Not within
 * 24 hours of the last one (the server says so too). A copy of
 * components/RuilHerinnering.tsx for the AIOS, not an import of it
 * (docs/development/diensten.md, "Copied, not changed").
 */

import { useState } from 'react';
import { foutTekst } from '@/lib/aiosFoutTekst';

const DAG_MS = 24 * 60 * 60 * 1000;

const momentTekst = (iso: string) =>
  new Date(iso).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const DOOR: Record<string, string> = {
  AUTOMATISCH: 'automatisch',
  AANVRAGER: 'door de aanvrager',
  PLANNER: 'door de planner',
};

/** "dinsdag 3 november om 09:00 (automatisch)", or null when there was none. */
export function aiosLaatsteHerinneringTekst(laatste: string | null, door: string | null, eigen: boolean): string | null {
  if (!laatste) return null;
  const wie = door === 'AANVRAGER' && eigen ? 'door jou' : door ? DOOR[door] : null;
  return `${momentTekst(laatste)}${wie ? ` (${wie})` : ''}`;
}

export function AiosRuilHerinnering({
  stuur,
  laatste,
  door,
  eigen,
  onKlaar,
}: {
  /** Sends the reminder, with the yes in its body: the caller knows the route (and puts it through withBasePath). */
  stuur: () => Promise<Response>;
  laatste: string | null;
  door: string | null;
  /** The requester presses it themselves (the text says "door jou"). */
  eigen: boolean;
  onKlaar: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [gestuurd, setGestuurd] = useState(false);
  // The moment the box was drawn: enough to know whether 24 hours have passed since the last reminder.
  const [nu] = useState(() => Date.now());
  const tekst = aiosLaatsteHerinneringTekst(laatste, door, eigen);
  const nogNiet = laatste !== null && nu - Date.parse(laatste) < DAG_MS;

  const verstuur = async () => {
    setBezig(true);
    setFout(null);
    try {
      const res = await stuur();
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Herinnering sturen is mislukt');
      setOpen(false);
      setGestuurd(true);
      onKlaar();
    } catch (err) {
      setFout(foutTekst(err, 'Herinnering sturen is mislukt'));
    } finally {
      setBezig(false);
    }
  };

  return (
    <div className="mt-2 text-sm" data-testid="aios-ruil-herinnering">
      <p className="text-neutral-600">
        {tekst ? `Laatste herinnering: ${tekst}` : 'Er is nog geen herinnering gestuurd.'}
        {gestuurd && ' De herinnering is gestuurd.'}
      </p>
      {!open && (
        <button
          type="button"
          disabled={nogNiet || bezig}
          title={nogNiet ? 'Er is de afgelopen 24 uur al een herinnering gestuurd' : undefined}
          onClick={() => {
            setOpen(true);
            setFout(null);
          }}
          className="mt-1 px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Herinnering sturen
        </button>
      )}
      {open && (
        <div className="mt-1 rounded border border-neutral-400 p-3 space-y-2" role="alertdialog" aria-label="Herinnering bevestigen">
          <p>
            Weet je zeker dat je een herinnering wilt sturen naar de collega?{' '}
            {tekst ? `De laatste herinnering was ${tekst}.` : 'Er is nog geen herinnering gestuurd.'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={bezig}
              onClick={verstuur}
              className="px-3 py-1 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              Ja, stuur herinnering
            </button>
            <button
              type="button"
              disabled={bezig}
              onClick={() => setOpen(false)}
              className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Annuleren
            </button>
          </div>
        </div>
      )}
      {fout && (
        <p role="alert" className="mt-1 text-red-700">
          {fout}
        </p>
      )}
    </div>
  );
}

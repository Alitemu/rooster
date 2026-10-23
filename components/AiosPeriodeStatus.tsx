/**
 * The status of an AIOS period at the top of its page, with the buttons to
 * close it and to open it again: as the header of the achterwacht's period
 * page has them (app/planner/period/[id]/page.tsx), on the AIOS's own
 * routes (lib/aiosStatus.ts). A copy, not shared with it
 * (docs/development/diensten.md, "Copied, not changed").
 *
 * Back to open is from GESLOTEN only: a made roster goes first. The button
 * is there in every status after closing, and says what to do first
 * instead of staying silent.
 */

'use client';

import { useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { eerstVerwijderenUitleg } from '@/lib/aiosTeksten';
import { foutTekst } from '@/lib/aiosFoutTekst';

const KLEUR: Record<string, string> = {
  CONCEPT: 'bg-neutral-100 text-neutral-800',
  OPEN: 'bg-blue-100 text-blue-800',
  GESLOTEN: 'bg-amber-100 text-amber-800',
  GEGENEREERD: 'bg-green-100 text-green-800',
  GEPUBLICEERD: 'bg-emerald-100 text-emerald-800',
};

const TEKST: Record<string, string> = {
  CONCEPT: '⚙️ Status: Concept',
  OPEN: '📖 Status: Open',
  GESLOTEN: '🔒 Status: Gesloten',
  GEGENEREERD: '🤖 Status: Gegenereerd',
  GEPUBLICEERD: '📝 Status: Gepubliceerd',
};

export function AiosPeriodeStatus({
  period,
  definitief = false,
  onChanged,
}: {
  period: { id: string; status: string };
  definitief?: boolean;
  onChanged: () => void;
}) {
  const [bezig, setBezig] = useState(false);
  const [zeker, setZeker] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  // Whether the planner asked and was told what comes first. The text is the one of the status now, so it
  // goes when the status changes (the roster removed under it, a publication taken back) and never says
  // something that no longer holds.
  const [vraagUitleg, setVraagUitleg] = useState(false);
  useEffect(() => {
    setVraagUitleg(false);
    setZeker(false);
  }, [period.status]);
  const uitleg = eerstVerwijderenUitleg(vraagUitleg, period.status);

  const doe = async (pad: string, fallback: string) => {
    setBezig(true);
    setFout(null);
    setVraagUitleg(false);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${period.id}/${pad}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
      setZeker(false);
      onChanged();
    } catch (err) {
      setZeker(false);
      setFout(foutTekst(err, fallback));
      // Another planner may have changed the status first: show the one it is now.
      onChanged();
    } finally {
      setBezig(false);
    }
  };

  const knop = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors';

  return (
    <div className="flex flex-col items-start gap-2" data-testid="aios-periode-status">
      <div className={`px-4 py-2 rounded font-semibold ${KLEUR[period.status] ?? KLEUR.CONCEPT}`}>
        {period.status === 'GEPUBLICEERD' ? (definitief ? '✅ Status: Definitief' : '📝 Status: Voorlopig gepubliceerd') : (TEKST[period.status] ?? period.status)}
      </div>

      {period.status === 'OPEN' && (
        <div className="flex flex-col items-start gap-2 max-w-sm">
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => (zeker ? doe('sluiten', 'Sluiten van de periode is mislukt') : setZeker(true))} disabled={bezig} className={knop}>
              {bezig ? 'Bezig met sluiten...' : zeker ? 'Zeker weten? Nogmaals klikken' : '🔒 Periode sluiten'}
            </button>
            {zeker && (
              <button type="button" onClick={() => setZeker(false)} className="px-4 py-2 rounded font-medium text-neutral-600 hover:text-neutral-800 transition-colors">
                Annuleren
              </button>
            )}
          </div>
          {zeker && (
            <p className="text-sm text-neutral-700">Na het sluiten kunnen de AIOS hun voorkeuren niet meer wijzigen. Terug naar open kan daarna nog.</p>
          )}
        </div>
      )}

      {['GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(period.status) && (
        <div className="flex flex-col items-start gap-2 max-w-sm">
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={bezig}
              className={knop}
              onClick={() => {
                if (period.status !== 'GESLOTEN') {
                  // Nothing to confirm: it is not possible yet, and says what comes first.
                  setFout(null);
                  setZeker(false);
                  setVraagUitleg(true);
                  return;
                }
                if (zeker) void doe('heropenen', 'Terug naar open is mislukt');
                else setZeker(true);
              }}
            >
              {bezig ? 'Bezig...' : zeker ? 'Zeker weten? Nogmaals klikken' : '↩️ Terug naar open'}
            </button>
            {zeker && (
              <button type="button" onClick={() => setZeker(false)} className="px-4 py-2 rounded font-medium text-neutral-600 hover:text-neutral-800 transition-colors">
                Annuleren
              </button>
            )}
          </div>
          {zeker && (
            <p className="text-sm text-neutral-700">De AIOS kunnen hun voorkeuren weer wijzigen tot de deadline. Verschuif die zo nodig daarna.</p>
          )}
          {uitleg && (
            <p role="status" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="aios-eerst-verwijderen">
              {uitleg}
            </p>
          )}
        </div>
      )}

      {fout && (
        <p role="alert" className="text-sm text-red-700 max-w-sm">
          {fout}
        </p>
      )}
    </div>
  );
}

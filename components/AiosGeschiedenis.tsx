'use client';

/**
 * What the AIOS did before the app, on the planner's page of an AIOS period
 * (docs/aios-rooster.md, "Eerlijkheid"; lib/aiosGeschiedenis.ts): the
 * template, the file back, first checked with per AIOS what it means for
 * their first quarter in the app (in words, never a signed number), then
 * saved. What is read in now stays in view.
 */

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import type { GeschiedenisPlan, GeschiedenisRij } from '@/lib/aiosGeschiedenis';

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const getal = (x: number) => x.toLocaleString('nl-NL', { maximumFractionDigits: 1 });

function Tabel({ rijen }: { rijen: GeschiedenisRij[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-neutral-600">
            <th className="py-1 pr-2 font-medium">AIOS</th>
            <th className="py-1 pr-2 font-medium text-right">Punten</th>
            <th className="py-1 pr-2 font-medium text-right">Feestdagdiensten</th>
            <th className="py-1 pr-2 font-medium text-right">Fte en maanden</th>
            <th className="py-1 font-medium">Eerste kwartaal in de app</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rijen.map((r) => (
            <tr key={r.codenaam}>
              <td className="py-1 pr-2">{r.codenaam}</td>
              <td className="py-1 pr-2 text-right">{getal(r.punten)}</td>
              <td className="py-1 pr-2 text-right">{r.feestdagdiensten}</td>
              <td className="py-1 pr-2 text-right whitespace-nowrap">
                {getal(r.fte)} · {getal(r.maanden)} mnd
              </td>
              <td className="py-1">{r.gevolg}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AiosGeschiedenis({ periodId }: { periodId: string }) {
  const [stand, setStand] = useState<{ rijen: GeschiedenisRij[]; ingelezen_op: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [bestand, setBestand] = useState<{ naam: string; data: string } | null>(null);
  const [plan, setPlan] = useState<GeschiedenisPlan | null>(null);
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ fout: boolean; tekst: string } | null>(null);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/geschiedenis`))
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Laden is mislukt');
        setStand(data.data);
      })
      .catch((err) => setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Laden is mislukt' }));
  }, [periodId]);
  useEffect(() => laad(), [laad]);

  const kies = async (file: File | undefined) => {
    setPlan(null);
    setMelding(null);
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      setBestand(null);
      setMelding({ fout: true, tekst: 'Kies een Excel-bestand (.xlsx). Sla het bestand in Excel op als "Excel-werkmap".' });
      return;
    }
    setBestand({ naam: file.name, data: toBase64(await file.arrayBuffer()) });
  };

  const stuur = async (toepassen: boolean) => {
    if (!bestand) return;
    setBezig(true);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/geschiedenis`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bestand: bestand.data, toepassen }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        if (data?.error?.plan) setPlan(data.error.plan);
        throw new Error(data?.error?.message || 'Inlezen is mislukt');
      }
      setPlan(data.data.plan);
      if (data.data.toegepast) {
        setMelding({ fout: false, tekst: 'Bewaard. Het telt mee vanaf de volgende keer dat je een rooster maakt.' });
        setBestand(null);
        setPlan(null);
        laad();
      }
    } catch (err) {
      setMelding({ fout: true, tekst: err instanceof Error ? err.message : 'Inlezen is mislukt' });
    } finally {
      setBezig(false);
    }
  };

  const knop = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';

  return (
    <div className="card card-padding space-y-3" data-testid="aios-geschiedenis">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">Geschiedenis van vóór de app</h2>
        <button type="button" className={knop} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Verbergen' : 'Tonen'}
        </button>
      </div>
      <p className="text-sm text-neutral-700">
        {stand && stand.rijen.length > 0
          ? `Ingelezen voor ${stand.rijen.length} AIOS.`
          : 'Nog niets ingelezen. Dan begint iedereen in het eerste kwartaal in de app gelijk.'}
      </p>
      {open && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-700">
            Vul per AIOS in wat die vóór de app deed: de diensten per soort, hoeveel daarvan op een feestdag, de gemiddelde fte en over hoeveel
            maanden. De app vergelijkt dat met het gemiddelde naar fte en maanden. Wie meer deed, krijgt in het eerste kwartaal in de app minder
            punten. Wie minder deed, krijgt er meer. Daarna schuift het verschil elk kwartaal vanzelf door. Inlezen vervangt wat er al stond.
          </p>
          {/* inline-block: an inline link's padding lay over the line above it on a phone. */}
          <a className={`${knop} inline-block`} href={withBasePath(`/api/aios/periode/${periodId}/geschiedenis-sjabloon`)}>
            Sjabloon downloaden
          </a>
          <label className="block text-sm">
            <span className="block text-xs font-medium text-neutral-700 mb-1">Ingevuld bestand</span>
            <input type="file" accept=".xlsx" aria-label="Excel-bestand met de geschiedenis" disabled={bezig} onChange={(e) => kies(e.target.files?.[0])} />
          </label>
          {bestand && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={knop} disabled={bezig} onClick={() => stuur(false)}>
                Controleren
              </button>
              {plan && plan.problemen.length === 0 && (
                <button type="button" className="btn-primary" disabled={bezig} onClick={() => stuur(true)}>
                  Bewaren
                </button>
              )}
            </div>
          )}
          {plan && plan.problemen.length > 0 && (
            <div className="rounded border-2 border-neutral-900 p-3 text-sm" role="alert">
              <p className="font-medium">Los dit eerst op in het bestand:</p>
              <ul className="list-disc pl-5">
                {plan.problemen.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          {plan && plan.problemen.length === 0 && (
            <div className="space-y-1" data-testid="aios-geschiedenis-voorbeeld">
              <p className="text-sm font-medium">Zo telt het bestand mee. Klopt het, klik dan op Bewaren.</p>
              <Tabel rijen={plan.rijen} />
            </div>
          )}
          {!plan && stand && stand.rijen.length > 0 && <Tabel rijen={stand.rijen} />}
        </div>
      )}
      {melding && (
        <p role={melding.fout ? 'alert' : 'status'} className={`text-sm ${melding.fout ? 'text-red-700' : 'text-neutral-800'}`}>
          {melding.tekst}
        </p>
      )}
    </div>
  );
}

'use client';

/**
 * The AIOS quarter's roster on the planner's page (docs/aios-rooster.md,
 * step 4): "Rooster maken" with the AIOS's solver (lib/aiosGenereren.ts),
 * polled while it runs, what stayed empty and why, the roster per week with
 * a block as one box, and per AIOS their points and dienstpercentage with a
 * bar: green under 25%, red above it (G13), and the words "boven 25%" so it
 * also reads in black and white.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import { PERCENTAGE_GRENS } from '@/lib/aiosFte';
import type { AiosRooster, AiosRoosterDag, AiosRoosterDienst } from '@/lib/aiosRooster';
import type { AiosGeneratieUitkomst } from '@/lib/aiosGenereren';

// The words for the solver's reasons (lib/aiosGenereren.ts REDEN_WOORDEN; repeated: that file is server code).
const REDEN: Record<string, string> = {
  BUITEN_LIDMAATSCHAP: 'niet in de pool op die dag',
  ONDERBREKING: 'onderbreking van de opleiding',
  AFWEZIG: 'afwezig',
  PARTTIMEDAG: 'parttimedag',
  GEBLOKKEERD: 'geblokkeerd',
  FULLTIME_NACHTBLOK: 'fulltime, dus geen nachtblok zo t/m di',
  INWERKEN: 'inwerken',
  BEZET: 'al een dienst of compensatiedag in de buurt',
};

const CODE_NAAM: Record<string, string> = {
  UD: 'Uitloopdienst',
  DD: 'Dagdienst',
  AD: 'Avonddienst',
  ADW: 'Avonddienst weekend',
  ND: 'Nachtdienst',
};

const TIJDEN = [
  { s: 60, label: '1 minuut' },
  { s: 120, label: '2 minuten' },
  { s: 300, label: '5 minuten' },
  { s: 600, label: '10 minuten' },
];

const DAG_KOP = ['wo', 'do', 'vr', 'za', 'zo', 'ma', 'di'];

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

const procent = (x: number) => `${(x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`;

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

type Rij = { label: string; vind: (d: AiosRoosterDag) => AiosRoosterDienst | undefined };

const RIJEN: Rij[] = [
  { label: 'Uitloop', vind: (d) => d.diensten.find((x) => x.code === 'UD') },
  { label: 'Dag', vind: (d) => d.diensten.find((x) => x.code === 'DD') },
  { label: 'Avond', vind: (d) => d.diensten.find((x) => x.code === 'AD' || x.code === 'ADW') },
  { label: 'Nacht', vind: (d) => d.diensten.find((x) => x.code === 'ND') },
];

/** Who has it, with a sign when that is against their mark (not by colour alone). */
function Wie({ dienst }: { dienst: AiosRoosterDienst }) {
  if (!dienst.aios) return <span className="italic">leeg</span>;
  const teken = dienst.markering === 'LIEVER_NIET' ? ' ~' : dienst.markering === 'ABSOLUUT' ? ' ✕' : dienst.markering === 'VOORKEUR' ? ' +' : '';
  return (
    <span>
      {dienst.aios.codenaam}
      {teken}
    </span>
  );
}

function RoosterWeek({ dagen }: { dagen: AiosRoosterDag[] }) {
  const weken = [...new Set(dagen.map((d) => d.iso_week))];
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-neutral-800">
        Week {weken.join(' en ')} · {datumKort(dagen[0].datum)} t/m {datumKort(dagen[dagen.length - 1].datum)}
      </p>
      <table className="w-full table-fixed border-collapse text-[10px] sm:text-xs">
        <thead>
          <tr>
            <th className="w-12 p-0.5 text-left font-medium text-neutral-600">Dienst</th>
            {dagen.map((d, i) => (
              <th
                key={d.datum}
                className={`p-0.5 text-center font-medium ${d.dag_soort === 'WERKDAG' ? 'text-neutral-600' : 'bg-neutral-100 text-neutral-900'}`}
                title={d.feestdag_naam ?? undefined}
              >
                {DAG_KOP[i]} {Number(d.datum.slice(8))}
                {d.feestdag_naam ? ' ★' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RIJEN.map((rij) => {
            const cellen: ReactNode[] = [];
            for (let i = 0; i < dagen.length; i++) {
              const dienst = rij.vind(dagen[i]);
              if (!dienst) {
                cellen.push(<td key={i} className="p-0.5" />);
                continue;
              }
              const leeg = !dienst.aios;
              const rand = leeg ? 'border-dashed border-red-600 text-red-800' : '';
              if (!dienst.blok || dienst.blok.vorm === 'LOS') {
                cellen.push(
                  <td key={i} className="p-0.5">
                    <span
                      className={`block truncate rounded border border-neutral-400 py-0.5 text-center ${rand}`}
                      title={`${CODE_NAAM[dienst.code]} ${datumKort(dagen[i].datum)}`}
                    >
                      <Wie dienst={dienst} />
                    </span>
                  </td>
                );
                continue;
              }
              // A block is one box over its days, with its AIOS once.
              const blok = dienst.blok;
              let j = i;
              while (j < dagen.length && rij.vind(dagen[j])?.blok?.id === blok.id) j++;
              cellen.push(
                <td key={i} colSpan={j - i} className="p-0.5">
                  <span
                    className={`block truncate rounded border-2 border-neutral-700 py-0.5 text-center ${rand}`}
                    title={`${blok.soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[blok.vorm]}`}
                  >
                    <Wie dienst={dienst} />
                  </span>
                </td>
              );
              i = j - 1;
            }
            return (
              <tr key={rij.label}>
                <td className="p-0.5 text-neutral-600">{rij.label}</td>
                {cellen}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Percentage({ waarde }: { waarde: number | null }) {
  if (waarde === null) return <span className="text-neutral-500">geen werkdagen</span>;
  const boven = waarde > PERCENTAGE_GRENS;
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2 w-16 overflow-hidden rounded bg-neutral-200" aria-hidden="true">
        <span className={`absolute inset-y-0 left-0 ${boven ? 'bg-red-600' : 'bg-green-600'}`} style={{ width: `${Math.min(100, (waarde / 0.4) * 100)}%` }} />
      </span>
      <span className={boven ? 'font-semibold text-red-800' : ''}>
        {procent(waarde)}
        {boven ? ' (boven 25%)' : ''}
      </span>
    </span>
  );
}

export function AiosRoosterMaken({ periodId, status, onChanged }: { periodId: string; status: string; onChanged: () => void }) {
  const [rooster, setRooster] = useState<(AiosRooster & { loopt: boolean }) | null>(null);
  const [tijd, setTijd] = useState(60);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [uitkomst, setUitkomst] = useState<AiosGeneratieUitkomst | null>(null);
  const [zeker, setZeker] = useState<'opnieuw' | 'verwijderen' | null>(null);
  const actief = useRef(true);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/rooster`))
      .then((res) => antwoord(res, 'Laden van het rooster is mislukt'))
      .then((data) => setRooster(data))
      .catch((err) => setFout(err instanceof Error ? err.message : 'Laden van het rooster is mislukt'));
  }, [periodId]);
  useEffect(() => {
    actief.current = true;
    laad();
    return () => {
      actief.current = false;
    };
  }, [laad, status]);

  const maken = async () => {
    setBezig(true);
    setFout(null);
    setUitkomst(null);
    setZeker(null);
    try {
      const start = await antwoord(
        await fetch(withBasePath(`/api/aios/periode/${periodId}/genereren`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tijdslimiet_seconden: tijd }),
        }),
        'Het rooster maken kon niet starten'
      );
      // Poll until done: a dropped poll just means asking again.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!actief.current) return;
        const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/genereren/status?job_id=${start.job_id}`)).catch(() => null);
        if (!res) continue;
        const data = await antwoord(res, 'Het rooster maken is mislukt');
        if (data.status === 'BEZIG') continue;
        if (data.status === 'FOUT') throw new Error(data.fout);
        setUitkomst(data.uitkomst);
        break;
      }
      onChanged();
      laad();
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Het rooster maken is mislukt');
    } finally {
      setBezig(false);
    }
  };

  const verwijderen = async () => {
    setBezig(true);
    setFout(null);
    setZeker(null);
    try {
      await antwoord(await fetch(withBasePath(`/api/aios/periode/${periodId}/rooster-verwijderen`), { method: 'POST' }), 'Verwijderen is mislukt');
      setUitkomst(null);
      onChanged();
      laad();
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Verwijderen is mislukt');
    } finally {
      setBezig(false);
    }
  };

  const weken: AiosRoosterDag[][] = [];
  for (const dag of rooster?.dagen ?? []) {
    if (weken.length === 0 || weken[weken.length - 1].length === 7) weken.push([]);
    weken[weken.length - 1].push(dag);
  }
  const gemaakt = status === 'GEGENEREERD';
  const knop = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';

  return (
    <div className="space-y-6">
      <div className="card card-padding space-y-3" data-testid="aios-rooster-maken">
        <h2 className="text-lg font-semibold">Rooster</h2>
        {status !== 'GESLOTEN' && !gemaakt ? (
          <p className="text-sm text-neutral-700">Sluit eerst de periode. Daarna kun je het rooster laten maken.</p>
        ) : (
          <>
            <p className="text-sm text-neutral-700">
              {gemaakt
                ? 'Het rooster is gemaakt. Je kunt het opnieuw laten maken. Dan wordt het hele rooster opnieuw gemaakt, ook wat je met de hand hebt veranderd.'
                : 'De solver van de AIOS maakt het rooster: per blok één AIOS, binnen de harde regels en zo eerlijk mogelijk naar fte.'}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm text-neutral-800">
                <span className="block text-xs font-medium text-neutral-600 mb-1">Hoe lang zoeken</span>
                <select value={tijd} onChange={(e) => setTijd(Number(e.target.value))} disabled={bezig} className="px-2 py-1 border rounded text-sm">
                  {TIJDEN.map((t) => (
                    <option key={t.s} value={t.s}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              {gemaakt && zeker !== 'opnieuw' ? (
                <button type="button" className={knop} disabled={bezig || rooster?.loopt} onClick={() => setZeker('opnieuw')}>
                  Opnieuw maken
                </button>
              ) : (
                <button type="button" className="btn-primary" disabled={bezig || rooster?.loopt} onClick={maken}>
                  {bezig ? 'Bezig met maken...' : gemaakt ? 'Ja, opnieuw maken' : 'Rooster maken'}
                </button>
              )}
              {gemaakt &&
                (zeker === 'verwijderen' ? (
                  <button type="button" className={knop} disabled={bezig} onClick={verwijderen}>
                    Ja, rooster verwijderen
                  </button>
                ) : (
                  <button type="button" className={knop} disabled={bezig || rooster?.loopt} onClick={() => setZeker('verwijderen')}>
                    Rooster verwijderen
                  </button>
                ))}
            </div>
            {zeker === 'verwijderen' && (
              <p className="text-sm text-neutral-700">Alle diensten worden weer leeg en de periode gaat terug naar gesloten.</p>
            )}
            {bezig && <p className="text-sm text-neutral-700">De solver is bezig. Dat duurt hoogstens zo lang als je hebt gekozen, plus een paar minuten.</p>}
          </>
        )}
        {fout && (
          <p role="alert" className="text-sm text-red-700">
            {fout}
          </p>
        )}
        {uitkomst && (
          <div className="rounded border border-neutral-300 p-3 text-sm space-y-1" role="status">
            <p className="font-medium">
              Klaar: {uitkomst.gevuld} diensten ingedeeld
              {uitkomst.leeg.length === 0 ? ', niets leeg.' : `. ${uitkomst.leeg.length} ${uitkomst.leeg.length === 1 ? 'dienst bleef' : 'diensten bleven'} leeg.`}
            </p>
            {uitkomst.status !== 'OPTIMAAL' && uitkomst.leeg.length > 0 && (
              <p className="text-neutral-700">Misschien vindt de solver meer met meer tijd. Kies een langere tijd en maak het opnieuw.</p>
            )}
            {uitkomst.leeg.length > 0 && (
              <ul className="list-disc pl-5 text-neutral-700">
                {uitkomst.leeg.map((l) => (
                  <li key={l.dienst_id}>
                    {CODE_NAAM[l.code]} {datumKort(l.datum)}:{' '}
                    {Object.entries(l.redenen)
                      .sort((a, b) => b[1] - a[1])
                      .map(([r, n]) => `${n} ${REDEN[r] ?? r}`)
                      .join(', ')}
                  </li>
                ))}
              </ul>
            )}
            {uitkomst.leeg.length > 0 && <p className="text-neutral-700">Een lege dienst vul je straks met de hand, voordat je publiceert.</p>}
          </div>
        )}
      </div>

      {gemaakt && rooster && (
        <>
          <div className="card card-padding space-y-3">
            <h2 className="text-lg font-semibold">Per AIOS</h2>
            <p className="text-sm text-neutral-600">
              Dienstpercentage: punten gedeeld door werkdagen keer fte. Boven 25% is te veel volgens het opleidingsplan. Dat is een
              waarschuwing, geen weigering.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-neutral-600">
                    <th className="py-1 pr-2 font-medium">AIOS</th>
                    <th className="py-1 pr-2 font-medium">Percentage</th>
                    <th className="py-1 pr-2 font-medium text-right">Punten</th>
                    <th className="py-1 pr-2 font-medium text-right" title="nachten, avonden, dagdiensten, uitloopdiensten">
                      N/A/D/U
                    </th>
                    <th className="py-1 font-medium text-right" title="ingedeeld op liever niet">
                      Liever niet
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rooster.per_aios.map((a) => (
                    <tr key={a.person_id}>
                      <td className="py-1 pr-2">
                        {a.codenaam}
                        <span className="block text-xs text-neutral-500">fte {a.fte.toLocaleString('nl-NL')}</span>
                      </td>
                      <td className="py-1 pr-2">
                        <Percentage waarde={a.dienstpercentage} />
                      </td>
                      <td className="py-1 pr-2 text-right">{a.punten.toLocaleString('nl-NL')}</td>
                      <td className="py-1 pr-2 text-right whitespace-nowrap">
                        {a.nachten}/{a.avonden}/{a.dagdiensten}/{a.uitloopdiensten}
                      </td>
                      <td className="py-1 text-right">{a.liever_niet + a.geblokkeerd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card card-padding space-y-4">
            <h2 className="text-lg font-semibold">Het rooster per week</h2>
            <p className="text-sm text-neutral-600">
              Een blok met een dikke rand doet één AIOS. ~ is liever niet, ✕ is een geblokkeerde dienst uit het deel boven de helft en +
              is een voorkeur. {rooster.leeg > 0 ? `${rooster.leeg} ${rooster.leeg === 1 ? 'dienst is' : 'diensten zijn'} leeg.` : ''}
            </p>
            {weken.map((w) => (
              <RoosterWeek key={w[0].datum} dagen={w} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

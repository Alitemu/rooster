'use client';

/**
 * The AIOS quarter's roster on the planner's page (docs/aios-rooster.md,
 * step 4): "Rooster maken" with the AIOS's solver (lib/aiosGenereren.ts),
 * polled while it runs, what stayed empty and why, the roster per week with
 * a block as one box, and per AIOS their points and dienstpercentage with a
 * bar: green under 25%, red above it (G13), and the words "boven 25%" so it
 * also reads in black and white. Above the button the questions about the
 * blocks around feestdagen (components/AiosFeestdagBlokken.tsx): no roster
 * before they are answered and saved.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosSectie } from '@/components/AiosSectie';
import { AiosFeestdagBlokken, type FeestdagStaat } from '@/components/AiosFeestdagBlokken';
import { AiosRoosterWijzigen, type Gewijzigd, type Keuze } from '@/components/AiosRoosterWijzigen';
import { AiosPubliceren } from '@/components/AiosPubliceren';
import { FellowVak } from '@/components/AiosVoortgangstoets';
import { BLOK_VORM_LABELS } from '@/lib/aiosDiensten';
import { KWARTALEN_WOORD, PERCENTAGE_GRENS } from '@/lib/aiosFte';
import type { AiosRooster, AiosRoosterDag, AiosRoosterDienst } from '@/lib/aiosRooster';
import type { AiosGeneratieUitkomst } from '@/lib/aiosGenereren';

// The words for the solver's reasons (lib/aiosGenereren.ts REDEN_WOORDEN; repeated: that file is server code).
const REDEN: Record<string, string> = {
  BUITEN_LIDMAATSCHAP: 'niet in de pool op die dag',
  ONDERBREKING: 'onderbreking van de opleiding',
  AFWEZIG: 'afwezig',
  PARTTIMEDAG: 'parttimedag',
  GEBLOKKEERD: 'geblokkeerd',
  FULLTIME_NACHTBLOK: 'fte 0,9 of meer, dus geen nachtblok zo t/m di',
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
  { label: 'Nacht', vind: (d) => d.diensten.find((x) => x.code === 'ND' && x.blok) },
];

// The second AIOS on New Year's Eve: a night without a block, only in the week it falls in.
const NACHT_2: Rij = { label: 'Nacht 2', vind: (d) => d.diensten.find((x) => x.code === 'ND' && !x.blok) };

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

interface Wijzigen {
  gekozen: Keuze | null;
  kies: (k: Keuze) => void;
  paneel: ReactNode;
}

/** A box: a button to change it when the roster can change by hand, marked when chosen (not by colour alone). */
function Vak({ dienst, keuze, w, className, title }: { dienst: AiosRoosterDienst; keuze: Keuze; w: Wijzigen | null; className: string; title: string }) {
  if (!w) {
    return (
      <span className={className} title={title}>
        <Wie dienst={dienst} />
      </span>
    );
  }
  const gekozen = w.gekozen?.dagen.some((d) => keuze.dagen.some((k) => k.slot_id === d.slot_id)) ?? false;
  return (
    <button
      type="button"
      className={`${className} w-full hover:bg-neutral-100 ${gekozen ? 'outline outline-2 outline-offset-1 outline-neutral-900' : ''}`}
      title={title}
      aria-pressed={gekozen}
      aria-label={`${title}: ${dienst.aios ? dienst.aios.codenaam : 'leeg'}. Wijzigen`}
      onClick={() => w.kies(keuze)}
    >
      <Wie dienst={dienst} />
    </button>
  );
}

function RoosterWeek({ dagen, w }: { dagen: AiosRoosterDag[]; w: Wijzigen | null }) {
  const weken = [...new Set(dagen.map((d) => d.iso_week))];
  const hierGekozen = !!w?.gekozen && dagen.some((d) => d.diensten.some((x) => x.slot_id === w.gekozen!.dagen[0].slot_id));
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
          {[...RIJEN, ...(dagen.some((d) => NACHT_2.vind(d)) ? [NACHT_2] : [])].map((rij) => {
            const cellen: ReactNode[] = [];
            for (let i = 0; i < dagen.length; i++) {
              const dienst = rij.vind(dagen[i]);
              if (!dienst) {
                cellen.push(
                  <td key={i} className="p-0.5">
                    {rij === RIJEN[3] && dagen[i].fellow_nacht && <FellowVak />}
                  </td>
                );
                continue;
              }
              const leeg = !dienst.aios;
              const rand = leeg ? 'border-dashed border-red-600 text-red-800' : '';
              if (!dienst.blok || dienst.blok.vorm === 'LOS') {
                const naam = dienst.blok ? (dienst.blok.soort === 'AVOND' ? 'Avonddienst' : 'Nachtdienst') : CODE_NAAM[dienst.code];
                cellen.push(
                  <td key={i} className="p-0.5">
                    <Vak
                      dienst={dienst}
                      keuze={{ naam, blok: false, dagen: [{ slot_id: dienst.slot_id, datum: dagen[i].datum }] }}
                      w={w}
                      className={`block truncate rounded border border-neutral-400 py-0.5 text-center ${rand}`}
                      title={`${naam} ${datumKort(dagen[i].datum)}`}
                    />
                  </td>
                );
                continue;
              }
              // A block is one box over its days, with its AIOS once (as long as one AIOS has them all).
              const blok = dienst.blok;
              let j = i;
              while (j < dagen.length && rij.vind(dagen[j])?.blok?.id === blok.id && rij.vind(dagen[j])?.aios?.id === dienst.aios?.id) j++;
              const naam = `${blok.soort === 'AVOND' ? 'Avondblok' : 'Nachtblok'} ${BLOK_VORM_LABELS[blok.vorm]}`;
              // Every day of the block in this week, also those another AIOS has.
              const blokDagen = dagen.flatMap((d) => {
                const x = rij.vind(d);
                return x?.blok?.id === blok.id ? [{ slot_id: x.slot_id, datum: d.datum }] : [];
              });
              cellen.push(
                <td key={i} colSpan={j - i} className="p-0.5">
                  <Vak
                    dienst={dienst}
                    keuze={{ naam, blok: true, dagen: blokDagen }}
                    w={w}
                    className={`block truncate rounded border-2 border-neutral-700 py-0.5 text-center ${rand}`}
                    title={naam}
                  />
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
      {hierGekozen && w!.paneel}
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

/** Over this quarter and the ones before it together: the opleidingsplan counts per opleidingsjaar (G1). */
function JaarPercentage({ waarde, kwartalen }: { waarde: number | null; kwartalen: number }) {
  if (kwartalen <= 1 || waarde === null) return <span className="block text-xs text-neutral-500">nog geen eerdere kwartalen</span>;
  const boven = waarde > PERCENTAGE_GRENS;
  return (
    <span className={`block text-xs ${boven ? 'font-semibold text-red-800' : 'text-neutral-600'}`}>
      {KWARTALEN_WOORD[kwartalen]} kwartalen samen: {procent(waarde)}
      {boven ? ' (boven 25%)' : ''}
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
  const [feestdag, setFeestdag] = useState<FeestdagStaat>({ open: 0, gewijzigd: false });
  const [gekozen, setGekozen] = useState<Keuze | null>(null);
  const [laatste, setLaatste] = useState<Gewijzigd | null>(null);
  const [terugFout, setTerugFout] = useState<string | null>(null);
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
    // A new roster: the change by hand before it is gone, and so its way back.
    setLaatste(null);
    setGekozen(null);
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
    setLaatste(null);
    setGekozen(null);
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

  const terugzetten = async () => {
    if (!laatste) return;
    setBezig(true);
    setTerugFout(null);
    try {
      await antwoord(
        await fetch(withBasePath(`/api/aios/periode/${periodId}/rooster/wijzigen`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wijzigingen: laatste.terug, ...(gepubliceerd ? { reden: 'Vorige wijziging ongedaan gemaakt' } : {}) }),
        }),
        'Ongedaan maken is mislukt'
      );
      setLaatste(null);
      laad();
    } catch (err) {
      setTerugFout(err instanceof Error ? err.message : 'Ongedaan maken is mislukt');
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
  // Published (step 4d): the roster stays in view and changes by hand with a reason, not made again.
  const gepubliceerd = status === 'GEPUBLICEERD';
  const zichtbaar = gemaakt || gepubliceerd;
  const nietKlaar = feestdag.open > 0 || feestdag.gewijzigd;
  const knop = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';

  const hint = rooster?.loopt || bezig ? 'Wordt gemaakt' : gepubliceerd ? 'Gepubliceerd' : gemaakt ? 'Gemaakt' : 'Nog niet gemaakt';

  return (
    <>
      {/* Kept loaded while closed: the choices about the feestdag blocks are not lost. */}
      <AiosSectie sleutel="rooster" titel="Rooster" testId="aios-rooster-maken" hint={hint} blijfGeladen>
        {gepubliceerd ? (
          <p className="text-sm text-neutral-700">
            Het rooster is gepubliceerd. Opnieuw maken kan dan niet meer. Trek daarvoor eerst de publicatie in. Met de hand aanpassen kan wel,
            met een reden.
          </p>
        ) : status !== 'GESLOTEN' && !gemaakt ? (
          <p className="text-sm text-neutral-700">Sluit eerst de periode. Daarna kun je het rooster laten maken.</p>
        ) : (
          <>
            <p className="text-sm text-neutral-700">
              {gemaakt
                ? 'Het rooster is gemaakt. Je kunt het opnieuw laten maken. Dan wordt het hele rooster opnieuw gemaakt, ook wat je met de hand hebt veranderd.'
                : 'De solver van de AIOS maakt het rooster: per blok één AIOS, binnen de harde regels en zo eerlijk mogelijk naar fte.'}
            </p>
            <AiosFeestdagBlokken periodId={periodId} status={status} disabled={bezig || !!rooster?.loopt} onStaat={setFeestdag} />
            {nietKlaar && (
              <p className="text-sm font-medium text-neutral-900">
                {feestdag.open > 0
                  ? 'Kies eerst bij elk blok rond de feestdagen wat ermee gebeurt en bewaar je keuzes.'
                  : 'Bewaar eerst je keuzes over de blokken rond de feestdagen.'}
              </p>
            )}
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
                <button type="button" className={knop} disabled={bezig || rooster?.loopt || nietKlaar} onClick={() => setZeker('opnieuw')}>
                  Opnieuw maken
                </button>
              ) : (
                <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={bezig || rooster?.loopt || nietKlaar} onClick={maken}>
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
      </AiosSectie>

      {zichtbaar && <AiosPubliceren periodId={periodId} status={status} onChanged={onChanged} />}

      {zichtbaar && rooster && (
        <>
          <AiosSectie sleutel="per-aios" titel="Per AIOS" hint="punten, dienstpercentage en saldo">
            <p className="text-sm text-neutral-600">
              Dienstpercentage: punten gedeeld door werkdagen keer fte. Boven 25% is te veel volgens het opleidingsplan. Dat is een
              waarschuwing, geen weigering. Het opleidingsplan telt per opleidingsjaar. Daarom staat eronder ook het percentage over
              dit kwartaal en de drie ervoor samen, met de geschiedenis van vóór de app. Het saldo is wat de AIOS meeneemt: wie vorig
              kwartaal minder deed dan het doel, krijgt er nu meer.
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
                    <th className="py-1 pr-2 font-medium text-right" title="ingedeeld op liever niet">
                      Liever niet
                    </th>
                    <th className="py-1 font-medium" title="uit het vorige kwartaal of van vóór de app">
                      Saldo
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
                        <JaarPercentage waarde={a.jaar_percentage} kwartalen={a.jaar_kwartalen} />
                      </td>
                      <td className="py-1 pr-2 text-right">{a.punten.toLocaleString('nl-NL')}</td>
                      <td className="py-1 pr-2 text-right whitespace-nowrap">
                        {a.nachten}/{a.avonden}/{a.dagdiensten}/{a.uitloopdiensten}
                      </td>
                      <td className="py-1 pr-2 text-right">{a.liever_niet + a.geblokkeerd}</td>
                      <td className="py-1 text-xs">
                        {a.saldo}
                        {a.saldo_bron === 'BEGINSTAND' && <span className="block text-neutral-500">van vóór de app</span>}
                        {a.saldo_bron === 'VORIG_KWARTAAL' && <span className="block text-neutral-500">uit het vorige kwartaal</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AiosSectie>
          <AiosSectie sleutel="rooster-week" titel="Het rooster per week" hint="kies een dienst of blok om het te wijzigen">
            {laatste && (
              <div className="rounded border border-neutral-400 p-3 text-sm space-y-1" role="status" data-testid="aios-laatste-wijziging">
                <p className="font-medium">Gewijzigd. {laatste.tekst}</p>
                {laatste.waarschuwingen.length > 0 && (
                  <ul className="list-disc pl-5 text-neutral-800">
                    {laatste.waarschuwingen.map((x) => (
                      <li key={x.tekst}>{x.tekst}</li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
                  disabled={bezig}
                  onClick={terugzetten}
                >
                  Ongedaan maken
                </button>
                {terugFout && (
                  <p role="alert" className="text-red-700">
                    {terugFout}
                  </p>
                )}
              </div>
            )}
            {rooster.overtredingen.length > 0 && (
              <div className="rounded border-2 border-dashed border-neutral-800 p-3 text-sm space-y-1" data-testid="aios-overtredingen">
                <p className="font-medium">⚠ Dit rooster breekt {rooster.overtredingen.length === 1 ? 'een harde regel' : `${rooster.overtredingen.length} keer een harde regel`}:</p>
                <ul className="list-disc pl-5 text-neutral-800">
                  {rooster.overtredingen.map((o, i) => (
                    <li key={i}>
                      {o.wie.join(' en ')}: {o.tekst} {o.datums.length > 0 && `(${o.datums.map(datumKort).join(', ')})`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-sm text-neutral-600">
              Tik op een blok of dienst om te kiezen wie die doet. Een blok met een dikke rand doet één AIOS. Een opgeknipt blok rond feestdagen staat per dag. ~ is liever niet, ✕ is een geblokkeerde dienst uit het deel boven de helft en +
              is een voorkeur. {rooster.leeg > 0 ? `${rooster.leeg} ${rooster.leeg === 1 ? 'dienst is' : 'diensten zijn'} leeg.` : ''}
            </p>
            {weken.map((week) => (
              <RoosterWeek
                key={week[0].datum}
                dagen={week}
                w={
                  rooster.loopt || bezig
                    ? null
                    : {
                        gekozen,
                        kies: setGekozen,
                        paneel: gekozen && (
                          <AiosRoosterWijzigen
                            key={gekozen.dagen.map((d) => d.slot_id).join()}
                            periodId={periodId}
                            keuze={gekozen}
                            metReden={gepubliceerd}
                            onGewijzigd={(g) => {
                              setLaatste(g);
                              setGekozen(null);
                              laad();
                            }}
                            onSluit={() => setGekozen(null)}
                          />
                        ),
                      }
                }
              />
            ))}
          </AiosSectie>
        </>
      )}
    </>
  );
}

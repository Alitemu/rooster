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

import { useCallback, useEffect, useRef, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { AiosSectie } from '@/components/AiosSectie';
import { AiosFeestdagBlokken, type FeestdagStaat } from '@/components/AiosFeestdagBlokken';
import { AiosPubliceren } from '@/components/AiosPubliceren';
import { KWARTALEN_WOORD, PERCENTAGE_GRENS } from '@/lib/aiosFte';
import type { AiosRooster } from '@/lib/aiosRooster';
import type { AiosLaatsteGeneratie } from '@/lib/aiosGenereren';
import { foutTekst } from '@/lib/aiosFoutTekst';
import { telwoord } from '@/lib/aiosTelwoord';

// The words for the solver's reasons (lib/aiosGenereren.ts REDEN_WOORDEN; repeated: that file is server code).
const REDEN: Record<string, string> = {
  BUITEN_LIDMAATSCHAP: 'niet in de pool op die dag',
  ONDERBREKING: 'onderbreking van de opleiding',
  AFWEZIG: 'afwezig',
  PARTTIMEDAG: 'parttimedag',
  GEBLOKKEERD: 'geblokkeerd',
  FULLTIME_NACHTBLOK: 'fte 0,9 of meer, dus geen nachtblok zo t/m di',
  INWERKEN: 'inwerken',
  KWARTAALGRENS: 'rust of compensatiedagen van het vorige kwartaal',
  BEZET: 'al een dienst of compensatiedag in de buurt',
};

const CODE_NAAM: Record<string, string> = {
  UD: 'Uitloopdienst',
  DD: 'Dagdienst',
  AD: 'Avonddienst',
  ADW: 'Avonddienst weekend',
  ND: 'Nachtdienst',
};

// Mirrors lib/aiosGenereren.ts AIOS_TIJDSLIMIETEN, AIOS_STANDAARD_TIJDSLIMIET and AIOS_MAX_MINUTEN (that module reads
// the database, so it can't be imported here). Ten minutes is the least on offer: shorter gave 30 AIOS a roster
// that looked finished and was not fair (0.902.0).
const TIJDEN = [
  { s: 600, label: '10 minuten' },
  { s: 900, label: '15 minuten' },
  { s: 1800, label: '30 minuten' },
];
const STANDAARD_TIJD = 600;
const MAX_MINUTEN = 60;
const EIGEN = 'eigen';

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

const procent = (x: number) => `${(x * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`;

async function antwoord(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
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

/** What the last generation told: how many were filled, and which diensten are still empty and why. */
function LegeDiensten({ generatie, kanOpnieuw }: { generatie: AiosLaatsteGeneratie; kanOpnieuw: boolean }) {
  const { leeg_bij_maken: bij, nog_leeg: nog } = generatie;
  const gemaakt = new Date(generatie.gemaakt_op).toLocaleString('nl-NL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded border border-neutral-300 p-3 text-sm space-y-1" role="status" data-testid="aios-lege-diensten">
      <p className="font-medium">
        Gemaakt op {gemaakt}: {telwoord(generatie.gevuld, 'dienst', 'diensten')} ingedeeld
        {bij === 0 ? ', niets leeg.' : `. ${bij} ${bij === 1 ? 'dienst bleef' : 'diensten bleven'} leeg.`}
      </p>
      {/* Whether the solver finished (0.902.0): a search cut short by the time looks just as finished, and with 30 AIOS
          two minutes gave one 5,6% and another 17,6%. */}
      {generatie.status === 'OPTIMAAL' ? (
        <p className="text-neutral-700" data-testid="aios-solver-klaar">
          De solver is klaar: dit is de eerlijkste verdeling binnen de regels.
        </p>
      ) : (
        <p className="font-medium text-amber-900" data-testid="aios-solver-klaar">
          De tijd was op voordat de solver klaar was{generatie.tijd_seconden >= 60 ? `, na ${Math.round(generatie.tijd_seconden / 60)} minuten` : ''}. Er kan
          een eerlijkere verdeling zijn
          {kanOpnieuw ? '. Maak het rooster opnieuw met meer tijd, bijvoorbeeld 30 minuten.' : '.'}
        </p>
      )}
      {(bij > 0 || nog.length > 0) && (
        <p className="font-medium" data-testid="aios-nog-leeg">
          {nog.length === 0
            ? 'Alle lege diensten zijn inmiddels met de hand ingevuld.'
            : `Nog leeg: ${nog.length} ${nog.length === 1 ? 'dienst' : 'diensten'}.`}
        </p>
      )}
      {nog.length > 0 && (
        <ul className="list-disc pl-5 text-neutral-700">
          {nog.map((l) => (
            <li key={l.dienst_id}>
              {CODE_NAAM[l.code]} {datumKort(l.datum)}:{' '}
              {Object.keys(l.redenen).length === 0
                ? 'leeg sinds het maken van het rooster'
                : Object.entries(l.redenen)
                    .sort((a, b) => b[1] - a[1])
                    .map(([r, n]) => `${n} ${REDEN[r] ?? r}`)
                    .join(', ')}
            </li>
          ))}
        </ul>
      )}
      {nog.length > 0 && <p className="text-neutral-700">Een lege dienst vul je met de hand, voordat je publiceert.</p>}
    </div>
  );
}

export function AiosRoosterMaken({
  periodId,
  status,
  versie,
  onChanged,
}: {
  periodId: string;
  status: string;
  /** Raised when the roster was changed by hand elsewhere (the section Dienstrooster): the numbers here are read again. */
  versie: number;
  onChanged: () => void;
}) {
  // `generatie`: what the last generation told, kept by the server (a refresh or another login shows it again).
  const [rooster, setRooster] = useState<(AiosRooster & { loopt: boolean; generatie: AiosLaatsteGeneratie | null }) | null>(null);
  const [tijdKeuze, setTijdKeuze] = useState<string>(String(STANDAARD_TIJD));
  const [eigenMinuten, setEigenMinuten] = useState('');
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [zeker, setZeker] = useState<'opnieuw' | 'verwijderen' | null>(null);
  const [feestdag, setFeestdag] = useState<FeestdagStaat>({ open: 0, gewijzigd: false });
  const actief = useRef(true);

  const laad = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/rooster`))
      .then((res) => antwoord(res, 'Laden van het rooster is mislukt'))
      .then((data) => setRooster(data))
      .catch((err) => setFout(foutTekst(err, 'Laden van het rooster is mislukt')));
  }, [periodId]);
  useEffect(() => {
    actief.current = true;
    laad();
    return () => {
      actief.current = false;
    };
  }, [laad, status, versie]);

  const eigenGeldig = /^\d+$/.test(eigenMinuten) && Number(eigenMinuten) >= 1 && Number(eigenMinuten) <= MAX_MINUTEN;
  const tijd = tijdKeuze === EIGEN ? (eigenGeldig ? Number(eigenMinuten) * 60 : null) : Number(tijdKeuze);

  const maken = async () => {
    setBezig(true);
    setFout(null);
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
        break;
      }
      onChanged();
      laad();
    } catch (err) {
      setFout(foutTekst(err, 'Het rooster maken is mislukt'));
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
      onChanged();
      laad();
    } catch (err) {
      setFout(foutTekst(err, 'Verwijderen is mislukt'));
    } finally {
      setBezig(false);
    }
  };

  const gemaakt = status === 'GEGENEREERD';
  // Published (step 4d): the roster stays in view and changes by hand with a reason, not made again.
  const gepubliceerd = status === 'GEPUBLICEERD';
  const zichtbaar = gemaakt || gepubliceerd;
  const nietKlaar = feestdag.open > 0 || feestdag.gewijzigd;
  const knop = 'px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50';

  const hint = rooster?.loopt || bezig ? 'Wordt gemaakt' : gepubliceerd ? 'Gepubliceerd' : gemaakt ? 'Gemaakt' : 'Nog niet gemaakt';
  // The roster can be made once the period is closed (and made again until it is published).
  const kanMaken = !gepubliceerd && (status === 'GESLOTEN' || gemaakt);
  const feestdagHint = feestdag.open > 0 ? 'nog te beantwoorden' : feestdag.gewijzigd ? 'nog te bewaren' : 'beantwoord';

  return (
    <>
      {/* Kept loaded while closed: the choices about the feestdag blocks are not lost. */}
      <div className="card p-4 space-y-3" data-testid="aios-rooster-maken">
        <p className="text-sm text-neutral-600" data-testid="aios-rooster-status">
          Status rooster: <span className="font-semibold text-neutral-900">{hint}</span>
        </p>
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
                <select value={tijdKeuze} onChange={(e) => setTijdKeuze(e.target.value)} disabled={bezig} className="px-2 py-1 border rounded text-sm">
                  {TIJDEN.map((t) => (
                    <option key={t.s} value={String(t.s)}>
                      {t.label}
                    </option>
                  ))}
                  <option value={EIGEN}>Zelf kiezen</option>
                </select>
              </label>
              {tijdKeuze === EIGEN && (
                <label className="text-sm text-neutral-800">
                  <span className="block text-xs font-medium text-neutral-600 mb-1">Aantal minuten (1 tot {MAX_MINUTEN})</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_MINUTEN}
                    step={1}
                    value={eigenMinuten}
                    onChange={(e) => setEigenMinuten(e.target.value)}
                    disabled={bezig}
                    className="w-24 px-2 py-1 border rounded text-sm"
                  />
                </label>
              )}
              {gemaakt && zeker !== 'opnieuw' ? (
                <button type="button" className={knop} disabled={bezig || rooster?.loopt || nietKlaar} onClick={() => setZeker('opnieuw')}>
                  Opnieuw maken
                </button>
              ) : (
                <button type="button" className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed" disabled={bezig || rooster?.loopt || nietKlaar || tijd === null} onClick={maken}>
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
            <p className="text-xs text-neutral-600" data-testid="aios-tijd-uitleg">
              Hoe langer de solver zoekt, hoe eerlijker de verdeling. Met een groep van 30 AIOS is 10 minuten het minimum, 30 minuten is beter.
              Je kunt de pagina intussen sluiten: het rooster wordt gewoon gemaakt.
              {tijdKeuze === EIGEN && !eigenGeldig ? ` Vul een heel aantal minuten in, van 1 tot ${MAX_MINUTEN}.` : ''}
            </p>
            {zeker === 'verwijderen' && (
              <p className="text-sm text-neutral-700">Alle diensten worden weer leeg en de periode gaat terug naar gesloten.</p>
            )}
            {bezig && (
              <p className="text-sm text-neutral-700">
                De solver is bezig. Dat duurt hoogstens zo lang als je hebt gekozen, plus een paar minuten. Je kunt de pagina sluiten en later
                terugkomen.
              </p>
            )}
          </>
        )}
        {fout && (
          <p role="alert" className="text-sm text-red-700">
            {fout}
          </p>
        )}
        {rooster?.generatie && <LegeDiensten generatie={rooster.generatie} kanOpnieuw={status === 'GEGENEREERD'} />}
        {zichtbaar && <AiosPubliceren periodId={periodId} status={status} onChanged={onChanged} />}
      </div>

      {/* Kept loaded while closed: the choices about the feestdag blocks are not lost, and the button above waits for them. */}
      {kanMaken && (
        <AiosSectie sleutel="feestdagblokken" titel="Blokken rond de feestdagen" hint={feestdagHint} blijfGeladen>
          <AiosFeestdagBlokken periodId={periodId} status={status} disabled={bezig || !!rooster?.loopt} onStaat={setFeestdag} />
        </AiosSectie>
      )}

    </>
  );
}

/** "Dienstpercentage en saldo": per AIOS, once the roster is made. Reads the roster again when `versie` changes. */
export function AiosDienstpercentage({ periodId, status, versie }: { periodId: string; status: string; versie: number }) {
  const [rooster, setRooster] = useState<AiosRooster | null>(null);
  useEffect(() => {
    if (status !== 'GEGENEREERD' && status !== 'GEPUBLICEERD') return;
    fetch(withBasePath(`/api/aios/periode/${periodId}/rooster`))
      .then((res) => antwoord(res, 'Laden van het rooster is mislukt'))
      .then((data) => setRooster(data))
      .catch(() => setRooster(null));
  }, [periodId, status, versie]);
  if ((status !== 'GEGENEREERD' && status !== 'GEPUBLICEERD') || !rooster) return null;
  return (
    <AiosSectie sleutel="dienstpercentage" titel="Dienstpercentage en saldo" hint="punten, dienstpercentage en saldo">
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
              <th className="py-1 pr-2 font-medium text-right" title="Aantal diensten waarop de AIOS is ingedeeld terwijl die dag liever niet of geblokkeerd was">
                Ingedeeld op liever niet dagen
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
  );
}

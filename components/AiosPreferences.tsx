'use client';

/**
 * The AIOS's preferences screen (docs/aios-rooster.md, "Verzoeken van de
 * AIOS"), the steps after Deeltijd on their personal link:
 * - AiosVoorkeuren: what they ask besides (4 avonden, 4 nachten, twee
 *   dagdiensten, inwerken, an onderbreking, algemene verzoeken) and every
 *   dienst of the quarter per week, Wednesday to Tuesday, with a block as
 *   one box: one tap marks the whole block (lib/aiosPreferences.ts). The
 *   50% counters warn and never refuse.
 * - AiosBevestigen: what they marked, and "Bevestigen en indienen".
 *
 * A tap cycles leeg, voorkeur, liever niet, geblokkeerd, as on the
 * achterwacht's calendar, skipping what the server would refuse:
 * geblokkeerd on a feestdag, and anything that says less than leave or a
 * part-time day on the same dienst or block. Each state has its own glyph,
 * so it reads without colour and in print.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { withBasePath } from '@/lib/basePath';
import { deadlineTekst } from '@/lib/verzendlijst';
import {
  blokkadeTellers,
  OPMERKING_MAX_LENGTH,
  telMarkeringen,
  TELLER_LABELS,
  vakKeuzes,
  vakStand,
  volgendeVakStand,
  type VoorkeurVak,
  type AiosVoorkeurDag,
  type AiosVoorkeurDienst,
  type AiosWens,
  type BlokkadeTeller,
  type Niveau,
} from '@/lib/aiosVoorkeur';

interface Scherm {
  period: { id: string; naam: string; start_datum: string; eind_datum: string; deadline: string; status: string };
  dagen: AiosVoorkeurDag[];
  wens: AiosWens;
  tellers: BlokkadeTeller[];
  indiening: { status: string; ingediend_op: string | null } | null;
  invoer: { open: true } | { open: false; reden: string };
}

type Stand = Niveau | null;

const GLYPH: Record<Niveau | 'LEEG', string> = { LEEG: '✓', VOORKEUR: '+', LIEVER_NIET: '~', ABSOLUUT: '✕' };
const STAND_LABEL: Record<Niveau | 'LEEG', string> = {
  LEEG: 'geen voorkeur',
  VOORKEUR: 'voorkeur',
  LIEVER_NIET: 'liever niet',
  ABSOLUUT: 'geblokkeerd',
};
const STAND_CLASS: Record<Niveau | 'LEEG', string> = {
  LEEG: 'calendar-cell-neutral',
  VOORKEUR: 'calendar-cell-voorkeur',
  LIEVER_NIET: 'calendar-cell-prefer-not',
  ABSOLUUT: 'calendar-cell-blocked',
};

const DAG_KOP = ['wo', 'do', 'vr', 'za', 'zo', 'ma', 'di'];

type Rij = { label: string; uitleg: string; vind: (d: AiosVoorkeurDag) => AiosVoorkeurDienst | undefined };

const RIJEN: Rij[] = [
  { label: 'Uitloop', uitleg: 'Uitloopdienst', vind: (d) => d.diensten.find((x) => x.code === 'UD') },
  { label: 'Dag', uitleg: 'Dagdienst', vind: (d) => d.diensten.find((x) => x.code === 'DD') },
  { label: 'Avond', uitleg: 'Avonddienst', vind: (d) => d.diensten.find((x) => x.code === 'AD' || x.code === 'ADW') },
  { label: 'Nacht', uitleg: 'Nachtdienst', vind: (d) => d.diensten.find((x) => x.code === 'ND') },
];

const datumKort = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
const datumLang = (datum: string) =>
  new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

async function json(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error?.message || fallback);
  return data.data;
}

function useAiosScherm(personId: string, periodId: string) {
  const [scherm, setScherm] = useState<Scherm | null>(null);
  const [laadFout, setLaadFout] = useState<string | null>(null);
  const laad = useCallback(async () => {
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/aios/${periodId}`));
      setScherm(await json(res, 'Je voorkeuren konden niet geladen worden. Probeer de pagina te vernieuwen.'));
      setLaadFout(null);
    } catch (err) {
      setLaadFout(err instanceof Error ? err.message : 'Je voorkeuren konden niet geladen worden.');
    }
  }, [personId, periodId]);
  useEffect(() => {
    void laad();
  }, [laad]);
  return { scherm, setScherm, laadFout, laad };
}

/** One box on the grid: a single dienst, or every dienst of a block. */
interface Vak extends VoorkeurVak {
  diensten: AiosVoorkeurDienst[];
}

function bronLabel(vak: Vak): 'AF' | 'PT' | null {
  if (vak.diensten.some((d) => d.bron === 'ABSENCE')) return 'AF';
  if (vak.diensten.some((d) => d.bron === 'PARTTIME')) return 'PT';
  return null;
}

function VakKnop({
  vak,
  blok,
  uitleg,
  bezig,
  readOnly,
  onKies,
}: {
  vak: Vak;
  blok: string | null;
  uitleg: string;
  bezig: boolean;
  readOnly: boolean;
  onKies: (vak: Vak, s: Stand) => void;
}) {
  const nu = vakStand(vak);
  const volgende = volgendeVakStand(vak);
  const vast = vakKeuzes(vak).length <= 1;
  const bron = bronLabel(vak);
  const sleutel = nu ?? 'LEEG';
  const codes = vak.diensten.map((d) => d.code);
  const code = blok ? codes[0] : codes.join(' ');
  const label =
    `${uitleg}${blok ? ` (${blok})` : ''}: ${STAND_LABEL[sleutel]}` +
    (bron === 'AF' ? ', door je afwezigheid' : bron === 'PT' ? ', door je parttimedag' : '') +
    (vast || readOnly ? '' : `. Tik voor ${STAND_LABEL[volgende ?? 'LEEG']}.`);
  return (
    <button
      type="button"
      onClick={() => onKies(vak, volgende)}
      disabled={bezig || readOnly || vast}
      aria-label={label}
      title={label}
      className={`${bron === 'AF' ? 'calendar-cell-absence' : bron === 'PT' ? 'calendar-cell-parttime' : STAND_CLASS[sleutel]}
        w-full h-9 rounded text-[11px] font-semibold leading-none flex items-center justify-center gap-0.5
        ${blok ? 'border-2 border-neutral-800' : ''} disabled:cursor-not-allowed disabled:opacity-80 active:scale-95`}
    >
      <span>{code}</span>
      <span aria-hidden="true">{bron ?? GLYPH[sleutel]}</span>
    </button>
  );
}

function Week({
  dagen,
  bezig,
  readOnly,
  onKies,
}: {
  dagen: AiosVoorkeurDag[];
  bezig: boolean;
  readOnly: boolean;
  onKies: (vak: Vak, s: Stand) => void;
}) {
  const weken = [...new Set(dagen.map((d) => d.iso_week))];
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-neutral-800">
        Week {weken.join(' en ')} · {datumKort(dagen[0].datum)} t/m {datumKort(dagen[dagen.length - 1].datum)}
      </p>
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr>
            <th className="w-12 p-0.5 text-left text-[11px] font-medium text-neutral-600">
              <span className="sr-only">Dienst</span>
            </th>
            {dagen.map((d, i) => (
              <th
                key={d.datum}
                scope="col"
                title={d.feestdag_naam ?? undefined}
                className={`p-0.5 text-center text-[11px] font-medium leading-tight ${
                  d.dag_soort === 'WERKDAG' ? 'text-neutral-600' : 'bg-neutral-100 text-neutral-900'
                }`}
              >
                {DAG_KOP[i]}
                <br />
                {Number(d.datum.slice(8))}
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
              if (!dienst.blok || dienst.blok.vorm === 'ZA' || dienst.blok.vorm === 'LOS') {
                cellen.push(
                  <td key={i} className="p-0.5">
                    <VakKnop
                      vak={{ diensten: [dienst], feestdag: dagen[i].dag_soort === 'FEESTDAG' }}
                      blok={null}
                      uitleg={`${rij.uitleg} ${datumLang(dagen[i].datum)}`}
                      bezig={bezig}
                      readOnly={readOnly}
                      onKies={onKies}
                    />
                  </td>
                );
                continue;
              }
              // A block is one box over its days (it never crosses the
              // Wednesday a week starts on).
              const blok = dienst.blok;
              const leden: AiosVoorkeurDienst[] = [];
              let feestdag = false;
              let j = i;
              while (j < dagen.length && dagen[j].datum <= blok.eind_datum) {
                const d = rij.vind(dagen[j]);
                if (d) leden.push(d);
                feestdag ||= dagen[j].dag_soort === 'FEESTDAG';
                j++;
              }
              cellen.push(
                <td key={i} colSpan={j - i} className="p-0.5">
                  <VakKnop
                    vak={{ diensten: leden, feestdag }}
                    blok={`blok ${datumKort(blok.start_datum)} t/m ${datumKort(blok.eind_datum)}`}
                    uitleg={rij.uitleg}
                    bezig={bezig}
                    readOnly={readOnly}
                    onKies={onKies}
                  />
                </td>
              );
              i = j - 1;
            }
            return (
              <tr key={rij.label}>
                <th scope="row" className="p-0.5 text-left text-[11px] font-medium text-neutral-600">
                  {rij.label}
                </th>
                {cellen}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Legenda() {
  const item = (cls: string, glyph: string, tekst: string) => (
    <span className="flex items-center gap-1.5">
      <i className={`${cls} inline-flex items-center justify-center w-6 h-5 rounded text-[10px] font-bold not-italic`}>{glyph}</i>
      {tekst}
    </span>
  );
  return (
    <div className="flex gap-x-4 gap-y-2 flex-wrap text-xs text-neutral-700">
      {item('calendar-cell-neutral border border-neutral-300', '✓', 'Geen voorkeur')}
      {item('calendar-cell-voorkeur', '+', 'Voorkeur')}
      {item('calendar-cell-prefer-not', '~', 'Liever niet')}
      {item('calendar-cell-blocked', '✕', 'Geblokkeerd')}
      {item('calendar-cell-parttime', 'PT', 'Parttimedag')}
      {item('calendar-cell-absence', 'AF', 'Afwezigheid')}
      {item('border-2 border-neutral-800 bg-white', 'AD', 'Blok: één AIOS doet het hele blok')}
      <span>★ Feestdag</span>
    </div>
  );
}

function Tellers({ tellers }: { tellers: BlokkadeTeller[] }) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold text-neutral-900">Hoeveel je hebt geblokkeerd</h3>
      <p className="text-sm text-neutral-600">
        Per soort mag je hoogstens de helft blokkeren. Je verlof en je parttimedagen tellen niet mee, de
        uitloopdiensten ook niet.
      </p>
      <ul className="space-y-1 text-sm">
        {tellers.map((t) => (
          <li key={t.groep} className={t.boven_helft ? 'rounded border border-amber-300 bg-amber-50 p-2 text-amber-950' : ''}>
            <span>
              {t.geblokkeerd} van de {t.totaal} {TELLER_LABELS[t.groep]} geblokkeerd, hoogstens {Math.floor(t.totaal / 2)}.
            </span>
            {t.boven_helft && (
              <span className="block mt-1">
                ⚠ Dat is meer dan de helft. Je kunt toch indienen, maar dan kan het rooster niet al je wensen volgen.
                Overleg zo nodig met de roosteraar.
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Verzoeken({
  personId,
  scherm,
  readOnly,
  onOpgeslagen,
  onGewijzigd,
}: {
  personId: string;
  scherm: Scherm;
  readOnly: boolean;
  onOpgeslagen: () => void;
  onGewijzigd: (gewijzigd: boolean) => void;
}) {
  const [wens, setWens] = useState<AiosWens>(scherm.wens);
  const [inwerken, setInwerken] = useState(Boolean(scherm.wens.inwerken_van));
  const [onderbreking, setOnderbreking] = useState(Boolean(scherm.wens.onderbreking_van));
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [gewijzigd, setGewijzigdState] = useState(false);
  const { start_datum: min, eind_datum: max } = scherm.period;

  const setGewijzigd = (g: boolean) => {
    setGewijzigdState(g);
    onGewijzigd(g);
  };
  const wijzig = (deel: Partial<AiosWens>) => {
    setWens((w) => ({ ...w, ...deel }));
    setMelding(null);
    setGewijzigd(true);
  };

  const opslaan = async () => {
    setBezig(true);
    setFout(null);
    setMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/aios/${scherm.period.id}/wens`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...wens,
          inwerken_van: inwerken ? wens.inwerken_van : null,
          inwerken_tot: inwerken ? wens.inwerken_tot : null,
          onderbreking_van: onderbreking ? wens.onderbreking_van : null,
          onderbreking_tot: onderbreking ? wens.onderbreking_tot : null,
        }),
      });
      await json(res, 'Opslaan van je verzoeken is mislukt.');
      setGewijzigd(false);
      setMelding('Je verzoeken zijn opgeslagen.');
      onOpgeslagen();
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Opslaan van je verzoeken is mislukt.');
    } finally {
      setBezig(false);
    }
  };

  const vinkje = (id: string, checked: boolean, onChange: (v: boolean) => void, titel: string, uitleg: string) => (
    <label htmlFor={id} className="flex items-start gap-3 text-sm">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0"
        checked={checked}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium text-neutral-900">{titel}</span>
        <span className="block text-neutral-600">{uitleg}</span>
      </span>
    </label>
  );

  const data = (soort: 'inwerken' | 'onderbreking') => (
    <div className="ml-8 grid grid-cols-2 gap-3">
      {(['van', 'tot'] as const).map((deel) => {
        const key = `${soort}_${deel}` as const;
        return (
          <div key={deel}>
            <label htmlFor={`aios-${key}`} className="block text-xs font-medium text-neutral-600 mb-1">
              {deel === 'van' ? 'Vanaf' : 'Tot en met'}
            </label>
            <input
              id={`aios-${key}`}
              type="date"
              min={min}
              max={max}
              disabled={readOnly}
              value={wens[key] ?? ''}
              onChange={(e) => wijzig({ [key]: e.target.value || null })}
              className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
            />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="card p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="font-bold text-lg">Je verzoeken voor dit kwartaal</h2>
        <p className="text-sm text-neutral-600">Vink aan wat voor jou geldt. Vergeet niet op te slaan.</p>
      </div>
      {vinkje('aios-vier-avonden', wens.vier_avonden, (v) => wijzig({ vier_avonden: v }), '4 avonden', 'Ik doe graag een avondblok van woensdag tot en met zaterdag.')}
      {vinkje('aios-vier-nachten', wens.vier_nachten, (v) => wijzig({ vier_nachten: v }), '4 nachten', 'Ik doe graag een nachtblok van woensdag tot en met zaterdag.')}
      {vinkje(
        'aios-twee-dagdiensten',
        wens.twee_dagdiensten,
        (v) => wijzig({ twee_dagdiensten: v }),
        'Twee dagdiensten',
        'Ik doe graag de dagdienst op zaterdag en op zondag van hetzelfde weekend.'
      )}
      {vinkje(
        'aios-inwerken',
        inwerken,
        (v) => {
          setInwerken(v);
          wijzig(v ? {} : { inwerken_van: null, inwerken_tot: null });
        },
        'Inwerken',
        'Word je dit kwartaal ingewerkt? Dan krijg je in die tijd alleen uitloopdiensten en de dagdiensten op zaterdag en zondag, want dan is er hulp. Geen dagdienst op een feestdag door de week. Na de einddatum kun je voor alles worden ingepland.'
      )}
      {inwerken && data('inwerken')}
      {vinkje(
        'aios-onderbreking',
        onderbreking,
        (v) => {
          setOnderbreking(v);
          wijzig(v ? {} : { onderbreking_van: null, onderbreking_tot: null });
        },
        'Onderbreking van de opleiding',
        'Een wetenschappelijke periode of zwangerschapsverlof. In die tijd krijg je geen diensten en die dagen tellen niet mee voor je dienstpercentage.'
      )}
      {onderbreking && data('onderbreking')}
      <div>
        <label htmlFor="aios-opmerking" className="block text-sm font-medium text-neutral-900 mb-1">
          Algemene verzoeken
        </label>
        <input
          id="aios-opmerking"
          type="text"
          maxLength={OPMERKING_MAX_LENGTH}
          disabled={readOnly}
          value={wens.opmerking ?? ''}
          onChange={(e) => wijzig({ opmerking: e.target.value })}
          placeholder="Bijvoorbeeld: liever geen nachten in maart"
          className="w-full px-3 py-2 border border-neutral-300 rounded text-sm"
        />
        <p className="text-xs text-neutral-500 mt-1">
          {(wens.opmerking ?? '').length} van de {OPMERKING_MAX_LENGTH} tekens
        </p>
      </div>
      {fout && (
        <div role="alert" className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
          {fout}
        </div>
      )}
      {melding && <div className="p-3 rounded bg-green-50 border border-green-200 text-sm text-green-900">{melding}</div>}
      {!readOnly && (
        <button type="button" onClick={opslaan} disabled={bezig || !gewijzigd} className="btn-primary w-full sm:w-auto">
          {bezig ? 'Opslaan...' : gewijzigd ? 'Verzoeken opslaan' : 'Opgeslagen'}
        </button>
      )}
    </div>
  );
}

export function AiosVoorkeuren({
  personId,
  periodId,
  readOnly,
  onTerug,
  onVolgende,
}: {
  personId: string;
  periodId: string;
  readOnly: boolean;
  onTerug: () => void;
  onVolgende: () => void;
}) {
  const { scherm, setScherm, laadFout, laad } = useAiosScherm(personId, periodId);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [verzoekenGewijzigd, setVerzoekenGewijzigd] = useState(false);
  const [waarschuwing, setWaarschuwing] = useState<string | null>(null);

  const kies = async (vak: Vak, nieuw: Stand) => {
    if (!scherm) return;
    const eigen = vak.diensten.filter((d) => !d.level || d.bron === 'MANUAL');
    if (eigen.length === 0) return;
    setBezig(true);
    setFout(null);
    // Shown at once, the counters too; the server's answer follows.
    const ids = new Set(eigen.map((d) => d.slot_id));
    const dagen = scherm.dagen.map((dag) => ({
      ...dag,
      diensten: dag.diensten.map((d) => (ids.has(d.slot_id) ? { ...d, level: nieuw, bron: nieuw ? ('MANUAL' as const) : null } : d)),
    }));
    setScherm({ ...scherm, dagen, tellers: blokkadeTellers(dagen) });
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/aios/${periodId}/slot/${eigen[0].slot_id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: nieuw }),
      });
      await json(res, 'Opslaan is mislukt. Probeer het opnieuw.');
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Opslaan is mislukt. Probeer het opnieuw.');
    } finally {
      await laad();
      setBezig(false);
    }
  };

  if (laadFout) return <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-800">{laadFout}</div>;
  if (!scherm) return <div className="card p-8 text-center text-neutral-600">Diensten laden...</div>;

  const weken: AiosVoorkeurDag[][] = [];
  for (const dag of scherm.dagen) {
    if (weken.length === 0 || weken[weken.length - 1].length === 7) weken.push([]);
    weken[weken.length - 1].push(dag);
  }
  const feestdagen = scherm.dagen.filter((d) => d.feestdag_naam);

  return (
    <div className="space-y-4">
      <Verzoeken
        personId={personId}
        scherm={scherm}
        readOnly={readOnly}
        onOpgeslagen={() => void laad()}
        onGewijzigd={(g) => {
          setVerzoekenGewijzigd(g);
          if (!g) setWaarschuwing(null);
        }}
      />

      <div className="card p-3 sm:p-6 space-y-4">
        <div className="space-y-1">
          <h2 className="font-bold text-lg">Je voorkeuren per dienst</h2>
          <p className="text-sm text-neutral-600">
            Tik op een dienst om te wisselen tussen geen voorkeur, voorkeur, liever niet en geblokkeerd. Een vak met
            een dikke rand is een blok: één AIOS doet het hele blok, dus je kiest voor het hele blok tegelijk.
          </p>
          <p className="text-sm text-neutral-600">
            Op een feestdag kun je niet blokkeren, want de feestdagen worden eerlijk verdeeld. Liever niet kan wel.
          </p>
        </div>
        <Legenda />
        {fout && (
          <div role="alert" className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
            {fout}
          </div>
        )}
        {weken.map((week) => (
          <Week key={week[0].datum} dagen={week} bezig={bezig} readOnly={readOnly} onKies={kies} />
        ))}
        {feestdagen.length > 0 && (
          <div className="text-sm text-neutral-700">
            <p className="font-medium">Feestdagen in dit kwartaal</p>
            <ul className="list-disc pl-5">
              {feestdagen.map((d) => (
                <li key={d.datum}>
                  {d.feestdag_naam} ({datumKort(d.datum)})
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card p-4 sm:p-6">
        <Tellers tellers={scherm.tellers} />
      </div>

      {waarschuwing && (
        <div role="alert" className="p-3 rounded bg-amber-50 border border-amber-300 text-sm text-amber-950">
          {waarschuwing}
        </div>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onTerug}
          className="flex-1 py-3 px-4 rounded font-semibold bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
        >
          Terug
        </button>
        <button
          type="button"
          onClick={() =>
            verzoekenGewijzigd && !readOnly
              ? setWaarschuwing('Je verzoeken bovenaan zijn nog niet opgeslagen. Sla ze eerst op.')
              : onVolgende()
          }
          className="flex-1 py-3 px-4 rounded font-semibold bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 transition-colors"
        >
          Volgende: bevestigen
        </button>
      </div>
    </div>
  );
}

const aantal = (n: number, enkel: string, meer: string) => `${n} ${n === 1 ? enkel : meer}`;

export function AiosBevestigen({
  personId,
  periodId,
  readOnly,
  onIngediend,
}: {
  personId: string;
  periodId: string;
  readOnly: boolean;
  onIngediend: () => void;
}) {
  const { scherm, laadFout } = useAiosScherm(personId, periodId);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  if (laadFout) return <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-800">{laadFout}</div>;
  if (!scherm) return <div className="card p-8 text-center text-neutral-600">Laden...</div>;

  const telling = telMarkeringen(scherm.dagen);
  const w = scherm.wens;
  const verzoeken = [
    w.vier_avonden && '4 avonden',
    w.vier_nachten && '4 nachten',
    w.twee_dagdiensten && 'twee dagdiensten',
    w.inwerken_van && w.inwerken_tot && `inwerken van ${datumLang(w.inwerken_van)} tot en met ${datumLang(w.inwerken_tot)}`,
    w.onderbreking_van &&
      w.onderbreking_tot &&
      `onderbreking van ${datumLang(w.onderbreking_van)} tot en met ${datumLang(w.onderbreking_tot)}`,
  ].filter((x): x is string => Boolean(x));
  const ingediend = scherm.indiening?.status === 'BEVESTIGD';

  const indienen = async () => {
    setBezig(true);
    setFout(null);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/aios/${periodId}/indienen`), { method: 'POST' });
      await json(res, 'Indienen is mislukt. Probeer het opnieuw.');
      onIngediend();
    } catch (err) {
      setFout(err instanceof Error ? err.message : 'Indienen is mislukt. Probeer het opnieuw.');
    } finally {
      setBezig(false);
    }
  };

  return (
    <div className="card p-4 sm:p-6 space-y-4">
      <h2 className="font-bold text-lg">Bevestigen</h2>
      <ul className="list-disc pl-5 text-sm text-neutral-800 space-y-1">
        <li>{aantal(telling.VOORKEUR, 'dienst of blok met voorkeur', 'diensten of blokken met voorkeur')}</li>
        <li>{aantal(telling.LIEVER_NIET, 'dienst of blok liever niet', 'diensten of blokken liever niet')}</li>
        <li>{aantal(telling.ABSOLUUT, 'dienst of blok geblokkeerd', 'diensten of blokken geblokkeerd')}</li>
        <li>{verzoeken.length > 0 ? `Verzoeken: ${verzoeken.join(', ')}.` : 'Geen verzoeken aangevinkt.'}</li>
        {w.opmerking && <li>Algemene verzoeken: {w.opmerking}</li>}
      </ul>
      <Tellers tellers={scherm.tellers} />
      {ingediend && scherm.indiening?.ingediend_op && (
        <p className="text-sm text-green-800">
          Je hebt je voorkeuren ingediend op{' '}
          {new Date(scherm.indiening.ingediend_op).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' })}.
          Wat je daarna nog wijzigt, telt ook mee.
        </p>
      )}
      {fout && (
        <div role="alert" className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
          {fout}
        </div>
      )}
      {readOnly || !scherm.invoer.open ? (
        <p className="text-sm text-neutral-700">
          {scherm.invoer.open ? 'Indienen kan niet meer.' : scherm.invoer.reden}
        </p>
      ) : (
        <>
          <p className="text-sm text-neutral-600">
            Tot de deadline ({deadlineTekst(scherm.period.deadline)}) kun je alles nog aanpassen.
          </p>
          <button type="button" onClick={indienen} disabled={bezig} className="btn-primary w-full">
            {bezig ? 'Indienen...' : ingediend ? 'Opnieuw indienen' : 'Bevestigen en indienen'}
          </button>
        </>
      )}
    </div>
  );
}

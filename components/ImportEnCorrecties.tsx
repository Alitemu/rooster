/**
 * The section "Import en correcties" on the period page of the achterwacht:
 * a beginsaldo from an Excel file and handmatige correcties, also after the
 * period has opened. The setup wizard does both at the opening; a planner
 * who forgot it there had no way back (1.1.0).
 *
 * Both are ledger entries for this period, and generate-roster reads the
 * ledger when it starts: whatever is saved here before the roster is
 * generated is in it. After that the routes refuse (a roster made without
 * it would not match the saldo shown), so the controls are only there while
 * the period is open or closed. The sjabloon can always be downloaded.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { withBasePath } from '@/lib/basePath';
import { readUploadedRows } from '@/lib/sheetUpload';
import { leesSaldoBestand, type SaldoRegel } from '@/lib/saldoBestand';
import { CorrectieFormulier } from '@/components/CorrectieFormulier';
import { foutTekst } from '@/lib/foutTekst';
import { telwoord } from '@/lib/telwoord';
import { kanSaldoWijzigen, saldoInWoorden } from '@/lib/saldoWijzigen';

interface Props {
  periodId: string;
  status: string;
  mensen: Array<{ person_id: string; codenaam: string }>;
  /** After a saved change: the dashboard reloads what depends on the saldo. */
  onGewijzigd?: () => void;
}

interface OpgeslagenCorrectie {
  codenaam: string;
  teller: 'AVOND' | 'WEEKEND' | 'FEESTDAG';
  delta: number;
  reden: string;
  aangemaakt_op: string;
}

const BIJGEWERKT =
  'Het bereik dat de deelnemers zien, is meteen bijgewerkt. Heeft iemand de voorkeuren al ingediend, laat dan weten dat het bereik is veranderd.';

export function ImportEnCorrecties({ periodId, status, mensen, onGewijzigd }: Props) {
  const kan = kanSaldoWijzigen(status);

  const [beginsaldi, setBeginsaldi] = useState<Array<{ codenaam: string; avond: number; weekend: number }>>([]);
  const [correcties, setCorrecties] = useState<OpgeslagenCorrectie[]>([]);
  const [laadFout, setLaadFout] = useState<string | null>(null);

  const [regels, setRegels] = useState<SaldoRegel[]>([]);
  const [waarschuwingen, setWaarschuwingen] = useState<string[]>([]);
  // A beginsaldo that is there already is replaced by the file: asked first.
  const [overschrijfVraag, setOverschrijfVraag] = useState<string[] | null>(null);
  const [importBezig, setImportBezig] = useState(false);
  const [importMelding, setImportMelding] = useState<{ fout: boolean; tekst: string } | null>(null);
  const [bestandSleutel, setBestandSleutel] = useState(0);

  const [correctieMelding, setCorrectieMelding] = useState<{ fout: boolean; tekst: string } | null>(null);

  const laad = useCallback(async () => {
    try {
      const [saldoRes, corrRes] = await Promise.all([
        fetch(withBasePath(`/api/planner/period/${periodId}/import-balances`)),
        fetch(withBasePath(`/api/planner/period/${periodId}/ledger-corrections`)),
      ]);
      const saldo = await saldoRes.json();
      const corr = await corrRes.json();
      if (!saldoRes.ok || !corrRes.ok) throw new Error(saldo?.error?.message || corr?.error?.message || 'Laden mislukt');
      setBeginsaldi(saldo.data.personen);
      setCorrecties(corr.data.correcties);
      setLaadFout(null);
    } catch (err) {
      setLaadFout(foutTekst(err, 'De saldi konden niet worden geladen.'));
    }
  }, [periodId]);

  useEffect(() => {
    laad();
  }, [laad]);

  const kiesBestand = async (file: File) => {
    setImportMelding(null);
    setOverschrijfVraag(null);
    let rijen: string[][];
    try {
      rijen = await readUploadedRows(file);
    } catch (err) {
      setRegels([]);
      setWaarschuwingen([foutTekst(err, 'Het bestand kon niet worden gelezen.')]);
      return;
    }
    const gelezen = leesSaldoBestand(rijen);
    if ('fout' in gelezen) {
      setRegels([]);
      setWaarschuwingen([gelezen.fout]);
      return;
    }
    setRegels(gelezen.rows);
    setWaarschuwingen(gelezen.warnings);
  };

  const importeer = async (bevestigd: boolean) => {
    setImportBezig(true);
    setImportMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/import-balances`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: regels, ...(bevestigd ? { bevestigd: true } : {}) }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 409 && data?.error?.code === 'SALDO_BESTAAT') {
        setOverschrijfVraag((data.data?.codenamen as string[]) ?? []);
        return;
      }
      if (!res.ok) throw new Error(data?.error?.message || 'Importeren mislukt');
      const fouten: string[] = data.data.errors ?? [];
      setOverschrijfVraag(null);
      setRegels([]);
      setWaarschuwingen([]);
      setBestandSleutel((k) => k + 1);
      setImportMelding({
        fout: false,
        tekst:
          `Beginsaldo geïmporteerd voor ${telwoord(data.data.personen, 'persoon', 'personen')}. ${BIJGEWERKT}` +
          (fouten.length > 0 ? ` Overgeslagen: ${fouten.join(' ')}` : ''),
      });
      await laad();
      onGewijzigd?.();
    } catch (err) {
      setImportMelding({ fout: true, tekst: foutTekst(err, 'Importeren mislukt') });
    } finally {
      setImportBezig(false);
    }
  };

  const slaCorrectieOp = async (persoon: { person_id: string; codenaam: string }, rows: Array<{ type: string; reden: string; aantal: number }>) => {
    setCorrectieMelding(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/ledger-corrections`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corrections: rows.map((r) => ({ person_id: persoon.person_id, ...r })) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message || 'Opslaan van de correctie mislukt');
      setCorrectieMelding({ fout: false, tekst: `Correctie voor ${persoon.codenaam} opgeslagen. ${BIJGEWERKT}` });
      await laad();
      onGewijzigd?.();
      return true;
    } catch (err) {
      setCorrectieMelding({ fout: true, tekst: foutTekst(err, 'Opslaan van de correctie mislukt') });
      return false;
    }
  };

  return (
    <div className="space-y-6" data-testid="import-en-correcties">
      <p className="text-sm text-neutral-600">
        Een beginsaldo of een correctie telt mee als het rooster wordt gegenereerd. Toevoegen kan zolang er voor deze
        periode nog geen rooster is gegenereerd, ook als de uitnodigingen al zijn verstuurd.
      </p>

      {!kan && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900" data-testid="saldo-dicht">
          {status === 'GEGENEREERD'
            ? 'Voor deze periode is al een rooster gegenereerd. Een beginsaldo of correctie telt alleen mee in een nieuw rooster. Kies daarvoor eerst Rooster verwijderen of Terug naar open.'
            : 'Het rooster van deze periode is gepubliceerd. Een correctie zet je nu in de volgende periode.'}
        </div>
      )}

      {laadFout && <p className="text-sm text-red-700">{laadFout}</p>}

      <div className="space-y-3">
        <h3 className="font-semibold text-neutral-900">Beginsaldo importeren</h3>
        <p className="text-sm text-neutral-600">
          Hoeveel diensten iemand per diensttype meer of minder moet krijgen dan het eigen streefaantal. Download het
          sjabloon, vul de twee kolommen in en upload het Excel-bestand weer. Een getal met min-teken (-1) betekent 1 dienst
          minder in deze periode, een getal zonder teken (2) betekent 2 diensten extra. Een leeg vakje telt als 0.
        </p>
        <a
          href={withBasePath(`/api/planner/period/${periodId}/import-balances/sjabloon`)}
          className="inline-block px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
        >
          Sjabloon downloaden (Excel)
        </a>
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
          Alleen nodig voor de eerste periode die je in deze app roostert. Is de vorige periode hier gepubliceerd, dan neemt
          de app het saldo daaruit vanzelf mee. Een import telt daar nog eens bij op.
        </div>

        {kan && (
          <>
            <label className="block text-sm font-medium text-neutral-700">
              Ingevuld sjabloon
              <input
                key={bestandSleutel}
                type="file"
                accept=".xlsx"
                aria-label="Beginsaldo als Excel-bestand"
                className="block w-full mt-1 text-sm"
                onChange={(e) => e.target.files?.[0] && kiesBestand(e.target.files[0])}
              />
            </label>

            {waarschuwingen.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
                <p className="font-medium">Let op bij het inlezen van dit bestand:</p>
                <ul className="text-xs mt-1 space-y-0.5 list-disc pl-4">
                  {waarschuwingen.slice(0, 10).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {waarschuwingen.length > 10 && <li>...en {waarschuwingen.length - 10} meer</li>}
                </ul>
              </div>
            )}

            {regels.length > 0 && !overschrijfVraag && (
              <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-900 space-y-2">
                <p className="font-medium">{telwoord(regels.length, 'regel', 'regels')} klaar om te importeren</p>
                <button
                  type="button"
                  onClick={() => importeer(false)}
                  disabled={importBezig}
                  className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {importBezig ? 'Bezig...' : 'Importeren'}
                </button>
              </div>
            )}

            {overschrijfVraag && (
              <div role="alert" data-testid="saldo-overschrijven" className="bg-amber-50 border border-amber-300 rounded p-3 text-sm text-amber-900 space-y-2">
                <p className="font-medium">
                  {overschrijfVraag.length === 1 ? 'Voor 1 persoon staat' : `Voor ${overschrijfVraag.length} personen staat`} al een beginsaldo.
                </p>
                <p>
                  Importeren overschrijft die waarden, ook als een vakje in het bestand leeg is: dat wordt 0. Wie niet in het
                  bestand staat, houdt het eigen saldo. Weet je het zeker?
                </p>
                <p className="text-xs">
                  {overschrijfVraag.slice(0, 8).join(', ')}
                  {overschrijfVraag.length > 8 && ` en ${overschrijfVraag.length - 8} anderen`}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => importeer(true)}
                    disabled={importBezig}
                    className="px-3 py-1 rounded bg-amber-700 text-white hover:bg-amber-800 disabled:opacity-50"
                  >
                    Ja, overschrijven
                  </button>
                  <button type="button" onClick={() => setOverschrijfVraag(null)} className="px-3 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
                    Annuleren
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {importMelding && (
          <p role="status" className={`text-sm ${importMelding.fout ? 'text-red-700' : 'text-emerald-800'}`}>
            {importMelding.tekst}
          </p>
        )}

        {beginsaldi.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-neutral-700">
              {telwoord(beginsaldi.length, 'persoon heeft', 'personen hebben')} een beginsaldo
            </summary>
            <ul className="mt-2 space-y-0.5" data-testid="beginsaldi">
              {beginsaldi.map((b) => (
                <li key={b.codenaam}>
                  <span className="font-medium">{b.codenaam}</span>:{' '}
                  {[b.avond !== 0 && saldoInWoorden('AVOND', b.avond), b.weekend !== 0 && saldoInWoorden('WEEKEND', b.weekend)]
                    .filter(Boolean)
                    .join(', ') || 'geen verschil'}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="space-y-3 border-t border-neutral-100 pt-4">
        <h3 className="font-semibold text-neutral-900">Correctie toevoegen</h3>
        <p className="text-sm text-neutral-600">
          Corrigeer het saldo van een medewerker voor een uitzonderlijke situatie, bijvoorbeeld een dienst die iemand op het
          laatste moment overnam of een ongelijke ruil. Een correctie wordt meteen opgeslagen.
        </p>
        {kan && <CorrectieFormulier mensen={mensen} knopTekst="Correctie opslaan" onToevoegen={slaCorrectieOp} altijdOpen />}
        {correctieMelding && (
          <p role="status" className={`text-sm ${correctieMelding.fout ? 'text-red-700' : 'text-emerald-800'}`}>
            {correctieMelding.tekst}
          </p>
        )}

        {correcties.length > 0 && (
          <div className="border rounded overflow-x-auto">
            <table className="w-full text-sm" data-testid="correcties">
              <caption className="sr-only">Correcties in deze periode</caption>
              <thead className="bg-neutral-100">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Persoon</th>
                  <th className="px-3 py-2 text-left font-medium">Dienst</th>
                  <th className="px-3 py-2 text-left font-medium">Reden</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {correcties.map((c, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-medium">{c.codenaam}</td>
                    <td className="px-3 py-2">{saldoInWoorden(c.teller, c.delta)}</td>
                    <td className="px-3 py-2">{c.reden}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}


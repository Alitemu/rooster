/**
 * The form for one handmatige correctie: who, which counter, the reason, how
 * many more or fewer. Used by the setup wizard (step Correcties, the rows wait
 * there until the period opens) and by the section "Import en correcties" on
 * the period page (saved at once). What a correction becomes in the ledger is
 * lib/correctieRedenen.ts's correctieRegels, for both.
 */

'use client';

import { useId, useState } from 'react';
import {
  CORRECTION_AANTAL_WARNING_THRESHOLD,
  CORRECTION_REASONS_BY_TOP_LEVEL,
  CORRECTION_TOP_LEVEL_LABELS,
  correctieRegels,
  type CorrectieRegel,
  type CorrectionTopLevel,
} from '@/lib/correctieRedenen';

interface Props {
  mensen: Array<{ person_id: string; codenaam: string }>;
  /** The button under the form: "Toevoegen" in the wizard, "Correctie opslaan" where it is saved at once. */
  knopTekst: string;
  /** The rows of one correction (two for an ongelijke ruil). True: done, the form starts over. */
  onToevoegen: (persoon: { person_id: string; codenaam: string }, regels: CorrectieRegel[]) => boolean | Promise<boolean>;
  /** Open from the start, without the button "Correctie toepassen" in front. */
  altijdOpen?: boolean;
}

export function CorrectieFormulier({ mensen, knopTekst, onToevoegen, altijdOpen = false }: Props) {
  const [correctionFormOpen, setCorrectionFormOpen] = useState(altijdOpen);
  const [correctionForm, setCorrectionForm] = useState({
    personId: '',
    topLevel: 'AVOND' as CorrectionTopLevel,
    reasonIndex: 0,
    aantal: (CORRECTION_REASONS_BY_TOP_LEVEL.AVOND[0].defaultAantal ?? '') as number | '',
  });
  // Sign is a separate toggle rather than typed into the number field: most
  // mobile on-screen numeric keypads (including iOS/Android for
  // type="number") have no minus key, making a negative "aantal" impossible
  // to enter on a phone otherwise.
  const [correctionAantalSign, setCorrectionAantalSign] = useState<1 | -1>(
    (CORRECTION_REASONS_BY_TOP_LEVEL.AVOND[0].defaultAantal ?? 0) < 0 ? -1 : 1
  );
  const veld = useId();
  const [fout, setFout] = useState<string | null>(null);
  const [bezig, setBezig] = useState(false);

  const correctionReasonOptions = CORRECTION_REASONS_BY_TOP_LEVEL[correctionForm.topLevel];
  const correctionSelectedReason = correctionReasonOptions[correctionForm.reasonIndex] ?? correctionReasonOptions[0];

  const applyReasonDefault = (topLevel: CorrectionTopLevel, reasonIndex: number) => {
    const reason = CORRECTION_REASONS_BY_TOP_LEVEL[topLevel][reasonIndex];
    if (reason.defaultAantal !== null) {
      setCorrectionAantalSign(reason.defaultAantal < 0 ? -1 : 1);
    }
    setCorrectionForm((f) => ({
      ...f,
      topLevel,
      reasonIndex,
      aantal: reason.defaultAantal ?? '',
    }));
  };

  const handleAddCorrection = async () => {
    if (
      !correctionForm.personId ||
      correctionForm.aantal === '' ||
      !Number.isFinite(correctionForm.aantal) ||
      correctionForm.aantal === 0
    ) {
      setFout('Kies een medewerker en vul een aantal (ongelijk aan 0) in');
      return;
    }
    const member = mensen.find((m) => m.person_id === correctionForm.personId);
    if (!member) return;
    setFout(null);
    setBezig(true);
    try {
      const klaar = await onToevoegen(member, correctieRegels(correctionSelectedReason, correctionForm.aantal as number));
      if (klaar) applyReasonDefault(correctionForm.topLevel, correctionForm.reasonIndex);
    } finally {
      setBezig(false);
    }
  };

  return (
    <>
      {!altijdOpen && (
        <button
          onClick={() => setCorrectionFormOpen((v) => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded font-medium bg-neutral-100 text-neutral-900 hover:bg-neutral-200 transition-colors"
        >
          Correctie toepassen
        </button>
      )}

      {correctionFormOpen && (
        <div className="border rounded p-4 space-y-3 bg-neutral-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${veld}-persoon`} className="block text-xs font-medium text-neutral-600 mb-1">Persoon</label>
              <select
                id={`${veld}-persoon`}
                value={correctionForm.personId}
                onChange={(e) => setCorrectionForm((f) => ({ ...f, personId: e.target.value }))}
                className="w-full px-2 py-2 border rounded text-sm"
              >
                <option value="">Kies een medewerker...</option>
                {mensen.map((m) => (
                  <option key={m.person_id} value={m.person_id}>
                    {m.codenaam}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={`${veld}-type`} className="block text-xs font-medium text-neutral-600 mb-1">Type</label>
              <select
                id={`${veld}-type`}
                value={correctionForm.topLevel}
                onChange={(e) => applyReasonDefault(e.target.value as CorrectionTopLevel, 0)}
                className="w-full px-2 py-2 border rounded text-sm"
              >
                {(Object.keys(CORRECTION_TOP_LEVEL_LABELS) as CorrectionTopLevel[]).map((tl) => (
                  <option key={tl} value={tl}>
                    {CORRECTION_TOP_LEVEL_LABELS[tl]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${veld}-reden`} className="block text-xs font-medium text-neutral-600 mb-1">Reden</label>
              <select
                id={`${veld}-reden`}
                value={correctionForm.reasonIndex}
                onChange={(e) => applyReasonDefault(correctionForm.topLevel, parseInt(e.target.value))}
                className="w-full px-2 py-2 border rounded text-sm"
              >
                {correctionReasonOptions.map((r, i) => (
                  <option key={i} value={i}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={`${veld}-aantal`} className="block text-xs font-medium text-neutral-600 mb-1">Aantal</label>
              <div className="flex gap-2">
                <div className="flex rounded border overflow-hidden shrink-0" role="group" aria-label="Meer of minder diensten">
                  <button
                    type="button"
                    onClick={() => {
                      setCorrectionAantalSign(-1);
                      setCorrectionForm((f) => ({ ...f, aantal: f.aantal === '' ? '' : -Math.abs(f.aantal) }));
                    }}
                    aria-pressed={correctionAantalSign === -1}
                    aria-label="Minder diensten"
                    className={`w-12 py-2 text-lg font-bold transition-colors ${
                      correctionAantalSign === -1
                        ? 'bg-red-600 text-white'
                        : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                    }`}
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCorrectionAantalSign(1);
                      setCorrectionForm((f) => ({ ...f, aantal: f.aantal === '' ? '' : Math.abs(f.aantal) }));
                    }}
                    aria-pressed={correctionAantalSign === 1}
                    aria-label="Meer diensten"
                    className={`w-12 py-2 text-lg font-bold border-l transition-colors ${
                      correctionAantalSign === 1
                        ? 'bg-green-700 text-white'
                        : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                    }`}
                  >
                    +
                  </button>
                </div>
                <input
                  id={`${veld}-aantal`}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  value={correctionForm.aantal === '' ? '' : Math.abs(correctionForm.aantal)}
                  onChange={(e) => {
                    if (e.target.value === '') {
                      setCorrectionForm((f) => ({ ...f, aantal: '' }));
                      return;
                    }
                    const magnitude = Math.abs(parseInt(e.target.value, 10));
                    setCorrectionForm((f) => ({
                      ...f,
                      aantal: Number.isNaN(magnitude) ? '' : correctionAantalSign * magnitude,
                    }));
                  }}
                  placeholder={correctionSelectedReason.defaultAantal === null ? 'Zelf invullen' : undefined}
                  className="w-full px-2 py-2 border rounded text-sm"
                />
              </div>
            </div>
          </div>

          <p className="text-xs text-neutral-500 italic">
            {correctionSelectedReason.explain(
              correctionForm.aantal === '' ? 0 : correctionForm.aantal
            )}
          </p>

          {typeof correctionForm.aantal === 'number' && Math.abs(correctionForm.aantal) >= CORRECTION_AANTAL_WARNING_THRESHOLD && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Ongebruikelijk groot aantal ({correctionForm.aantal}). Weet je zeker dat dit geen typefout is?
            </p>
          )}

          {fout && (
            <p role="alert" className="text-sm text-red-700">
              {fout}
            </p>
          )}

          <button
            onClick={handleAddCorrection}
            disabled={bezig}
            className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {bezig ? 'Bezig...' : knopTekst}
          </button>
        </div>
      )}
    </>
  );
}

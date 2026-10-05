'use client';

/**
 * "Voorkeuren importeren (test)": the preferences overview read back in
 * (lib/preferencesImport.ts). Shown to a beheerder only; the API checks
 * that too. "Controleren" changes nothing and lists what would change;
 * "Toepassen" only once the file has no problems.
 */

import { useEffect, useState } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { withBasePath } from '@/lib/basePath';

interface Change {
  codenaam: string;
  datum: string;
  dienst: string;
  van: string;
  naar: string;
}

interface Plan {
  wijzigingen: Change[];
  problemen: string[];
  overgeslagen: number;
  personen: number;
  toegepast: boolean;
}

interface Props {
  periodId: string;
  /** Hidden once the roster is built: the API refuses then. */
  periodStatus: string;
  onImported: () => void;
}

const SHOWN = 50;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function PreferencesImportButton({ periodId, periodStatus, onImported }: Props) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [bestandData, setBestandData] = useState<string | null>(null);
  const [bestand, setBestand] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(withBasePath('/api/auth/me'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setIsAdmin(data?.data?.role === 'ADMIN'))
      .catch(() => setIsAdmin(false));
  }, []);

  const close = () => {
    setOpen(false);
    setBestandData(null);
    setBestand('');
    setPlan(null);
    setError(null);
  };
  useBodyScrollLock(open);
  const handleBackdropClick = useDialogDismiss(open, close, !busy);

  if (!isAdmin || periodStatus === 'GEGENEREERD' || periodStatus === 'GEPUBLICEERD') return null;

  const send = async (toepassen: boolean) => {
    if (bestandData === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath(`/api/admin/period/${periodId}/preferences-import`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bestand: bestandData, toepassen }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error?.message ?? 'Importeren is mislukt.');
        return;
      }
      setPlan(data.data);
      if (data.data.toegepast) onImported();
    } catch {
      setError('Geen verbinding met de server. Probeer het opnieuw.');
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (file: File | undefined) => {
    setPlan(null);
    setError(null);
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      setBestandData(null);
      setError('Kies een Excel-bestand (.xlsx). Sla het bestand in Excel op als "Excel-werkmap".');
      return;
    }
    setBestand(file.name);
    setBestandData(toBase64(await file.arrayBuffer()));
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
      >
        🧪 Voorkeuren importeren (test)
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Voorkeuren importeren"
          onClick={handleBackdropClick}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-2">Voorkeuren importeren (test)</h2>
            <p className="text-sm text-neutral-700 mb-2">
              Open het bestand van &quot;Voorkeurenoverzicht downloaden&quot; in Excel, vul de voorkeuren aan en sla
              het op als Excel-werkmap (.xlsx). Lees het hier weer in.
            </p>
            <ul className="text-sm text-neutral-700 mb-4 list-disc pl-5 space-y-1">
              <li>Geblokkeerd, liever niet en voorkeur worden gezet alsof de planner ze invult. Een lege cel haalt zo&apos;n keuze weg.</li>
              <li>Cellen met (parttime), (afwezig) of (fellow) worden overgeslagen. Die komen uit het deeltijdpatroon, de afwezigheid of het fellowvinkje.</li>
              <li>Het maximum aantal blokkades geldt hier niet.</li>
              <li>Controleren verandert nog niets. Je ziet eerst wat er zou veranderen.</li>
            </ul>

            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy}
              onChange={(e) => pickFile(e.target.files?.[0])}
              className="block w-full text-sm mb-4"
              aria-label="Excel-bestand met voorkeuren"
            />

            {error && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4" role="alert">
                <p className="text-sm text-red-800">{error}</p>
              </div>
            )}

            {plan && (
              <div className="mb-4 text-sm" data-testid="import-resultaat">
                {plan.toegepast ? (
                  <p className="font-medium text-green-700 mb-2">
                    Klaar. {plan.wijzigingen.length} {plan.wijzigingen.length === 1 ? 'keuze' : 'keuzes'} aangepast bij{' '}
                    {plan.personen} {plan.personen === 1 ? 'persoon' : 'personen'}.
                  </p>
                ) : (
                  <p className="font-medium mb-2">
                    {plan.wijzigingen.length === 0
                      ? 'Er verandert niets.'
                      : `${plan.wijzigingen.length} ${plan.wijzigingen.length === 1 ? 'keuze verandert' : 'keuzes veranderen'} bij ${plan.personen} ${plan.personen === 1 ? 'persoon' : 'personen'}.`}
                    {plan.overgeslagen > 0 && ` ${plan.overgeslagen} automatische ${plan.overgeslagen === 1 ? 'cel' : 'cellen'} overgeslagen.`}
                  </p>
                )}
                {plan.problemen.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-2">
                    <p className="font-medium text-amber-900 mb-1">
                      {plan.problemen.length === 1 ? 'Eén probleem' : `${plan.problemen.length} problemen`}. Los dit eerst op in het bestand:
                    </p>
                    <ul className="list-disc pl-5 text-amber-900">
                      {plan.problemen.slice(0, SHOWN).map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                    {plan.problemen.length > SHOWN && <p className="text-amber-900 mt-1">En nog {plan.problemen.length - SHOWN} meer.</p>}
                  </div>
                )}
                {!plan.toegepast && plan.wijzigingen.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b">
                          <th className="py-1 pr-2">Codenaam</th>
                          <th className="py-1 pr-2">Datum</th>
                          <th className="py-1 pr-2">Dienst</th>
                          <th className="py-1 pr-2">Nu</th>
                          <th className="py-1">Wordt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.wijzigingen.slice(0, SHOWN).map((w) => (
                          <tr key={`${w.codenaam}|${w.datum}|${w.dienst}`} className="border-b border-neutral-100">
                            <td className="py-1 pr-2">{w.codenaam}</td>
                            <td className="py-1 pr-2">{w.datum}</td>
                            <td className="py-1 pr-2">{w.dienst}</td>
                            <td className="py-1 pr-2">{w.van}</td>
                            <td className="py-1">{w.naar}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {plan.wijzigingen.length > SHOWN && (
                      <p className="mt-1 text-neutral-600">En nog {plan.wijzigingen.length - SHOWN} wijzigingen.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                onClick={close}
                disabled={busy}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors disabled:opacity-50"
              >
                {plan?.toegepast ? 'Sluiten' : 'Annuleren'}
              </button>
              {!plan?.toegepast && (
                <button
                  onClick={() => send(false)}
                  disabled={busy || bestandData === null}
                  className="flex-1 py-2 px-4 rounded font-medium bg-neutral-700 text-white hover:bg-neutral-800 transition-colors disabled:opacity-50"
                >
                  {busy ? 'Bezig...' : `Controleren${bestand ? ` (${bestand})` : ''}`}
                </button>
              )}
              {plan && !plan.toegepast && plan.problemen.length === 0 && plan.wijzigingen.length > 0 && (
                <button
                  onClick={() => send(true)}
                  disabled={busy}
                  className="flex-1 py-2 px-4 rounded font-medium bg-blue-700 text-white hover:bg-blue-800 transition-colors disabled:opacity-50"
                >
                  {busy ? 'Bezig...' : 'Toepassen'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

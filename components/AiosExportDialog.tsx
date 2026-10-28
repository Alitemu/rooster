'use client';

/**
 * "Exporteren en communicatie" of an AIOS period: invitations and reminders
 * through the AIOS's own flow, the personal links and the wijzigings-
 * geschiedenis as Excel. A copy of components/ExportDialog.tsx on the AIOS's
 * routes, not shared with it (docs/development/diensten.md, "Copied, not
 * changed"): the same four choices, the same words, the same order.
 *
 * Every mail goes out as a verzendlijst to the AIOS's own Power Automate
 * flow (lib/aiosMail.ts); the app never mails anyone itself and never
 * stores an address.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAiosDialoogSluiten, useAiosScrollSlot } from '@/lib/aiosDialoog';
import { withBasePath } from '@/lib/basePath';
import { deadlineTekst } from '@/lib/aiosVerzendlijst';
import { foutTekst } from '@/lib/aiosFoutTekst';

export type AiosExportType = 'invitations-send' | 'invitations-download' | 'reminders' | 'audit-trail' | null;

type SendState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; aantal: number; overgeslagen: number } | { kind: 'failed'; message: string };

interface Deelnemer {
  person_id: string;
  codenaam: string;
  status: string;
}

interface Props {
  periodId: string;
  periodName: string;
  /** As stored (a datetime-local value). */
  deadline: string;
  periodStatus: string;
  isOpen: boolean;
  onClose: () => void;
  /** After the deadline was moved from this dialog, so the page shows the new one. */
  onDeadlineChanged?: () => void;
  initialType?: AiosExportType;
}

const GEEN_MAIL = 'De mail voor de AIOS is nog niet ingesteld. Dat doet de beheerder. Downloaden kan wel.';

const VERSTUUR_KEUZE =
  'w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:border-neutral-200 disabled:hover:bg-transparent';
const DOWNLOAD_KEUZE = 'w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors';

const formatDeadline = (deadline: string) => (isNaN(new Date(deadline).getTime()) ? deadline : deadlineTekst(deadline));

/** Saves a download fetched with fetch(): under the name the server gave it (filename*), or `fallback`. */
async function bewaarDownload(res: Response, fallback: string): Promise<void> {
  const header = res.headers.get('Content-Disposition') ?? '';
  let naam = fallback;
  try {
    const gecodeerd = header.split("filename*=UTF-8''")[1];
    if (gecodeerd) naam = decodeURIComponent(gecodeerd);
  } catch {
    // A name that doesn't decode: the fallback.
  }
  const url = window.URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = naam;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

const meldingNa = (s: SendState & { kind: 'sent' }, wat: string) =>
  s.aantal === 0
    ? `Er ging geen ${wat} uit.${s.overgeslagen > 0 ? ' Wie de afgelopen dag al een herinnering kreeg, is overgeslagen.' : ''}`
    : `Verstuurd: ${s.aantal} ${s.aantal === 1 ? wat : wat === 'herinnering' ? 'herinneringen' : 'uitnodigingen'}.${s.overgeslagen > 0 ? ` ${s.overgeslagen} overgeslagen: die kregen de afgelopen dag al een herinnering.` : ''}`;

function VerstuurKnop({ label, state, onClick, disabled }: { label: string; state: SendState; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      <button
        onClick={onClick}
        disabled={disabled || state.kind === 'sending'}
        className="w-full py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300 transition-colors"
      >
        {state.kind === 'sending' ? 'Bezig met versturen...' : label}
      </button>
      {state.kind === 'failed' && (
        <p role="alert" className="text-sm text-red-700">
          {state.message}
        </p>
      )}
    </div>
  );
}

export function AiosExportDialog({ periodId, periodName, deadline, periodStatus, isOpen, onClose, onDeadlineChanged, initialType = null }: Props) {
  const [exportType, setExportType] = useState<AiosExportType>(initialType);
  const [error, setError] = useState<string | null>(null);
  // null while unknown: nothing is shown as "the" way until the server has said whether it can send.
  const [mailKan, setMailKan] = useState<boolean | null>(null);
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  const [deelnemers, setDeelnemers] = useState<Deelnemer[] | null>(null);
  const [laatste, setLaatste] = useState(false);
  // Per AIOS: sending one a reminder on its own.
  const [perAios, setPerAios] = useState<Record<string, SendState>>({});
  const [now, setNow] = useState<number | null>(null);
  const [nieuweDeadline, setNieuweDeadline] = useState('');
  const [deadlineOpslaan, setDeadlineOpslaan] = useState(false);
  const [deadlineFout, setDeadlineFout] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const tik = () => setNow(Date.now());
    tik();
    const timer = setInterval(tik, 30_000);
    return () => clearInterval(timer);
  }, [isOpen, exportType, deadline]);
  const deadlineVoorbij = now !== null && new Date(deadline).getTime() < now;

  // The component stays mounted between opens: what was left over starts fresh.
  useEffect(() => {
    if (isOpen) {
      setExportType(initialType);
      setError(null);
      setSendState({ kind: 'idle' });
      setPerAios({});
      setLaatste(false);
      setDeelnemers(null);
    }
  }, [isOpen, periodId, initialType]);

  useEffect(() => {
    if (!isOpen) return;
    let afgebroken = false;
    fetch(withBasePath('/api/aios/mail-instellingen'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!afgebroken) setMailKan(Boolean(data?.data?.ingesteld) && !data?.data?.uitgeschakeld);
      })
      .catch(() => {
        if (!afgebroken) setMailKan(false);
      });
    return () => {
      afgebroken = true;
    };
  }, [isOpen]);

  useEffect(() => {
    setSendState({ kind: 'idle' });
  }, [exportType]);

  // Who has not handed in yet, for the reminders.
  const laadDeelnemers = useCallback(() => {
    fetch(withBasePath(`/api/aios/periode/${periodId}/voorkeuren`))
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (!data?.success) throw new Error(data?.error?.message ?? 'Laden van de AIOS is mislukt');
        setDeelnemers(data.data.deelnemers);
      })
      .catch((err) => setError(foutTekst(err, 'Laden van de AIOS is mislukt')));
  }, [periodId]);
  useEffect(() => {
    if (isOpen && exportType === 'reminders' && deelnemers === null) laadDeelnemers();
  }, [isOpen, exportType, deelnemers, laadDeelnemers]);

  const verstuur = async (pad: string, body: unknown): Promise<SendState> => {
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/${pad}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) return { kind: 'failed', message: data?.error?.message ?? 'Versturen is mislukt.' };
      return { kind: 'sent', aantal: data.data.aantal ?? 0, overgeslagen: data.data.overgeslagen ?? 0 };
    } catch {
      return { kind: 'failed', message: 'Geen verbinding met de server. Controleer je netwerk.' };
    }
  };

  const stuurUitnodigingen = async () => {
    setSendState({ kind: 'sending' });
    setSendState(await verstuur('uitnodigingen', {}));
  };

  const stuurHerinnering = async (personId: string | null, opnieuw = false) => {
    if (personId) setPerAios((p) => ({ ...p, [personId]: { kind: 'sending' } }));
    else setSendState({ kind: 'sending' });
    const uitkomst = await verstuur('herinneringen', { ...(personId ? { person_id: personId } : {}), laatste, ...(opnieuw ? { opnieuw: true } : {}) });
    if (personId) setPerAios((p) => ({ ...p, [personId]: uitkomst }));
    else setSendState(uitkomst);
  };

  const downloadUitnodigingen = async () => {
    try {
      // POST: it makes everyone a new personal link.
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/links`), { method: 'POST' });
      if (!res.ok) throw new Error('Downloaden van uitnodigingen mislukt');
      await bewaarDownload(res, `links-aios_${periodName.replace(/ /g, '_')}.xlsx`);
      onClose();
    } catch (err) {
      setError(foutTekst(err, 'Downloaden mislukt'));
    }
  };

  const downloadWijzigingen = async () => {
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/download-wijzigingen`));
      if (!res.ok) throw new Error('Downloaden van wijzigingsgeschiedenis mislukt');
      await bewaarDownload(res, `wijzigingsgeschiedenis_${periodName.replace(/ /g, '_')}.xlsx`);
      onClose();
    } catch (err) {
      setError(foutTekst(err, 'Downloaden mislukt'));
    }
  };

  const slaDeadlineOp = async () => {
    setDeadlineOpslaan(true);
    setDeadlineFout(null);
    try {
      const res = await fetch(withBasePath(`/api/aios/periode/${periodId}/deadline`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deadline: nieuweDeadline, was: deadline }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setDeadlineFout(data?.error?.message ?? 'Aanpassen van de deadline is mislukt.');
        return;
      }
      setNieuweDeadline('');
      onDeadlineChanged?.();
    } catch {
      setDeadlineFout('Geen verbinding met de server. Controleer je netwerk.');
    } finally {
      setDeadlineOpslaan(false);
    }
  };

  const deadlineVeld = (waarom: string, daarna: string) => (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-6 space-y-3">
      <p className="text-sm font-semibold text-amber-900">De deadline is al voorbij</p>
      <p className="text-sm text-amber-900">
        De deadline was {formatDeadline(deadline)}. {waarom} Stel eerst een nieuwe deadline in. {daarna}
      </p>
      <label className="block text-xs font-semibold text-amber-900" htmlFor="aios-nieuwe-deadline">
        Nieuwe deadline
      </label>
      <input
        id="aios-nieuwe-deadline"
        type="datetime-local"
        value={nieuweDeadline}
        onChange={(e) => setNieuweDeadline(e.target.value)}
        className="w-full px-3 py-2 border rounded text-sm bg-white"
      />
      {deadlineFout && (
        <p role="alert" className="text-sm text-red-700">
          {deadlineFout}
        </p>
      )}
      <button
        onClick={slaDeadlineOp}
        disabled={!nieuweDeadline || deadlineOpslaan}
        className="w-full py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300 transition-colors"
      >
        {deadlineOpslaan ? 'Bezig met opslaan...' : 'Deadline opslaan'}
      </button>
    </div>
  );

  useAiosScrollSlot(isOpen);
  const sluitAchtergrond = useAiosDialoogSluiten(isOpen, onClose);

  if (!isOpen) return null;

  const nietOpen = (wat: string) => (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-6">
      <p className="text-sm text-amber-900">{wat} kunnen alleen worden verstuurd zolang de periode open staat.</p>
    </div>
  );
  const nietIngesteld = (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-6" data-testid="aios-export-geen-mail">
      <p className="text-sm text-amber-900">{GEEN_MAIL}</p>
    </div>
  );
  const terug = (
    <button
      onClick={() => setExportType(null)}
      className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
    >
      Terug
    </button>
  );
  const nogOpen = (deelnemers ?? []).filter((d) => d.status !== 'INGEDIEND');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Exporteren"
      onClick={sluitAchtergrond}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="card p-6 max-w-2xl w-full max-h-full overflow-y-auto">
        {!exportType ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Exporteren en communicatie</h2>
            <div className="space-y-3 mb-6">
              <button onClick={() => setExportType('invitations-send')} disabled={mailKan === false} className={VERSTUUR_KEUZE}>
                <p className="font-semibold text-neutral-900">✉️ Uitnodigingen versturen</p>
                <p className="text-sm text-neutral-600">Iedereen de eigen persoonlijke link mailen via Power Automate</p>
                {mailKan === false && <p className="text-sm text-amber-900 mt-1">{GEEN_MAIL}</p>}
              </button>
              <button onClick={() => setExportType('reminders')} disabled={mailKan === false} className={VERSTUUR_KEUZE}>
                <p className="font-semibold text-neutral-900">📧 Herinneringen versturen</p>
                <p className="text-sm text-neutral-600">Deadline-herinneringen via Power Automate, aan iedereen of per persoon</p>
                {mailKan === false && <p className="text-sm text-amber-900 mt-1">{GEEN_MAIL}</p>}
              </button>
              <button onClick={() => setExportType('invitations-download')} className={DOWNLOAD_KEUZE}>
                <p className="font-semibold text-neutral-900">📊 Uitnodigingen downloaden</p>
                <p className="text-sm text-neutral-600">Excel-bestand met namen en persoonlijke links</p>
              </button>
              <button onClick={() => setExportType('audit-trail')} className={DOWNLOAD_KEUZE}>
                <p className="font-semibold text-neutral-900">📄 Wijzigingsgeschiedenis downloaden</p>
                <p className="text-sm text-neutral-600">
                  Excel-bestand met alle handmatige toewijzingen, wisselingen en verwijderingen, voor verantwoording achteraf
                </p>
              </button>
            </div>
            <button
              onClick={onClose}
              className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Sluiten
            </button>
          </>
        ) : exportType === 'invitations-send' ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Uitnodigingen versturen</h2>
            {mailKan === null ? (
              <p className="text-center text-neutral-600 mb-4">Laden...</p>
            ) : !mailKan ? (
              nietIngesteld
            ) : periodStatus !== 'OPEN' ? (
              nietOpen('Uitnodigingen')
            ) : deadlineVoorbij ? (
              deadlineVeld('Een uitnodiging met die datum heeft geen zin.', 'De uitnodigingen noemen daarna de nieuwe deadline.')
            ) : (
              <div className="bg-green-50 border border-green-200 rounded p-4 mb-6 space-y-3">
                <p className="text-sm text-green-900 mb-2">De uitnodigingen noemen de huidige deadline: {formatDeadline(deadline)}.</p>
                <p className="text-sm text-green-900">
                  De server maakt voor iedereen een nieuwe persoonlijke link aan en stuurt de uitnodigingen als verzendlijst naar de mailbox van
                  de Power Automate-stroom van de AIOS. Die stuurt iedereen de eigen persoonlijke link.
                </p>
                <p className="text-sm text-green-900">Eerder verstuurde links blijven gewoon werken. Wie de vorige mail nog heeft, kan die blijven gebruiken.</p>
                <VerstuurKnop label="✉️ Uitnodigingen versturen" state={sendState} onClick={stuurUitnodigingen} />
                {sendState.kind === 'sent' && (
                  <p role="status" className="text-sm font-medium text-green-900">
                    {meldingNa(sendState, 'uitnodiging')}
                  </p>
                )}
              </div>
            )}
            {terug}
          </>
        ) : exportType === 'invitations-download' ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Uitnodigingen downloaden</h2>
            {error && <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{error}</div>}
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">Het Excel-bestand bevat namen en persoonlijke links naar het voorkeurenformulier.</p>
              <p className="text-xs text-blue-800 mt-2">Kolommen: Naam, Persoonlijke link, Deadline</p>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">
                Downloaden maakt voor iedereen een nieuwe persoonlijke link aan. Eerder verstuurde links blijven gewoon werken. Wie de vorige mail
                nog heeft, kan die blijven gebruiken.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={downloadUitnodigingen}
                className="flex-1 py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                📥 Excel downloaden
              </button>
              <button
                onClick={() => setExportType(null)}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Terug
              </button>
            </div>
          </>
        ) : exportType === 'audit-trail' ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Wijzigingsgeschiedenis downloaden</h2>
            {error && <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{error}</div>}
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">
                Elke handmatige toewijzing, wisseling en verwijdering in deze periode, met reden en wie het deed.
              </p>
              <p className="text-xs text-blue-800 mt-2">Kolommen: Datum wijziging, Actie, Betreft, Was, Dienstdatum, Dienst, Reden, Aangepast door</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={downloadWijzigingen}
                className="flex-1 py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                📥 Excel downloaden
              </button>
              <button
                onClick={() => setExportType(null)}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Terug
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold mb-4">Herinneringen versturen</h2>
            {error && <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{error}</div>}
            {mailKan === null ? (
              <p className="text-center text-neutral-600 mb-4">Laden...</p>
            ) : !mailKan ? (
              nietIngesteld
            ) : periodStatus !== 'OPEN' ? (
              nietOpen('Herinneringen')
            ) : deadlineVoorbij ? (
              deadlineVeld('Een herinnering met die datum heeft geen zin meer.', 'De herinneringen noemen daarna de nieuwe deadline.')
            ) : deelnemers === null ? (
              <p className="text-center text-neutral-600 mb-4">Laden...</p>
            ) : nogOpen.length === 0 ? (
              <div className="bg-green-50 border border-green-200 rounded p-4 mb-6">
                <p className="text-sm text-green-900">Iedereen heeft de voorkeuren ingediend. Er is niemand om te herinneren.</p>
              </div>
            ) : (
              <div className="space-y-4 mb-6">
                <div className="bg-blue-50 border border-blue-200 rounded p-4">
                  <p className="text-sm text-blue-900 mb-2">De herinneringen noemen de huidige deadline: {formatDeadline(deadline)}.</p>
                  <p className="text-sm text-blue-900">
                    Dit maakt voor iedereen die nog niet heeft ingediend een nieuwe persoonlijke link aan. Eerder verstuurde links blijven gewoon
                    werken. Wie in de afgelopen dag al een herinnering kreeg, wordt overgeslagen.
                  </p>
                </div>
                <label className="flex items-start gap-2 text-sm text-neutral-800">
                  <input type="checkbox" checked={laatste} onChange={(e) => setLaatste(e.target.checked)} className="mt-1" />
                  <span>Dit is de laatste herinnering. De tekst zegt dat dan.</span>
                </label>
                <VerstuurKnop
                  label={`📧 Herinnering versturen aan ${nogOpen.length === 1 ? 'de AIOS' : `alle ${nogOpen.length} AIOS`} die nog niet hebben ingediend`}
                  state={sendState}
                  onClick={() => stuurHerinnering(null)}
                />
                {sendState.kind === 'sent' && (
                  <div role="status" className="space-y-2">
                    <p className="text-sm font-medium text-green-900">{meldingNa(sendState, 'herinnering')}</p>
                    {sendState.aantal === 0 && sendState.overgeslagen > 0 && (
                      <button
                        onClick={() => stuurHerinnering(null, true)}
                        className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
                      >
                        Toch opnieuw versturen
                      </button>
                    )}
                  </div>
                )}
                <ul className="divide-y text-sm" aria-label="AIOS die nog niet hebben ingediend">
                  {nogOpen.map((d) => {
                    const s = perAios[d.person_id] ?? { kind: 'idle' as const };
                    return (
                      <li key={d.person_id} className="py-2 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            <span className="font-medium">{d.codenaam}</span>{' '}
                            <span className="text-neutral-600">{d.status === 'BEZIG' ? 'bezig, nog niet ingediend' : 'nog niets ingevuld'}</span>
                          </span>
                          <button
                            onClick={() => stuurHerinnering(d.person_id)}
                            disabled={s.kind === 'sending'}
                            aria-label={`Herinnering versturen aan ${d.codenaam}`}
                            className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:opacity-50"
                          >
                            {s.kind === 'sending' ? 'Bezig...' : 'Herinnering versturen'}
                          </button>
                        </div>
                        {s.kind === 'sent' && (
                          <div className="flex flex-wrap items-center gap-2">
                            <p role="status" className="text-green-900">
                              {s.aantal > 0 ? 'Verstuurd.' : 'Er ging geen herinnering uit: deze AIOS kreeg de afgelopen dag al een herinnering.'}
                            </p>
                            {s.aantal === 0 && (
                              <button
                                onClick={() => stuurHerinnering(d.person_id, true)}
                                className="px-2 py-0.5 rounded text-xs font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
                              >
                                Toch opnieuw versturen
                              </button>
                            )}
                          </div>
                        )}
                        {s.kind === 'failed' && (
                          <p role="alert" className="text-red-700">
                            {s.message}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {terug}
          </>
        )}
      </div>
    </div>
  );
}

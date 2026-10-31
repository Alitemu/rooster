'use client';

/**
 * "Back-up": for the beheerder only (the API checks it too). Three parts:
 * - how it stands: when the last backup went out, and what went wrong;
 * - the address and the backup password (lib/dbBackupMail.ts); the saved
 *   password is never shown again, leaving the field empty keeps it;
 * - restoring a backup file (lib/dbBackupTerugzetten.ts), with the password
 *   and the typed word, because it replaces everything for both diensten.
 */

import { useEffect, useState } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { withBasePath } from '@/lib/basePath';
import { foutTekst } from '@/lib/foutTekst';
import { APP_TIME_ZONE } from '@/lib/localDate';
import { backupFoutmelding } from '@/lib/terugzetAntwoord';
import { WachtwoordVeld } from '@/components/WachtwoordVeld';

interface Status {
  ingesteld: boolean;
  aan: string | null;
  wachtwoord_leesbaar: boolean | null;
  mail_ingesteld: boolean;
  verstuurd_op: string | null;
  bestand: string | null;
  fout: { op: string; melding: string } | null;
}

// Mirrors lib/dbBackupBestand.ts MIN_WACHTWOORD_LENGTE and lib/dbBackupTerugzetten.ts BEVESTIGING (those modules read
// files and the database, so they can't be imported here).
const MIN_WACHTWOORD = 12;
const BEVESTIGING = 'TERUGZETTEN';
/** lib/dbBackupMail.ts MAX_BACKUP_BYTES: a larger file was never made by the app. */
const MAX_BESTAND_BYTES = 18 * 1024 * 1024;

const moment = (iso: string) =>
  new Date(iso).toLocaleString('nl-NL', { timeZone: APP_TIME_ZONE, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The file as base64, without the "data:...;base64," in front. */
function leesAlsBase64(bestand: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const lezer = new FileReader();
    lezer.onload = () => resolve(String(lezer.result).replace(/^data:[^,]*,/, ''));
    lezer.onerror = () => reject(new Error('Het bestand kon niet gelezen worden.'));
    lezer.readAsDataURL(bestand);
  });
}

export function BackupDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [aan, setAan] = useState('');
  const [wachtwoord, setWachtwoord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const [bestand, setBestand] = useState<File | null>(null);
  const [terugWachtwoord, setTerugWachtwoord] = useState('');
  const [bevestiging, setBevestiging] = useState('');
  const [teruggezet, setTeruggezet] = useState<string | null>(null);

  useBodyScrollLock(isOpen);
  const handleBackdropClick = useDialogDismiss(isOpen, onClose, !busy);

  const apply = (s: Status) => {
    setStatus(s);
    setAan(s.aan ?? '');
    setWachtwoord('');
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setMelding(null);
    setConfirmStop(false);
    setTeruggezet(null);
    setTerugWachtwoord('');
    fetch(withBasePath('/api/admin/back-up'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.success) apply(data.data);
        else setError('De instellingen van de back-up konden niet geladen worden.');
      })
      .catch(() => setError('De instellingen van de back-up konden niet geladen worden.'));
  }, [isOpen]);

  if (!isOpen) return null;

  const call = async (adres: string, method: string, body?: unknown): Promise<Status> => {
    const res = await fetch(adres, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new Error(backupFoutmelding(res.status, data));
    return data.data;
  };

  const run = async (doe: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMelding(null);
    try {
      await doe();
    } catch (err) {
      setError(foutTekst(err, 'Dat is niet gelukt.'));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      apply(await call(withBasePath('/api/admin/back-up'), 'PUT', { aan, wachtwoord: wachtwoord || undefined }));
      setMelding('Opgeslagen. Vanaf nu gaat er elke nacht een back-up uit als er iets veranderd is.');
    });

  const nuVersturen = () =>
    run(async () => {
      apply(await call(withBasePath('/api/admin/back-up/versturen'), 'POST', {}));
      setMelding('De back-up is verstuurd. Kijk over een paar minuten in OneDrive of hij is aangekomen.');
    });

  const stop = () =>
    run(async () => {
      apply(await call(withBasePath('/api/admin/back-up'), 'DELETE'));
      setConfirmStop(false);
      setMelding('Er gaan geen back-ups meer uit. De back-ups die al in OneDrive staan, blijven daar.');
    });

  const terugzetten = () =>
    run(async () => {
      if (!bestand) throw new Error('Kies eerst een back-upbestand.');
      if (bestand.size > MAX_BESTAND_BYTES) throw new Error('Dit bestand is te groot voor een back-up van Dienstrooster.');
      const uit = (await call(withBasePath('/api/admin/back-up/terugzetten'), 'POST', {
        bestand: await leesAlsBase64(bestand),
        wachtwoord: terugWachtwoord,
        bevestiging,
      })) as unknown as { gemaakt_op: string; schema_bijgewerkt: boolean };
      setTeruggezet(
        `De back-up van ${moment(uit.gemaakt_op)} is teruggezet.` +
          (uit.schema_bijgewerkt ? '' : ' Start de app opnieuw, zodat de database bij deze versie past.')
      );
      setBestand(null);
      setTerugWachtwoord('');
      setBevestiging('');
    });

  const nieuwWachtwoordTeKort = wachtwoord !== '' && wachtwoord.length < MIN_WACHTWOORD;
  const canSave = !busy && aan.trim() !== '' && !nieuwWachtwoordTeKort && (wachtwoord !== '' || status?.wachtwoord_leesbaar === true);
  const canTerugzetten = !busy && bestand !== null && terugWachtwoord !== '' && bevestiging === BEVESTIGING;

  return (
    <div
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Back-up"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-full flex flex-col">
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Back-up</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Elke nacht gaat er een versleutelde kopie van de hele database per mail naar jouw adres, als er iets veranderd is.
            Je stroom in Power Automate zet hem in OneDrive.
          </p>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto min-h-0">
          {teruggezet ? (
            <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-4 space-y-3 text-sm text-green-900">
              <p>{teruggezet}</p>
              <p>Laad de pagina opnieuw. Misschien moet je opnieuw inloggen.</p>
              <button type="button" onClick={() => window.location.reload()} className="btn-primary">
                Pagina opnieuw laden
              </button>
            </div>
          ) : (
            <>
              <section aria-labelledby="backup-stand" className="space-y-2">
                <h3 id="backup-stand" className="text-sm font-bold text-neutral-900 border-b pb-1">
                  Hoe het ervoor staat
                </h3>
                {status === null ? (
                  <p className="text-sm text-neutral-600">Laden...</p>
                ) : !status.ingesteld ? (
                  <p className="text-sm text-neutral-700">De back-up per mail is nog niet ingesteld.</p>
                ) : status.verstuurd_op ? (
                  <p className="text-sm text-neutral-700">
                    De laatste back-up ging uit op {moment(status.verstuurd_op)}
                    {status.bestand ? ` (${status.bestand})` : ''}.
                  </p>
                ) : (
                  <p className="text-sm text-neutral-700">Er is nog geen back-up verstuurd.</p>
                )}
                {status?.fout && (
                  <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                    <p className="font-semibold">De laatste poging op {moment(status.fout.op)} is mislukt.</p>
                    <p>{status.fout.melding}</p>
                  </div>
                )}
                {status && !status.mail_ingesteld && (
                  <p className="text-sm text-red-800">Versturen kan pas als het Gmail-account bij Mailinstellingen is ingesteld.</p>
                )}
                {status?.wachtwoord_leesbaar === false && (
                  <p className="text-sm text-red-800">Het opgeslagen back-upwachtwoord kan niet meer gelezen worden. Vul het opnieuw in.</p>
                )}
              </section>

              <section aria-labelledby="backup-instellen" className="space-y-3">
                <h3 id="backup-instellen" className="text-sm font-bold text-neutral-900 border-b pb-1">
                  Instellen
                </h3>
                <div>
                  <label htmlFor="backup-aan" className="block text-sm font-semibold text-neutral-900 mb-1">
                    Back-up sturen naar
                  </label>
                  <input
                    id="backup-aan"
                    type="email"
                    autoComplete="off"
                    placeholder="je eigen adres, niet het gedeelde postvak"
                    value={aan}
                    onChange={(e) => setAan(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="backup-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-1">
                    Back-upwachtwoord
                  </label>
                  <WachtwoordVeld
                    id="backup-wachtwoord"
                    placeholder={status?.wachtwoord_leesbaar ? 'Opgeslagen. Laat leeg om het te houden.' : `minstens ${MIN_WACHTWOORD} tekens`}
                    value={wachtwoord}
                    onChange={setWachtwoord}
                    beschrijving="backup-wachtwoord-uitleg"
                  />
                  {nieuwWachtwoordTeKort && <p className="text-xs text-red-800 mt-1">Minstens {MIN_WACHTWOORD} tekens.</p>}
                  <p id="backup-wachtwoord-uitleg" className="text-xs text-neutral-600 mt-1">
                    Bewaar dit wachtwoord apart, bijvoorbeeld in de kluis van de afdeling. Zonder dit wachtwoord kan niemand de
                    back-ups openen, ook de beheerder niet. Een nieuw wachtwoord geldt voor de back-ups die daarna uitgaan. Hoofdletters
                    tellen mee: kijk met Toon wachtwoord of je het goed getypt hebt.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 justify-end">
                  {status?.ingesteld && (
                    <button type="button" onClick={nuVersturen} disabled={busy} className="btn-secondary">
                      Nu een back-up versturen
                    </button>
                  )}
                  <button type="button" onClick={save} disabled={!canSave} className="btn-primary">
                    Opslaan
                  </button>
                </div>
              </section>

              <section aria-labelledby="backup-terugzetten" className="space-y-3">
                <h3 id="backup-terugzetten" className="text-sm font-bold text-neutral-900 border-b pb-1">
                  Back-up terugzetten
                </h3>
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  Alles wat sinds de back-up veranderd is, gaat verloren. Dat geldt voor de achterwacht en de AIOS samen. De
                  gegevens zoals ze nu zijn, bewaart de app eerst apart op de server. Een ruilmail of herinnering die na de
                  back-up al verstuurd is, kan nog een keer uitgaan.
                </div>
                <div>
                  <label htmlFor="backup-bestand" className="block text-sm font-semibold text-neutral-900 mb-1">
                    Back-upbestand (.drbackup)
                  </label>
                  <input
                    id="backup-bestand"
                    type="file"
                    accept=".drbackup"
                    onChange={(e) => setBestand(e.target.files?.[0] ?? null)}
                    className="w-full text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="backup-terug-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-1">
                    Back-upwachtwoord van dat bestand
                  </label>
                  <WachtwoordVeld id="backup-terug-wachtwoord" value={terugWachtwoord} onChange={setTerugWachtwoord} />
                </div>
                <div>
                  <label htmlFor="backup-bevestiging" className="block text-sm font-semibold text-neutral-900 mb-1">
                    Typ {BEVESTIGING} om te bevestigen
                  </label>
                  <input
                    id="backup-bevestiging"
                    type="text"
                    autoComplete="off"
                    value={bevestiging}
                    onChange={(e) => setBevestiging(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={terugzetten}
                    disabled={!canTerugzetten}
                    className="px-4 py-2 rounded font-medium bg-red-700 text-white hover:bg-red-800 disabled:opacity-50"
                  >
                    {busy && bestand ? 'Bezig met terugzetten...' : 'Back-up terugzetten'}
                  </button>
                </div>
              </section>

              {status?.ingesteld && confirmStop && (
                <div className="rounded-lg border border-red-300 bg-red-50 p-4 space-y-3">
                  <p className="text-sm font-semibold text-red-900">Back-up per mail stoppen?</p>
                  <p className="text-sm text-red-900">Daarna gaan er geen back-ups meer naar OneDrive. Alleen de kopieën op de server blijven.</p>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setConfirmStop(false)} disabled={busy} className="btn-secondary">
                      Annuleren
                    </button>
                    <button onClick={stop} disabled={busy} className="px-4 py-2 rounded font-medium bg-red-700 text-white hover:bg-red-800 disabled:opacity-50">
                      Ja, stoppen
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {error}
            </div>
          )}
          {melding && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">{melding}</div>}
        </div>

        <div className="border-t p-6 flex-shrink-0 flex flex-wrap justify-between gap-3">
          <div>
            {status?.ingesteld && !confirmStop && !teruggezet && (
              <button
                onClick={() => setConfirmStop(true)}
                disabled={busy}
                className="px-4 py-2 rounded font-medium border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Back-up stoppen
              </button>
            )}
          </div>
          <button onClick={onClose} disabled={busy} className="btn-secondary">
            Sluiten
          </button>
        </div>
      </div>
    </div>
  );
}

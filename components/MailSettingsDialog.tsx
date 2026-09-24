'use client';

/**
 * "Mailinstellingen": the Gmail account Dienstrooster sends the
 * verzendlijst from - the only place sending is set up
 * (lib/appSettings.ts, /api/planner/mail-settings). Saving logs in first,
 * so settings that don't work are never kept. The saved password is never
 * shown again; leaving the field empty keeps it.
 */

import { useEffect, useState } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';

interface Status {
  ingesteld: boolean;
  gebruiker: string | null;
  verzendlijst_aan: string | null;
  wachtwoord_onleesbaar: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** After saving or removing, so screens that depend on it can refresh. */
  onChanged?: () => void;
}

export function MailSettingsDialog({ isOpen, onClose, onChanged }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [gebruiker, setGebruiker] = useState('');
  const [wachtwoord, setWachtwoord] = useState('');
  const [aan, setAan] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useBodyScrollLock(isOpen);
  const handleBackdropClick = useDialogDismiss(isOpen, onClose, !busy);

  const apply = (s: Status) => {
    setStatus(s);
    setGebruiker(s.gebruiker ?? '');
    setAan(s.verzendlijst_aan ?? '');
    setWachtwoord('');
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setMelding(null);
    setConfirmDelete(false);
    fetch('/api/planner/mail-settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.success) apply(data.data);
        else setError('De mailinstellingen konden niet geladen worden.');
      })
      .catch(() => setError('De mailinstellingen konden niet geladen worden.'));
  }, [isOpen]);

  if (!isOpen) return null;

  const ingesteld = Boolean(status?.ingesteld);
  // Also when the password can no longer be read: then there is still something to remove.
  const opgeslagen = Boolean(status?.gebruiker);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMelding(null);
    try {
      const res = await fetch('/api/planner/mail-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gebruiker, wachtwoord, verzendlijst_aan: aan }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Opslaan is mislukt.');
      apply(data.data);
      setMelding('Opgeslagen. De inlog bij Gmail is gelukt.');
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan is mislukt.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    setMelding(null);
    try {
      const res = await fetch('/api/planner/mail-settings', { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Verwijderen is mislukt.');
      apply(data.data);
      setConfirmDelete(false);
      setMelding('De instellingen zijn verwijderd. Er wordt geen mail meer verstuurd.');
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verwijderen is mislukt.');
    } finally {
      setBusy(false);
    }
  };

  const canSave = !busy && gebruiker.trim() !== '' && aan.trim() !== '' && (wachtwoord.trim() !== '' || ingesteld);

  return (
    <div
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Mailinstellingen"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-full flex flex-col">
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Mailinstellingen</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Het account waarmee Dienstrooster de verzendlijst naar de Power Automate-stroom stuurt.
          </p>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto min-h-0">
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
            <p>De app werkt alleen met Gmail. Gebruik een app-wachtwoord van Google, niet je gewone wachtwoord.</p>
            <p>
              Zo maak je een app-wachtwoord aan: zet in je Google-account eerst verificatie in twee stappen aan. Ga
              daarna naar myaccount.google.com/apppasswords, geef het een naam (bijvoorbeeld Dienstrooster) en kies
              Maken. Google toont dan 16 letters. Die vul je hieronder in.
            </p>
          </div>
          {status?.wachtwoord_onleesbaar && (
            <p className="text-sm text-red-800">
              Het opgeslagen app-wachtwoord kan niet meer gelezen worden. Vul het opnieuw in.
            </p>
          )}

          <div>
            <label htmlFor="mail-gebruiker" className="block text-sm font-semibold text-neutral-900 mb-1">
              Gmail-adres
            </label>
            <input
              id="mail-gebruiker"
              type="email"
              autoComplete="off"
              placeholder="naam@gmail.com"
              value={gebruiker}
              onChange={(e) => setGebruiker(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>

          <div>
            <label htmlFor="mail-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-1">
              App-wachtwoord
            </label>
            <input
              id="mail-wachtwoord"
              type="password"
              autoComplete="new-password"
              placeholder={ingesteld ? 'Opgeslagen. Laat leeg om het te houden.' : '16 letters, bijvoorbeeld abcd efgh ijkl mnop'}
              value={wachtwoord}
              onChange={(e) => setWachtwoord(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>

          <div>
            <label htmlFor="mail-aan" className="block text-sm font-semibold text-neutral-900 mb-1">
              Verzendlijst sturen naar
            </label>
            <input
              id="mail-aan"
              type="email"
              autoComplete="off"
              placeholder="het adres waar de stroom op let"
              value={aan}
              onChange={(e) => setAan(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
            <p className="text-xs text-neutral-500 mt-1">
              De mailbox waar je Power Automate-stroom naar kijkt. Daar komt de mail met de verzendlijst binnen.
            </p>
          </div>

          {error && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {error}
            </div>
          )}
          {melding && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-900">{melding}</div>
          )}

          {opgeslagen && confirmDelete && (
            <div className="rounded-lg border border-red-300 bg-red-50 p-4 space-y-3">
              <p className="text-sm font-semibold text-red-900">Mailinstellingen verwijderen?</p>
              <p className="text-sm text-red-900">
                Daarna verstuurt Dienstrooster geen uitnodigingen, herinneringen of ruilmails meer. Het
                app-wachtwoord is dan ook weg uit de app.
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmDelete(false)} disabled={busy} className="btn-secondary">
                  Annuleren
                </button>
                <button
                  onClick={remove}
                  disabled={busy}
                  className="px-4 py-2 rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? 'Bezig...' : 'Ja, verwijderen'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="border-t p-6 flex-shrink-0 flex flex-wrap justify-between gap-3">
          <div>
            {opgeslagen && !confirmDelete && (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className="px-4 py-2 rounded font-medium border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Instellingen verwijderen
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} disabled={busy} className="btn-secondary">
              Sluiten
            </button>
            <button onClick={save} disabled={!canSave} className="btn-primary">
              {busy && !confirmDelete ? 'Inloggen bij Gmail...' : 'Opslaan'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

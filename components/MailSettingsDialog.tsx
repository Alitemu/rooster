'use client';

/**
 * "Mailinstellingen": the Gmail account Dienstrooster sends the
 * verzendlijst from - the only place sending is set up
 * (lib/appSettings.ts, /api/planner/mail-settings). Saving logs in first,
 * so settings that don't work are never kept. The saved password is never
 * shown again; leaving the field empty keeps it.
 *
 * Only the beheerder opens it: they are shared by the achterwacht and the
 * AIOS (the API checks it too). Since 0.87.0 a planner no longer gets the
 * button; components/MailStatus.tsx shows them how the mail stands.
 *
 * Three parts: the Gmail account, shared by both diensten, and per dienst the
 * address of its Power Automate flow (where the verzendlijst goes), the
 * planner's contact address (what participants see when something is wrong
 * in a voorlopig roster) and what waits in the queue for that dienst.
 */

import { useEffect, useState } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { withBasePath } from '@/lib/basePath';

interface Status {
  ingesteld: boolean;
  uitgeschakeld: boolean;
  gebruiker: string | null;
  verzendlijst_aan: string | null;
  contact_planner: string | null;
  wachtwoord_onleesbaar: boolean;
  wachtrij: number;
  wachtrij_items: WachtrijItem[];
}

interface WachtrijItem {
  soort: string;
  codenaam: string;
  sinds: string;
  pogingen: number;
  laatste_poging_op: string | null;
}

interface AiosStatus {
  verzendlijst_aan: string | null;
  contact_planner: string | null;
  wachtrij: number;
  wachtrij_items: WachtrijItem[];
}

const SOORT_TEKST: Record<string, string> = {
  RUILVERZOEK: 'ruilverzoek',
  RUIL_BEVESTIGING: 'bevestiging van een ruilverzoek',
  RUIL_UITKOMST: 'uitkomst van een ruil',
  RUIL_INGETROKKEN: 'ingetrokken ruilverzoek',
  RUIL_HERINNERING: 'herinnering voor een ruilverzoek',
  RUIL_HERINNERING_BEVESTIGING: 'bericht dat er een herinnering is gestuurd',
  RUIL_DOORGEVEN: 'melding van een ruil',
};

/** What waits for one dienst: how many, and which: kind, for whom, since when. Never an address or a text. */
function Wachtrij({ items, aantal }: { items: WachtrijItem[]; aantal: number }) {
  if (aantal === 0) return <p className="text-xs text-neutral-500">Er wacht geen mail.</p>;
  return (
    <div className="text-xs text-neutral-700" data-testid="mail-wachtrij">
      <p>
        {aantal} {aantal === 1 ? 'mail wacht' : 'mails wachten'} tot het versturen weer lukt. Wat te oud is of niet meer geldt, wordt weggehaald.
      </p>
      <ul className="mt-1 space-y-0.5">
        {items.map((i, n) => (
          <li key={n}>
            {SOORT_TEKST[i.soort] ?? i.soort.toLowerCase()} voor {i.codenaam || 'onbekend'}, sinds {new Date(i.sinds).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {i.pogingen > 0 ? `, ${i.pogingen} ${i.pogingen === 1 ? 'poging' : 'pogingen'}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
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
  const [contact, setContact] = useState('');
  const [aios, setAios] = useState<AiosStatus | null>(null);
  const [aiosAan, setAiosAan] = useState('');
  const [aiosContact, setAiosContact] = useState('');
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
    setContact(s.contact_planner ?? '');
    setWachtwoord('');
  };
  const applyAios = (a: AiosStatus) => {
    setAios(a);
    setAiosAan(a.verzendlijst_aan ?? '');
    setAiosContact(a.contact_planner ?? '');
  };

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setMelding(null);
    setConfirmDelete(false);
    fetch(withBasePath('/api/planner/mail-settings'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.success) apply(data.data);
        else setError('De mailinstellingen konden niet geladen worden.');
      })
      .catch(() => setError('De mailinstellingen konden niet geladen worden.'));
    fetch(withBasePath('/api/aios/mail-instellingen'))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.success && applyAios(data.data))
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  // A saved, readable password: leaving the field empty keeps it (also while
  // MAIL_UITGESCHAKELD keeps it from being used).
  const ingesteld = Boolean(
    status?.ingesteld || (status?.uitgeschakeld && status.gebruiker && !status.wachtwoord_onleesbaar)
  );
  // Also when the password can no longer be read: then there is still something to remove.
  const opgeslagen = Boolean(status?.gebruiker);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMelding(null);
    try {
      const res = await fetch(withBasePath('/api/planner/mail-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gebruiker, wachtwoord, verzendlijst_aan: aan }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Opslaan is mislukt.');
      const contactRes = await fetch(withBasePath('/api/planner/mail-settings/contact'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_planner: contact }),
      });
      const contactData = await contactRes.json().catch(() => null);
      if (!contactRes.ok || !contactData?.success) throw new Error(contactData?.error?.message || 'Het contactadres opslaan is mislukt.');
      apply({ ...data.data, contact_planner: contactData.data.contact_planner });
      setMelding('Opgeslagen. De inlog bij Gmail is gelukt.');
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan is mislukt.');
    } finally {
      setBusy(false);
    }
  };

  const saveAios = async () => {
    setBusy(true);
    setError(null);
    setMelding(null);
    try {
      const res = await fetch(withBasePath('/api/aios/mail-instellingen'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verzendlijst_aan: aiosAan, contact_planner: aiosContact }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) throw new Error(data?.error?.message || 'Opslaan is mislukt.');
      applyAios({ ...data.data, wachtrij_items: aios?.wachtrij_items ?? [] });
      setMelding('De instellingen van de AIOS zijn opgeslagen.');
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
      const res = await fetch(withBasePath('/api/planner/mail-settings'), { method: 'DELETE' });
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
          {status?.uitgeschakeld && (
            <p className="text-sm text-red-800">
              Versturen staat uit op deze installatie (MAIL_UITGESCHAKELD). Wat je hier opslaat, wordt pas gebruikt
              als dat uit het serverbestand is gehaald.
            </p>
          )}
          {status?.wachtwoord_onleesbaar && (
            <p className="text-sm text-red-800">
              Het opgeslagen app-wachtwoord kan niet meer gelezen worden. Vul het opnieuw in.
            </p>
          )}

          <h3 className="text-sm font-bold text-neutral-900 border-b pb-1">Gmail-account voor de achterwacht en de AIOS samen</h3>
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
            <h3 className="text-sm font-bold text-neutral-900 border-b pb-1 mb-2">Achterwacht</h3>
            <label htmlFor="mail-aan" className="block text-sm font-semibold text-neutral-900 mb-1">
              Verzendlijst sturen naar
            </label>
            <input
              id="mail-aan"
              type="email"
              autoComplete="off"
              placeholder="het adres waar de stroom van de achterwacht op let"
              value={aan}
              onChange={(e) => setAan(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
            <p className="text-xs text-neutral-500 mt-1">
              De mailbox waar de Power Automate-stroom van de achterwacht naar kijkt. Deelnemers zien dit adres niet.
            </p>
            <label htmlFor="mail-contact" className="block text-sm font-semibold text-neutral-900 mt-3 mb-1">
              Contactadres van de planner
            </label>
            <input
              id="mail-contact"
              type="email"
              autoComplete="off"
              placeholder="het adres dat deelnemers mailen"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
            <p className="text-xs text-neutral-500 mt-1">
              Dat adres zien deelnemers bij een voorlopig rooster en in het venster voor een ruil die niet via de app kan. Het is een
              adres van een persoon, niet de mailbox van de stroom. Laat leeg om geen adres te tonen.
            </p>
            {status && <div className="mt-2"><Wachtrij items={status.wachtrij_items} aantal={status.wachtrij} /></div>}
          </div>

          <div>
            <h3 className="text-sm font-bold text-neutral-900 border-b pb-1 mb-2">AIOS</h3>
            {aios ? (
              <>
                <label htmlFor="aios-stroom" className="block text-sm font-semibold text-neutral-900 mb-1">
                  Verzendlijst van de AIOS sturen naar
                </label>
                <input
                  id="aios-stroom"
                  type="email"
                  autoComplete="off"
                  placeholder="het adres waar de stroom van de AIOS op let"
                  value={aiosAan}
                  onChange={(e) => setAiosAan(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  De AIOS hebben een eigen stroom met een eigen adressenlijst. Het Gmail-account hierboven verstuurt ook hun mail.
                </p>
                <label htmlFor="aios-contact" className="block text-sm font-semibold text-neutral-900 mt-3 mb-1">
                  Contactadres van de planner van de AIOS
                </label>
                <input
                  id="aios-contact"
                  type="email"
                  autoComplete="off"
                  placeholder="het adres dat de AIOS mailen"
                  value={aiosContact}
                  onChange={(e) => setAiosContact(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
                <p className="text-xs text-neutral-500 mt-1">
                  Dat adres zien de AIOS bij een voorlopig rooster. Laat leeg om geen adres te tonen.
                </p>
                <div className="mt-2 flex justify-end">
                  <button type="button" onClick={saveAios} disabled={busy} className="btn-secondary">
                    Opslaan voor de AIOS
                  </button>
                </div>
                <div className="mt-2"><Wachtrij items={aios.wachtrij_items} aantal={aios.wachtrij} /></div>
              </>
            ) : (
              <p className="text-xs text-neutral-500">De instellingen van de AIOS worden geladen.</p>
            )}
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

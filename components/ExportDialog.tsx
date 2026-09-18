'use client';

/**
 * Export Dialog Component
 *
 * Interface for downloading invitations/reminders and sending emails
 */

import { useState, useEffect } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';

type ExportType = 'invitations' | 'reminders' | 'audit-trail' | null;

// Must match exactly the "Onderwerpfilter" configured on the Power
// Automate-stroom's "Wanneer een nieuwe e-mail arriveert (V2)"-trigger -
// see the "Automatisch versturen via Power Automate"-sectie hieronder.
// Dienstrooster heeft verder geen weet van Power Automate of SharePoint;
// het enige contract is deze vaste onderwerptekst plus de JSON-vorm van
// het gedownloade bestand (een lijst van {codenaam, onderwerp, tekst}).
const NOTIFICATION_TRIGGER_SUBJECT = 'DIENSTROOSTER-VERZENDLIJST';

interface ReminderTemplate {
  person_id: string;
  codenaam: string;
  email: string | null;
  personal_link: string;
  deadline: string;
  subject: string;
  body: string;
  mailto_link: string;
}

interface Props {
  periodId: string;
  periodName: string;
  isOpen: boolean;
  onClose: () => void;
  initialType?: ExportType;
}

export function ExportDialog({ periodId, periodName, isOpen, onClose, initialType = null }: Props) {
  const [exportType, setExportType] = useState<ExportType>(initialType);
  const [reminders, setReminders] = useState<ReminderTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedSubject, setEditedSubject] = useState('');
  const [editedBody, setEditedBody] = useState('');
  const [remindersLoaded, setRemindersLoaded] = useState(false);
  const [remindersLoadFailed, setRemindersLoadFailed] = useState(false);

  useEffect(() => {
    if (exportType !== 'reminders') {
      setRemindersLoaded(false);
      setRemindersLoadFailed(false);
    }
  }, [exportType]);

  // The component never unmounts between opens (isOpen just toggles
  // whether it renders null), so without this, reopening the dialog - for
  // this period or a different one - would briefly show whatever export
  // type, reminders, or error text was left over from the previous time
  // it was open.
  useEffect(() => {
    if (isOpen) {
      setExportType(initialType);
      setReminders([]);
      setLoading(false);
      setError(null);
      setEditedSubject('');
      setEditedBody('');
      setRemindersLoaded(false);
      setRemindersLoadFailed(false);
    }
  }, [isOpen, periodId, initialType]);

  const loadReminders = async () => {
    setRemindersLoaded(true);
    setRemindersLoadFailed(false);
    setLoading(true);
    try {
      // POST, not GET: this revokes and reissues everyone's personal link
      // (see the route's docstring) - a state change must not be reachable
      // by a link click.
      const res = await fetch(`/api/exports/reminders/${periodId}`, { method: 'POST' });
      if (!res.ok) throw new Error('Laden van herinneringen mislukt');

      const data = await res.json();
      setReminders(data.data);
      if (data.data.length > 0) {
        setEditedSubject(data.data[0].subject);
        setEditedBody(data.data[0].body);
      }
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Laden van herinneringen mislukt');
      setRemindersLoadFailed(true);
      setLoading(false);
    }
  };

  // The template body has the first person's own link baked in - swap it
  // for each recipient's own link so editing the surrounding text doesn't
  // break their personal link.
  const templateLink = reminders[0]?.personal_link;
  // If a planner edits the textarea so heavily that the exact link string
  // no longer appears, split/join below silently no-ops and every
  // recipient's mailto body would keep person 0's link instead of their
  // own - checked once per render so the UI can warn instead of letting
  // that happen unnoticed.
  const linkPlaceholderIntact = !templateLink || editedBody.includes(templateLink);

  const mailtoFor = (reminder: ReminderTemplate): string => {
    const body = templateLink
      ? editedBody.split(templateLink).join(reminder.personal_link)
      : editedBody;
    return `mailto:?subject=${encodeURIComponent(editedSubject)}&body=${encodeURIComponent(body)}`;
  };

  const triggerMailto = `mailto:?subject=${encodeURIComponent(NOTIFICATION_TRIGGER_SUBJECT)}&body=${encodeURIComponent(
    'Zie bijlage. Voeg het zojuist gedownloade JSON-bestand toe als bijlage voordat je deze e-mail verstuurt.'
  )}`;

  // Zelfde substitutie als mailtoFor (ieders eigen persoonlijke link, geen
  // URL-encoding nodig - dit wordt een bestand, geen mailto-link) - zo
  // geldt een bewerking van onderwerp/bericht hierboven ook voor de
  // batch-download, net als voor de losse mailto-links per persoon.
  const downloadBatchJson = () => {
    const payload = reminders.map((reminder) => ({
      codenaam: reminder.codenaam,
      onderwerp: editedSubject,
      tekst: templateLink ? editedBody.split(templateLink).join(reminder.personal_link) : editedBody,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dienstrooster-meldingen_${periodName.replace(/ /g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const downloadInvitations = async () => {
    try {
      // POST for the same reason as the reminders fetch above.
      const res = await fetch(`/api/exports/invitations/${periodId}`, { method: 'POST' });
      if (!res.ok) throw new Error('Downloaden van uitnodigingen mislukt');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invitations_${periodName.replace(/ /g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Downloaden mislukt');
    }
  };

  const downloadAuditTrail = async () => {
    try {
      const res = await fetch(`/api/exports/audit-trail/${periodId}`);
      if (!res.ok) throw new Error('Downloaden van wijzigingsgeschiedenis mislukt');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wijzigingsgeschiedenis_${periodName.replace(/ /g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Downloaden mislukt');
    }
  };

  useBodyScrollLock(isOpen);
  // No loading-based guard here - the existing Sluiten button below has
  // none either (unlike the other dialogs), so Escape/backdrop-click stay
  // consistent with that.
  const dismissBackdrop = useDialogDismiss(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Exporteren"
      onClick={dismissBackdrop}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="card p-6 max-w-2xl w-full max-h-full overflow-y-auto">
        {!exportType ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Exporteren en communicatie</h2>
            <div className="space-y-3 mb-6">
              <button
                onClick={() => setExportType('invitations')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📊 Uitnodigingen downloaden</p>
                <p className="text-sm text-neutral-600">CSV-bestand met namen en persoonlijke links</p>
              </button>

              <button
                onClick={() => setExportType('reminders')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📧 Herinneringen versturen</p>
                <p className="text-sm text-neutral-600">Vooraf ingevulde mailto-sjablonen voor deadline-herinneringen</p>
              </button>

              <button
                onClick={() => setExportType('audit-trail')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📄 Wijzigingsgeschiedenis downloaden</p>
                <p className="text-sm text-neutral-600">CSV met alle handmatige toewijzingen, wisselingen en verwijderingen - voor verantwoording</p>
              </button>
            </div>

            <button
              onClick={onClose}
              className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Sluiten
            </button>
          </>
        ) : exportType === 'invitations' ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Uitnodigingen downloaden</h2>
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">
                Het CSV-bestand bevat namen en persoonlijke links naar het voorkeurenformulier.
              </p>
              <p className="text-xs text-blue-800 mt-2">
                Kolommen: Naam, Persoonlijke link, Deadline
              </p>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">
                Downloaden maakt voor iedereen een nieuwe persoonlijke link aan. Eerder verstuurde
                links blijven gewoon werken - wie de vorige mail nog heeft, kan die blijven
                gebruiken.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={downloadInvitations}
                className="flex-1 py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                📥 CSV downloaden
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
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">
                Elke handmatige toewijzing, wisseling en verwijdering in deze periode, met reden,
                wie het deed en of daarbij een blokkade, parttime-dag of de vensterregel is
                overruled.
              </p>
              <p className="text-xs text-blue-800 mt-2">
                Kolommen: Datum wijziging, Actie, Betreft, Dienstdatum, Diensttype, Reden, Overrule, Aangepast door
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={downloadAuditTrail}
                className="flex-1 py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                📥 CSV downloaden
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

            {error && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{error}</div>
            )}

            {!remindersLoaded ? (
              <>
                <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
                  <p className="text-sm text-blue-900">
                    Dit maakt voor iedereen die nog niet heeft bevestigd een nieuwe persoonlijke link aan.
                    Eerder verstuurde links blijven gewoon werken - wie de uitnodigingsmail nog heeft,
                    kan die link blijven gebruiken.
                  </p>
                </div>
                <button
                  onClick={loadReminders}
                  className="w-full py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors mb-3"
                >
                  Herinneringen genereren
                </button>
              </>
            ) : loading ? (
              <p className="text-center text-neutral-600">Herinneringen laden...</p>
            ) : remindersLoadFailed ? (
              <button
                onClick={loadReminders}
                className="w-full py-2 px-4 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors mb-3"
              >
                Opnieuw proberen
              </button>
            ) : reminders.length === 0 ? (
              <div className="bg-green-50 border border-green-200 rounded p-4 mb-6">
                <p className="text-sm text-green-900">✓ Iedereen heeft al voorkeuren ingediend!</p>
              </div>
            ) : (
              <>
                <div className="mb-4 space-y-2">
                  <label className="block text-xs font-semibold text-neutral-700">Onderwerp</label>
                  <input
                    type="text"
                    value={editedSubject}
                    onChange={(e) => setEditedSubject(e.target.value)}
                    className="w-full px-3 py-2 border rounded text-sm"
                  />
                  <label className="block text-xs font-semibold text-neutral-700">Bericht</label>
                  <textarea
                    value={editedBody}
                    onChange={(e) => setEditedBody(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border rounded text-sm font-mono"
                  />
                  {linkPlaceholderIntact ? (
                    <p className="text-xs text-neutral-500 italic">
                      Wijzigingen gelden voor elke herinnering hieronder - ieders eigen persoonlijke link blijft intact.
                    </p>
                  ) : (
                    <p className="text-xs text-red-700 font-medium">
                      ⚠️ De persoonlijke link is uit de tekst verdwenen - iedereen zou nu dezelfde (verkeerde) link
                      krijgen. Zet de link terug in de tekst voordat je een mail verstuurt.
                    </p>
                  )}
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6 space-y-3">
                  <p className="text-sm font-semibold text-blue-900">
                    Automatisch versturen via Power Automate
                  </p>
                  <p className="text-sm text-blue-900">
                    Download het bestand hieronder en stuur het als bijlage naar jezelf - dat
                    start de Power Automate-stroom die alle {reminders.length} herinneringen
                    hieronder automatisch verstuurt.
                  </p>
                  <ol className="text-sm text-blue-900 list-decimal list-inside space-y-1">
                    <li>Download het JSON-bestand</li>
                    <li>Open een nieuwe e-mail (de knop hiernaast vult het onderwerp al goed in)</li>
                    <li>Voeg het zojuist gedownloade bestand toe als bijlage</li>
                    <li>Verstuur de e-mail naar jezelf</li>
                  </ol>
                  <div className="flex gap-3">
                    <button
                      onClick={downloadBatchJson}
                      disabled={!linkPlaceholderIntact}
                      className="flex-1 py-2 px-4 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300 transition-colors"
                    >
                      📥 JSON-bestand downloaden
                    </button>
                    <a
                      href={linkPlaceholderIntact ? triggerMailto : undefined}
                      aria-disabled={!linkPlaceholderIntact}
                      onClick={(e) => {
                        if (!linkPlaceholderIntact) e.preventDefault();
                      }}
                      className={`flex-1 py-2 px-4 rounded font-medium text-center transition-colors ${
                        linkPlaceholderIntact
                          ? 'bg-blue-100 text-blue-900 hover:bg-blue-200'
                          : 'opacity-50 cursor-not-allowed bg-blue-100 text-blue-900'
                      }`}
                    >
                      ✉️ Nieuwe e-mail openen
                    </a>
                  </div>
                  <p className="text-xs text-blue-800">
                    Onderwerp van deze e-mail moet exact{' '}
                    <code className="font-mono bg-blue-100 px-1 rounded">{NOTIFICATION_TRIGGER_SUBJECT}</code>{' '}
                    zijn - dat is wat de Power Automate-stroom herkent. De knop hierboven vult dit
                    al goed in.
                  </p>
                </div>

                <p className="text-sm text-neutral-600 mb-4">
                  Of klik op iemand om diens herinneringsmail los te openen in je standaard e-mailprogramma.
                </p>

                <div className="space-y-2 mb-6">
                  {reminders.map((reminder) => (
                    <a
                      key={reminder.person_id}
                      href={linkPlaceholderIntact ? mailtoFor(reminder) : undefined}
                      aria-disabled={!linkPlaceholderIntact}
                      onClick={(e) => {
                        if (!linkPlaceholderIntact) e.preventDefault();
                      }}
                      className={`block p-3 border rounded transition-colors ${
                        linkPlaceholderIntact
                          ? 'hover:bg-blue-50 cursor-pointer'
                          : 'opacity-50 cursor-not-allowed'
                      }`}
                    >
                      <p className="font-medium text-neutral-900">{reminder.codenaam}</p>
                      <p className="text-xs text-neutral-600">
                        Deadline: {reminder.deadline}
                      </p>
                    </a>
                  ))}
                </div>

                <p className="text-xs text-neutral-500 mb-4 italic">
                  Let op: als je op een naam klikt, opent je e-mailprogramma met een vooraf ingevuld bericht.
                  Mogelijk moet je het ontvangersadres handmatig invullen voordat je verstuurt.
                </p>
              </>
            )}

            <button
              onClick={() => setExportType(null)}
              className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Terug
            </button>
          </>
        )}
      </div>
    </div>
  );
}

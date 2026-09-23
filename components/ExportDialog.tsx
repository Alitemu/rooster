'use client';

/**
 * Export Dialog Component
 *
 * Interface for downloading invitations/reminders and sending emails
 */

import { useState, useEffect } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';

export type ExportType = 'invitations-send' | 'invitations-download' | 'reminders' | 'audit-trail' | null;

// Every mail goes out through the Power Automate flow: the server sends it
// a verzendlijst (lib/verzendlijst.ts, lib/verzendlijstMail.ts) and the
// flow mails each person. There is no route through the planner's own mail
// program any more: that needed the recipient's address typed in by hand,
// which is exactly what the flow's own address list is for.
type SendState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; aantal: number } | { kind: 'failed'; message: string };

interface ReminderTemplate {
  person_id: string;
  codenaam: string;
  personal_link: string;
  deadline: string;
  subject: string;
  body: string;
  deadline_bron: string;
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
  initialType?: ExportType;
}

function formatDeadline(deadline: string): string {
  const d = new Date(deadline);
  return isNaN(d.getTime()) ? deadline : d.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
}

export function ExportDialog({
  periodId,
  periodName,
  deadline,
  periodStatus,
  isOpen,
  onClose,
  onDeadlineChanged,
  initialType = null,
}: Props) {
  const [exportType, setExportType] = useState<ExportType>(initialType);
  const [reminders, setReminders] = useState<ReminderTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedSubject, setEditedSubject] = useState('');
  const [editedBody, setEditedBody] = useState('');
  const [remindersLoaded, setRemindersLoaded] = useState(false);
  const [remindersLoadFailed, setRemindersLoadFailed] = useState(false);
  // null while unknown: neither the automatic nor the manual route is shown
  // as "the" way until the server has said whether it can send.
  const [autoSendAvailable, setAutoSendAvailable] = useState<boolean | null>(null);
  const [sendState, setSendState] = useState<SendState>({ kind: 'idle' });
  // Per reminder, by person_id: sending one on its own, or already sent
  // (on its own or with the rest). "All" only sends the ones not sent yet.
  const [reminderSends, setReminderSends] = useState<Record<string, SendState>>({});

  useEffect(() => {
    if (exportType !== 'reminders') {
      setRemindersLoaded(false);
      setRemindersLoadFailed(false);
    }
  }, [exportType]);

  // Reminders carry the deadline in their text, so a new deadline means
  // generating them again (the send route refuses the old ones anyway).
  useEffect(() => {
    setReminders([]);
    setRemindersLoaded(false);
    setRemindersLoadFailed(false);
    setReminderSends({});
    setSendState({ kind: 'idle' });
  }, [deadline]);

  const [newDeadline, setNewDeadline] = useState('');
  const [savingDeadline, setSavingDeadline] = useState(false);
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  // The clock, refreshed when a screen opens and every half minute after,
  // so a deadline that passes while the dialog is open is noticed. The
  // server checks it again on every generate and send regardless.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [isOpen, exportType, deadline]);
  const deadlineIsPast = now !== null && new Date(deadline).getTime() < now;

  const saveDeadline = async () => {
    setSavingDeadline(true);
    setDeadlineError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/deadline`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deadline: newDeadline }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setDeadlineError(data?.error?.message ?? 'Aanpassen van de deadline is mislukt.');
        return;
      }
      setNewDeadline('');
      onDeadlineChanged?.();
    } catch {
      setDeadlineError('Geen verbinding met de server. Controleer je netwerk.');
    } finally {
      setSavingDeadline(false);
    }
  };

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
      setSendState({ kind: 'idle' });
      setReminderSends({});
    }
  }, [isOpen, periodId, initialType]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch('/api/exports/verzendlijst-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setAutoSendAvailable(Boolean(data?.data?.ingesteld));
      })
      .catch(() => {
        if (!cancelled) setAutoSendAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Switching between invitations and reminders starts a fresh send.
  useEffect(() => {
    setSendState({ kind: 'idle' });
  }, [exportType]);

  const postSend = async (url: string, body?: unknown): Promise<SendState> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        return { kind: 'failed', message: data?.error?.message ?? 'Versturen is mislukt.' };
      }
      return { kind: 'sent', aantal: data.data.aantal };
    } catch {
      return { kind: 'failed', message: 'Geen verbinding met de server. Controleer je netwerk.' };
    }
  };

  const sendInvitations = async () => {
    setSendState({ kind: 'sending' });
    setSendState(await postSend(`/api/exports/invitations/${periodId}/send`));
  };

  const loadReminders = async () => {
    setRemindersLoaded(true);
    setRemindersLoadFailed(false);
    setLoading(true);
    try {
      // POST, not GET: this revokes and reissues everyone's personal link
      // (see the route's docstring) - a state change must not be reachable
      // by a link click.
      const res = await fetch(`/api/exports/reminders/${periodId}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message ?? 'Laden van herinneringen mislukt');
      }

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
  // recipient would get person 0's link instead of their own - checked
  // once per render so the UI can warn instead of letting that happen
  // unnoticed.
  const linkPlaceholderIntact = !templateLink || editedBody.includes(templateLink);

  const reminderBericht = (reminder: ReminderTemplate) => ({
    codenaam: reminder.codenaam,
    onderwerp: editedSubject,
    tekst: templateLink ? editedBody.split(templateLink).join(reminder.personal_link) : editedBody,
  });

  const unsentReminders = reminders.filter((r) => reminderSends[r.person_id]?.kind !== 'sent');
  const anyReminderSending =
    sendState.kind === 'sending' || Object.values(reminderSends).some((st) => st.kind === 'sending');

  /** Sends these reminders as one verzendlijst; `alle` also drives the "all" button's state. */
  const sendReminders = async (list: ReminderTemplate[], alle: boolean) => {
    const mark = (state: SendState) =>
      setReminderSends((prev) => ({ ...prev, ...Object.fromEntries(list.map((r) => [r.person_id, state])) }));
    if (alle) setSendState({ kind: 'sending' });
    mark({ kind: 'sending' });
    const result = await postSend(`/api/exports/reminders/${periodId}/send`, {
      deadline: reminders[0]?.deadline_bron,
      berichten: list.map(reminderBericht),
    });
    mark(result.kind === 'sent' ? { kind: 'sent', aantal: 1 } : result);
    if (alle) setSendState(result);
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

  // Shared by invitations and reminders: both name the deadline, so past
  // it neither can go out until a new one is set.
  const deadlineEditor = (waarom: string, daarna: string) => (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-6 space-y-3">
      <p className="text-sm font-semibold text-amber-900">De deadline is al voorbij</p>
      <p className="text-sm text-amber-900">
        De deadline was {formatDeadline(deadline)}. {waarom} Stel eerst een nieuwe deadline in. {daarna}
      </p>
      <label className="block text-xs font-semibold text-amber-900" htmlFor="nieuwe-deadline">
        Nieuwe deadline
      </label>
      <input
        id="nieuwe-deadline"
        type="datetime-local"
        value={newDeadline}
        onChange={(e) => setNewDeadline(e.target.value)}
        className="w-full px-3 py-2 border rounded text-sm bg-white"
      />
      {deadlineError && (
        <p role="alert" className="text-sm text-red-700">
          {deadlineError}
        </p>
      )}
      <button
        onClick={saveDeadline}
        disabled={!newDeadline || savingDeadline}
        className="w-full py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300 transition-colors"
      >
        {savingDeadline ? 'Bezig met opslaan...' : 'Deadline opslaan'}
      </button>
    </div>
  );

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
                onClick={() => setExportType('invitations-send')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">✉️ Uitnodigingen versturen</p>
                <p className="text-sm text-neutral-600">Iedereen de eigen persoonlijke link mailen via Power Automate</p>
              </button>

              <button
                onClick={() => setExportType('reminders')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📧 Herinneringen versturen</p>
                <p className="text-sm text-neutral-600">Deadline-herinneringen via Power Automate, aan iedereen of per persoon</p>
              </button>

              <button
                onClick={() => setExportType('invitations-download')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📊 Uitnodigingen downloaden</p>
                <p className="text-sm text-neutral-600">CSV-bestand met namen en persoonlijke links</p>
              </button>

              <button
                onClick={() => setExportType('audit-trail')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📄 Wijzigingsgeschiedenis downloaden</p>
                <p className="text-sm text-neutral-600">CSV met alle handmatige toewijzingen, wisselingen en verwijderingen, voor verantwoording achteraf</p>
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
            {autoSendAvailable === null ? (
              <p className="text-center text-neutral-600 mb-4">Laden...</p>
            ) : !autoSendAvailable ? (
              <NotConfiguredNotice />
            ) : periodStatus !== 'OPEN' ? (
              <NotOpenNotice wat="Uitnodigingen" />
            ) : deadlineIsPast ? (
              deadlineEditor('Een uitnodiging met die datum heeft geen zin.', 'De uitnodigingen noemen daarna de nieuwe deadline.')
            ) : (
              <div className="bg-green-50 border border-green-200 rounded p-4 mb-6 space-y-3">
                <p className="text-sm text-green-900 mb-2">
                  De uitnodigingen noemen de huidige deadline: {formatDeadline(deadline)}.
                </p>
                <p className="text-sm text-green-900">
                  De server maakt voor iedereen een nieuwe persoonlijke link aan en stuurt de uitnodigingen
                  als verzendlijst naar de mailbox van de Power Automate-stroom. Die stuurt iedereen de
                  eigen persoonlijke link.
                </p>
                <p className="text-sm text-green-900">
                  Eerder verstuurde links blijven gewoon werken. Wie de vorige mail nog heeft, kan die
                  blijven gebruiken.
                </p>
                <SendButton label="✉️ Uitnodigingen versturen" state={sendState} onClick={sendInvitations} />
              </div>
            )}

            <button
              onClick={() => setExportType(null)}
              className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Terug
            </button>
          </>
        ) : exportType === 'invitations-download' ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Uitnodigingen downloaden</h2>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{error}</div>
            )}
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
                links blijven gewoon werken. Wie de vorige mail nog heeft, kan die blijven
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

            {autoSendAvailable === null ? (
              <p className="text-center text-neutral-600 mb-4">Laden...</p>
            ) : !autoSendAvailable ? (
              // Generating would issue everyone a link that nothing can send.
              <NotConfiguredNotice />
            ) : periodStatus !== 'OPEN' ? (
              <NotOpenNotice wat="Herinneringen" />
            ) : deadlineIsPast ? (
              deadlineEditor('Een herinnering met die datum heeft geen zin meer.', 'De herinneringen noemen daarna de nieuwe deadline.')
            ) : !remindersLoaded ? (
              <>
                <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
                  <p className="text-sm text-blue-900 mb-2">
                    De herinneringen noemen de huidige deadline: {formatDeadline(deadline)}.
                  </p>
                  <p className="text-sm text-blue-900">
                    Dit maakt voor iedereen die nog niet heeft bevestigd een nieuwe persoonlijke link aan.
                    Eerder verstuurde links blijven gewoon werken. Wie de uitnodigingsmail nog heeft,
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
                      Wijzigingen gelden voor elke herinnering hieronder. Ieders eigen persoonlijke link blijft intact.
                    </p>
                  ) : (
                    <p className="text-xs text-red-700 font-medium">
                      ⚠️ De persoonlijke link is uit de tekst verdwenen. Iedereen zou nu dezelfde (verkeerde) link
                      krijgen. Zet de link terug in de tekst voordat je iets verstuurt.
                    </p>
                  )}
                </div>

                <div className="bg-green-50 border border-green-200 rounded p-4 mb-6 space-y-3">
                  <p className="text-sm font-semibold text-green-900">Versturen via Power Automate</p>
                  <p className="text-sm text-green-900">
                    {unsentReminders.length === reminders.length
                      ? `Stuurt alle ${reminders.length} herinneringen met de tekst hierboven naar de Power Automate-stroom.`
                      : unsentReminders.length === 0
                        ? 'Alle herinneringen zijn verstuurd.'
                        : `Stuurt de ${unsentReminders.length} herinneringen die nog niet verstuurd zijn.`}
                  </p>
                  {unsentReminders.length > 0 && (
                    <SendButton
                      label={
                        unsentReminders.length === reminders.length
                          ? '✉️ Alle herinneringen versturen'
                          : `✉️ De overige ${unsentReminders.length} versturen`
                      }
                      state={sendState.kind === 'sent' ? { kind: 'idle' } : sendState}
                      disabled={!linkPlaceholderIntact || anyReminderSending}
                      onClick={() => sendReminders(unsentReminders, true)}
                    />
                  )}
                  {sendState.kind === 'sent' && unsentReminders.length === 0 && (
                    <p role="status" className="text-sm text-green-900">
                      ✓ Verstuurd. De Power Automate-stroom mailt iedereen nu de eigen persoonlijke link.
                    </p>
                  )}
                </div>

                <p className="text-sm text-neutral-600 mb-2">Of verstuur de herinnering per persoon.</p>
                <ul className="space-y-2 mb-6">
                  {reminders.map((reminder) => {
                    const state = reminderSends[reminder.person_id] ?? { kind: 'idle' };
                    return (
                      <li key={reminder.person_id} className="p-3 border rounded">
                        <div className="flex items-center gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-neutral-900">{reminder.codenaam}</p>
                            <p className="text-xs text-neutral-600">Deadline: {reminder.deadline}</p>
                          </div>
                          {state.kind === 'sent' ? (
                            <span className="text-sm text-green-800 whitespace-nowrap">✓ Verstuurd</span>
                          ) : (
                            <button
                              onClick={() => sendReminders([reminder], false)}
                              disabled={!linkPlaceholderIntact || anyReminderSending}
                              aria-label={`Herinnering versturen aan ${reminder.codenaam}`}
                              className="py-1.5 px-3 rounded text-sm font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300 transition-colors whitespace-nowrap"
                            >
                              {state.kind === 'sending' ? 'Bezig...' : '✉️ Versturen'}
                            </button>
                          )}
                        </div>
                        {state.kind === 'failed' && (
                          <p role="alert" className="text-sm text-red-700 mt-2">
                            {state.message}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
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

function SendButton({
  label,
  state,
  disabled = false,
  onClick,
}: {
  label: string;
  state: SendState;
  disabled?: boolean;
  onClick: () => void;
}) {
  // Once sent, the button stays disabled: a second click would mail
  // everyone a second time (with yet another fresh link).
  const done = state.kind === 'sent';
  return (
    <div className="space-y-2">
      <button
        onClick={onClick}
        disabled={disabled || done || state.kind === 'sending'}
        className="w-full py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-green-300 transition-colors"
      >
        {state.kind === 'sending' ? 'Bezig met versturen...' : label}
      </button>
      {state.kind === 'sent' && (
        <p role="status" className="text-sm text-green-900">
          ✓ Verzendlijst met {state.aantal} {state.aantal === 1 ? 'bericht' : 'berichten'} verstuurd. De Power
          Automate-stroom mailt iedereen nu de eigen persoonlijke link.
        </p>
      )}
      {state.kind === 'failed' && (
        <p role="alert" className="text-sm text-red-700">
          {state.message}
        </p>
      )}
    </div>
  );
}

function NotConfiguredNotice() {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-6">
      <p className="text-sm font-semibold text-amber-900">Versturen is nog niet ingesteld</p>
      <p className="text-sm text-amber-900 mt-1">
        De server kan nog geen mail naar de Power Automate-stroom sturen. De beheerder stelt dat in met
        SMTP_USER, SMTP_PASS en VERZENDLIJST_AAN in het .env-bestand. De stappen staan in
        docs/verzendlijst-power-automate.md.
      </p>
    </div>
  );
}

function NotOpenNotice({ wat }: { wat: 'Uitnodigingen' | 'Herinneringen' }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded p-4 mb-6">
      <p className="text-sm text-amber-900">
        {wat} kunnen alleen verstuurd worden zolang de periode open staat voor voorkeuren.
      </p>
    </div>
  );
}

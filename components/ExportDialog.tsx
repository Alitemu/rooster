'use client';

/**
 * Export Dialog Component
 *
 * Interface for downloading invitations/reminders and sending emails
 */

import { useState, useEffect } from 'react';

type ExportType = 'invitations' | 'reminders' | null;

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
}

export function ExportDialog({ periodId, periodName, isOpen, onClose }: Props) {
  const [exportType, setExportType] = useState<ExportType>(null);
  const [reminders, setReminders] = useState<ReminderTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedSubject, setEditedSubject] = useState('');
  const [editedBody, setEditedBody] = useState('');

  useEffect(() => {
    if (exportType === 'reminders') {
      loadReminders();
    }
  }, [exportType]);

  const loadReminders = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/exports/reminders/${periodId}`);
      if (!res.ok) throw new Error('Failed to load reminders');

      const data = await res.json();
      setReminders(data.data);
      if (data.data.length > 0) {
        setEditedSubject(data.data[0].subject);
        setEditedBody(data.data[0].body);
      }
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reminders');
      setLoading(false);
    }
  };

  // The template body has the first person's own link baked in - swap it
  // for each recipient's own link so editing the surrounding text doesn't
  // break their personal link.
  const mailtoFor = (reminder: ReminderTemplate): string => {
    const templateLink = reminders[0]?.personal_link;
    const body = templateLink
      ? editedBody.split(templateLink).join(reminder.personal_link)
      : editedBody;
    return `mailto:?subject=${encodeURIComponent(editedSubject)}&body=${encodeURIComponent(body)}`;
  };

  const downloadInvitations = async () => {
    try {
      const res = await fetch(`/api/exports/invitations/${periodId}`);
      if (!res.ok) throw new Error('Failed to download invitations');

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
      setError(err instanceof Error ? err.message : 'Failed to download');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Export"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    >
      <div className="card p-6 max-w-2xl w-full mx-4 max-h-96 overflow-y-auto">
        {!exportType ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Export & Communications</h2>
            <div className="space-y-3 mb-6">
              <button
                onClick={() => setExportType('invitations')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📊 Download Invitations</p>
                <p className="text-sm text-neutral-600">CSV file with staff names and personal links</p>
              </button>

              <button
                onClick={() => setExportType('reminders')}
                className="w-full p-4 text-left border-2 border-neutral-200 rounded hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <p className="font-semibold text-neutral-900">📧 Send Reminders</p>
                <p className="text-sm text-neutral-600">Pre-filled mailto templates for deadline reminders</p>
              </button>
            </div>

            <button
              onClick={onClose}
              className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Close
            </button>
          </>
        ) : exportType === 'invitations' ? (
          <>
            <h2 className="text-2xl font-bold mb-4">Download Invitations</h2>
            <div className="bg-blue-50 border border-blue-200 rounded p-4 mb-6">
              <p className="text-sm text-blue-900">
                CSV file will contain staff names and personal links to the preferences form.
              </p>
              <p className="text-xs text-blue-800 mt-2">
                Columns: Name, Personal Link, Deadline
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={downloadInvitations}
                className="flex-1 py-2 px-4 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
              >
                📥 Download CSV
              </button>
              <button
                onClick={() => setExportType(null)}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Back
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-2xl font-bold mb-4">Send Reminders</h2>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4 text-sm text-red-700">{error}</div>
            )}

            {loading ? (
              <p className="text-center text-neutral-600">Loading reminders...</p>
            ) : reminders.length === 0 ? (
              <div className="bg-green-50 border border-green-200 rounded p-4 mb-6">
                <p className="text-sm text-green-900">✓ All staff have already submitted their preferences!</p>
              </div>
            ) : (
              <>
                <div className="mb-4 space-y-2">
                  <label className="block text-xs font-semibold text-neutral-700">Subject</label>
                  <input
                    type="text"
                    value={editedSubject}
                    onChange={(e) => setEditedSubject(e.target.value)}
                    className="w-full px-3 py-2 border rounded text-sm"
                  />
                  <label className="block text-xs font-semibold text-neutral-700">Message</label>
                  <textarea
                    value={editedBody}
                    onChange={(e) => setEditedBody(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border rounded text-sm font-mono"
                  />
                  <p className="text-xs text-neutral-500 italic">
                    Edits apply to every reminder below - each person's own personal link is kept intact.
                  </p>
                </div>

                <p className="text-sm text-neutral-600 mb-4">
                  Click on a staff member to open their reminder email in your default email client.
                </p>

                <div className="space-y-2 mb-6">
                  {reminders.map((reminder) => (
                    <a
                      key={reminder.person_id}
                      href={mailtoFor(reminder)}
                      className="block p-3 border rounded hover:bg-blue-50 transition-colors"
                    >
                      <p className="font-medium text-neutral-900">{reminder.codenaam}</p>
                      <p className="text-xs text-neutral-600">
                        Deadline: {reminder.deadline}
                      </p>
                    </a>
                  ))}
                </div>

                <p className="text-xs text-neutral-500 mb-4 italic">
                  Note: Clicking a name will open your email client with a pre-filled message. You may need
                  to update the recipient address manually before sending.
                </p>
              </>
            )}

            <button
              onClick={() => setExportType(null)}
              className="w-full py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}

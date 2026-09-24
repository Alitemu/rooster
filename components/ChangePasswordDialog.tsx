'use client';

/**
 * Change your own planner password.
 *
 * The application had no screen for this at all: /planner/login claims an
 * account that still has no password, and after that the only way to change
 * one was an UPDATE against the SQLite file by hand. That is untenable for
 * the one password that controls the whole roster - especially with the
 * seed setting a known value that is checked into this repository.
 */

import { useState } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { withBasePath } from '@/lib/basePath';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function ChangePasswordDialog({ isOpen, onClose }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useBodyScrollLock(isOpen);
  const handleBackdropClick = useDialogDismiss(isOpen, onClose, !submitting);

  if (!isOpen) return null;

  const reset = () => {
    setCurrent('');
    setNext('');
    setRepeat('');
    setError(null);
    setDone(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setError(null);

    // Checked here rather than server-side: the repeat field only exists to
    // catch a typo in this form, and sending it would mean the password
    // travels twice for no reason.
    if (next !== repeat) {
      setError('De twee nieuwe wachtwoorden zijn niet gelijk');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(withBasePath('/api/auth/change-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ huidig_wachtwoord: current, nieuw_wachtwoord: next }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data?.error?.message ?? 'Wijzigen van het wachtwoord is mislukt');
        return;
      }

      setCurrent('');
      setNext('');
      setRepeat('');
      setDone(true);
    } catch {
      setError('Wijzigen van het wachtwoord is mislukt');
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = current.length > 0 && next.length > 0 && repeat.length > 0 && !submitting;

  return (
    <div
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Wachtwoord wijzigen"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-full flex flex-col">
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Wachtwoord wijzigen</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Minimaal 12 tekens, met hoofdletters, kleine letters, cijfers en een leesteken.
          </p>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto min-h-0">
          {done ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900 space-y-1">
              <p className="font-semibold">Je wachtwoord is gewijzigd.</p>
              <p>
                Je blijft hier ingelogd. Was je ook nog ingelogd op een andere computer of in een
                andere browser? Die sessie is nu beëindigd.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="huidig-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-2">
                  Huidig wachtwoord
                </label>
                <input
                  id="huidig-wachtwoord"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>

              <div>
                <label htmlFor="nieuw-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-2">
                  Nieuw wachtwoord
                </label>
                <input
                  id="nieuw-wachtwoord"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>

              <div>
                <label htmlFor="herhaal-wachtwoord" className="block text-sm font-semibold text-neutral-900 mb-2">
                  Nieuw wachtwoord herhalen
                </label>
                <input
                  id="herhaal-wachtwoord"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="border-t p-6 flex-shrink-0 flex justify-end gap-3">
          <button onClick={close} disabled={submitting} className="btn-secondary">
            {done ? 'Sluiten' : 'Annuleren'}
          </button>
          {!done && (
            <button onClick={handleSubmit} disabled={!canSubmit} className="btn-primary">
              {submitting ? 'Bezig...' : 'Wachtwoord wijzigen'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

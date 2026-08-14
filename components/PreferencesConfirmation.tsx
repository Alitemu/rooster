'use client';

/**
 * Preferences Confirmation Component
 *
 * Summary of blocked days with prominent vacation reminder.
 * Shows counts by shift counter in words.
 * Confirms part-time days were checked.
 * Submits preferences to API.
 */

import { useState } from 'react';

interface BlockedDaysSummary {
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  total: number;
}

interface Props {
  personId: string;
  periodId: string;
  blockedDays: BlockedDaysSummary;
  parttimeConfirmed: boolean;
  onSubmit?: (success: boolean) => void;
}

export function PreferencesConfirmation({
  personId,
  periodId,
  blockedDays,
  parttimeConfirmed,
  onSubmit,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasVacationCheck, setHasVacationCheck] = useState(false);

  const handleSubmit = async () => {
    if (!hasVacationCheck) {
      setError('Please confirm you have blocked your vacation days');
      return;
    }

    if (!parttimeConfirmed) {
      setError('Please confirm part-time days first');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/person/${personId}/preferences/submission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: periodId,
          parttime_confirmed: true,
        }),
      });

      if (!res.ok) {
        throw new Error('Failed to submit preferences');
      }

      onSubmit?.(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      onSubmit?.(false);
    } finally {
      setSubmitting(false);
    }
  };

  const formatNumber = (n: number): string => {
    if (n === 0) return 'no';
    if (n === 1) return '1';
    return String(n);
  };

  const avondText = blockedDays.AVOND === 1 ? 'evening shift' : 'evening shifts';
  const weekendText = blockedDays.WEEKEND === 1 ? 'weekend shift' : 'weekend shifts';
  const feestdagText = blockedDays.FEESTDAG === 1 ? 'holiday shift' : 'holiday shifts';

  return (
    <div className="card p-6 space-y-6">
      <div>
        <h3 className="font-bold text-lg mb-2">Confirm Your Preferences</h3>
        <p className="text-sm text-neutral-600">
          Please review and confirm your blocked days before submitting
        </p>
      </div>

      {/* Summary by counter type */}
      <div className="space-y-3">
        <h4 className="font-semibold text-neutral-800">Blocked days by shift type:</h4>
        <div className="space-y-2 pl-4">
          {blockedDays.AVOND > 0 && (
            <p className="text-sm">
              <span className="font-mono font-bold">{formatNumber(blockedDays.AVOND)}</span> {avondText}
            </p>
          )}
          {blockedDays.WEEKEND > 0 && (
            <p className="text-sm">
              <span className="font-mono font-bold">{formatNumber(blockedDays.WEEKEND)}</span> {weekendText}
            </p>
          )}
          {blockedDays.FEESTDAG > 0 && (
            <p className="text-sm">
              <span className="font-mono font-bold">{formatNumber(blockedDays.FEESTDAG)}</span> {feestdagText}
            </p>
          )}
          {blockedDays.total === 0 && (
            <p className="text-sm text-neutral-600 italic">No days blocked</p>
          )}
        </div>
      </div>

      {/* Critical vacation reminder */}
      <div className="bg-red-50 border-2 border-red-300 rounded p-4">
        <p className="font-bold text-red-900 mb-2">⚠️ Important Reminder</p>
        <p className="text-red-900 font-semibold mb-2">
          Have you blocked all your vacation days?
        </p>
        <p className="text-sm text-red-800 mb-3">
          Vacation days will not be retrieved from any other source. If you don't block them here,
          you will be scheduled to work during your vacation. Please verify all vacation periods
          are marked as "blocked" before confirming.
        </p>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={hasVacationCheck}
            onChange={(e) => setHasVacationCheck(e.target.checked)}
            className="mt-1 h-5 w-5 rounded border-red-300 text-red-600
                       focus:ring-red-500 cursor-pointer"
          />
          <span className="text-sm font-medium text-red-900">
            Yes, I have blocked all my vacation days
          </span>
        </label>
      </div>

      {/* Part-time confirmation status */}
      <div className={`p-3 rounded flex items-start gap-2
        ${parttimeConfirmed ? 'bg-green-50 border border-green-200' : 'bg-amber-50 border border-amber-200'}`}>
        <span className={parttimeConfirmed ? 'text-green-600 font-bold' : 'text-amber-600 font-bold'}>
          {parttimeConfirmed ? '✓' : '⚠'}
        </span>
        <span className={parttimeConfirmed ? 'text-green-900' : 'text-amber-900 font-medium'}>
          {parttimeConfirmed
            ? 'Part-time days confirmed'
            : 'Part-time days must be confirmed before submitting'}
        </span>
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={submitting || !parttimeConfirmed}
        className={`w-full py-3 px-4 rounded font-semibold text-white transition-colors
          ${submitting || !parttimeConfirmed
            ? 'bg-neutral-400 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800'}`}
      >
        {submitting ? 'Submitting...' : 'Confirm and Submit'}
      </button>

      {/* Help text */}
      <div className="text-xs text-neutral-500 italic">
        Once submitted, you cannot change your preferences until the period is closed.
      </div>
    </div>
  );
}

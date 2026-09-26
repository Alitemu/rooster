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
import { withBasePath } from '@/lib/basePath';

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
  voorkeurDays?: number;
  parttimeConfirmed: boolean;
  readOnly?: boolean;
  onSubmit?: (success: boolean) => void;
}

export function PreferencesConfirmation({
  personId,
  periodId,
  blockedDays,
  voorkeurDays = 0,
  parttimeConfirmed,
  readOnly = false,
  onSubmit,
}: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasVacationCheck, setHasVacationCheck] = useState(false);

  const handleSubmit = async () => {
    if (!hasVacationCheck) {
      setError('Bevestig dat je vakantie en ander verlof erin staan');
      return;
    }

    if (!parttimeConfirmed) {
      setError('Bevestig eerst je deeltijddagen');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/preferences/submission`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: periodId,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || 'Indienen van voorkeuren mislukt');
      }

      onSubmit?.(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Onbekende fout';
      setError(message);
      onSubmit?.(false);
    } finally {
      setSubmitting(false);
    }
  };

  const formatNumber = (n: number): string => {
    if (n === 0) return 'geen';
    if (n === 1) return '1';
    return String(n);
  };

  const avondText = blockedDays.AVOND === 1 ? 'avonddienst' : 'avonddiensten';
  const weekendText = blockedDays.WEEKEND === 1 ? 'weekenddienst' : 'weekenddiensten';
  const feestdagText = blockedDays.FEESTDAG === 1 ? 'feestdagdienst' : 'feestdagdiensten';

  return (
    <div className="card p-6 space-y-6">
      <div>
        <h3 className="font-bold text-lg mb-2">Bevestig je voorkeuren</h3>
        <p className="text-sm text-neutral-600">
          Controleer en bevestig je geblokkeerde dagen voordat je indient
        </p>
      </div>

      {/* Summary by counter type */}
      <div className="space-y-3">
        <h4 className="font-semibold text-neutral-800">Geblokkeerde dagen per diensttype:</h4>
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
            <p className="text-sm text-neutral-600 italic">Geen dagen geblokkeerd</p>
          )}
        </div>
      </div>

      {voorkeurDays > 0 && (
        <div className="bg-green-50 border border-green-200 rounded p-3">
          <p className="text-sm text-green-900">
            <span className="font-mono font-bold">{voorkeurDays}</span>{' '}
            {voorkeurDays === 1 ? 'dag' : 'dagen'} als voorkeur opgegeven
          </p>
        </div>
      )}

      {/* Critical vacation reminder and the part-time status. After the
          deadline there is nothing left to confirm, so neither is shown. */}
      {!readOnly && (
        <>
          <div className="bg-red-50 border-2 border-red-300 rounded p-4">
            <p className="font-bold text-red-900 mb-2">⚠️ Belangrijke herinnering</p>
            <p className="text-red-900 font-semibold mb-2">
              Staan je vakantie en ander verlof erin?
            </p>
            <p className="text-sm text-red-800 mb-3">
              Het rooster haalt vakantie nergens anders vandaan. Staat een vakantie niet bij
              Afwezigheid of als geblokkeerde dag in je kalender, dan kun je tijdens je vakantie
              ingedeeld worden. Controleer het voordat je bevestigt.
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
                Ja, mijn vakantie en ander verlof staan erin
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
                ? 'Deeltijddagen bevestigd'
                : 'Bevestig eerst bij de stap Deeltijd dat je deeltijddagen en afwezigheid kloppen. Daarna kun je indienen.'}
            </span>
          </div>
        </>
      )}

      {/* Error message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {readOnly && (
        <div className="bg-neutral-100 border border-neutral-300 rounded p-3">
          <p className="text-sm text-neutral-700">
            De deadline voor deze periode is verstreken. Indienen en wijzigen kan niet meer.
          </p>
        </div>
      )}

      {/* Submit button */}
      {!readOnly && (
        <button
          onClick={handleSubmit}
          disabled={submitting || !parttimeConfirmed || !hasVacationCheck || readOnly}
          className={`w-full py-3 px-4 rounded font-semibold text-white transition-colors
            ${submitting || !parttimeConfirmed || !hasVacationCheck || readOnly
              ? 'bg-neutral-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800'}`}
        >
          {submitting ? 'Bezig met indienen...' : 'Bevestigen en indienen'}
        </button>
      )}

      {/* Help text */}
      {!readOnly && (
        <div className="text-xs text-neutral-500 italic">
          Ook na het indienen kun je je voorkeuren nog aanpassen, zolang de deadline niet
          verstreken is.
        </div>
      )}
    </div>
  );
}

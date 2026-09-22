'use client';

/**
 * Roster Publication Dialog
 *
 * Pre-publication validation checklist and publishing interface.
 *
 * Two different kinds of finding, shown differently on purpose - see
 * lib/publicationCheck.ts's module doc for why they are not the same
 * thing:
 *
 *   - issues: the roster genuinely is not finished (an unfilled slot).
 *     Publish stays disabled until these are fixed.
 *   - warnings: a rule the roster deliberately breaks, on the planner's own
 *     say-so (an ABSOLUUT override, a window-rule override, or a band/
 *     streefbereik violation - see lib/publicationCheck.ts for why a band
 *     violation belongs here and not among issues). These require ticking
 *     a confirmation box before Publish enables, but do not block it
 *     outright - blocking on the same override a planner just made on
 *     purpose left no way to ever publish a roster that used it.
 */

import { useState, useEffect } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';

interface ValidationCheck {
  slots_filled: boolean;
  no_hard_blocking: boolean;
  band_compliance: boolean;
  window_compliance: boolean;
}

interface CheckResult {
  valid: boolean;
  requiresConfirmation: boolean;
  issues: string[];
  warnings: string[];
  checks: ValidationCheck;
  totals: {
    total_slots: number;
    assigned_slots: number;
    people_affected: number;
  };
}

interface Props {
  periodId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function RosterPublicationDialog({ periodId, isOpen, onClose, onSuccess }: Props) {
  const [validating, setValidating] = useState(true);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [overridesConfirmed, setOverridesConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Reset the checkbox on every open - a stale "confirmed" from a
    // previous visit to this dialog must not silently carry over to a
    // roster that has since changed underneath it.
    setOverridesConfirmed(false);

    const validateRoster = async () => {
      setValidating(true);
      setError(null);

      try {
        const res = await fetch(`/api/planner/period/${periodId}/publication-check`);
        if (!res.ok) throw new Error('Valideren van rooster mislukt');

        const data = await res.json();
        setCheckResult(data.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Valideren van rooster mislukt');
      } finally {
        setValidating(false);
      }
    };

    validateRoster();
  }, [periodId, isOpen]);

  const handlePublish = async () => {
    setPublishing(true);
    setError(null);

    try {
      // No publisher in the body: the route takes it from the session
      // (auth.userId) and ignores anything sent here. The literal
      // 'current-user' string this used to post was dead data behind a
      // stale "TODO: get from auth" that suggested auth was still missing.
      const res = await fetch(`/api/planner/period/${periodId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          checkResult?.requiresConfirmation ? { confirmOverrides: overridesConfirmed } : {}
        ),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Publiceren van rooster mislukt');
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Publiceren van rooster mislukt');
    } finally {
      setPublishing(false);
    }
  };

  useBodyScrollLock(isOpen);
  // Mirrors the Sluiten button below (disabled={publishing}).
  const dismissBackdrop = useDialogDismiss(isOpen, onClose, !publishing);

  if (!isOpen) return null;

  const hasIssues = !checkResult?.valid;
  const needsConfirmation = !!checkResult?.requiresConfirmation;
  const canPublish =
    !!checkResult && !hasIssues && (!needsConfirmation || overridesConfirmed);

  const bannerTone = hasIssues ? 'amber' : needsConfirmation ? 'amber' : 'green';
  const bannerTitle = hasIssues
    ? 'Problemen gevonden'
    : needsConfirmation
      ? 'Bewuste uitzonderingen gevonden'
      : 'Klaar om te publiceren';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rooster publiceren"
      onClick={dismissBackdrop}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-full flex flex-col">
        {/* Header */}
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Rooster publiceren</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Laatste controle voordat het rooster naar het personeel gaat
          </p>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto min-h-0">
          {validating && (
            <div className="text-center py-8">
              <p className="text-neutral-600">Rooster valideren...</p>
            </div>
          )}

          {!validating && checkResult && (
            <div className="space-y-4">
              {/* Status */}
              <div
                className={`p-4 rounded-lg ${
                  bannerTone === 'green'
                    ? 'bg-green-50 border border-green-200'
                    : 'bg-amber-50 border border-amber-200'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl">{bannerTone === 'green' ? '✓' : '⚠️'}</span>
                  <div>
                    <h3
                      className={`font-semibold ${
                        bannerTone === 'green' ? 'text-green-900' : 'text-amber-900'
                      }`}
                    >
                      {bannerTitle}
                    </h3>
                    {checkResult.issues.length > 0 && (
                      <ul className="mt-2 space-y-1 text-sm text-amber-800">
                        {checkResult.issues.map((issue, i) => (
                          <li key={i}>• {issue}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>

              {/* Deliberate overrides - separate from issues above, since
                  these do not block publishing on their own. */}
              {checkResult.warnings.length > 0 && (
                <div className="p-4 rounded-lg bg-amber-50 border border-amber-200">
                  <h3 className="font-semibold text-amber-900">Bewuste uitzonderingen</h3>
                  <p className="text-sm text-amber-800 mt-1">
                    Dit rooster bevat handmatige toewijzingen die bewust een regel doorbreken
                    (bijvoorbeeld op verzoek van de betrokkene). Controleer ze voordat je publiceert.
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-amber-800">
                    {checkResult.warnings.map((warning, i) => (
                      <li key={i}>• {warning}</li>
                    ))}
                  </ul>
                  <label className="flex items-start gap-2 mt-3 text-sm text-amber-900">
                    <input
                      type="checkbox"
                      checked={overridesConfirmed}
                      onChange={(e) => setOverridesConfirmed(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>Ik heb deze uitzonderingen gezien en bevestig dat ze bewust zijn.</span>
                  </label>
                </div>
              )}

              {/* Totals */}
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-3 bg-neutral-50 rounded">
                  <p className="text-2xl font-bold text-neutral-900">
                    {checkResult.totals.assigned_slots}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">Diensten ingevuld</p>
                </div>
                <div className="text-center p-3 bg-neutral-50 rounded">
                  <p className="text-2xl font-bold text-neutral-900">
                    {checkResult.totals.total_slots}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">Diensten totaal</p>
                </div>
                <div className="text-center p-3 bg-neutral-50 rounded">
                  <p className="text-2xl font-bold text-neutral-900">
                    {checkResult.totals.people_affected}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">Personen</p>
                </div>
              </div>

              {/* Checks */}
              <div className="space-y-2">
                <h4 className="font-semibold text-sm">Controles:</h4>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.slots_filled ? 'text-green-700' : 'text-red-700'}>
                      {checkResult.checks.slots_filled ? '✓' : '✗'}
                    </span>
                    Alle diensten ingevuld
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.no_hard_blocking ? 'text-green-700' : 'text-amber-700'}>
                      {checkResult.checks.no_hard_blocking ? '✓' : '⚠️'}
                    </span>
                    Geen overtredingen van blokkades
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.window_compliance ? 'text-green-700' : 'text-amber-700'}>
                      {checkResult.checks.window_compliance ? '✓' : '⚠️'}
                    </span>
                    Geen overtredingen van het venster
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.band_compliance ? 'text-green-700' : 'text-amber-700'}>
                      {checkResult.checks.band_compliance ? '✓' : '⚠️'}
                    </span>
                    Binnen bereik
                  </label>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-6 flex gap-3 flex-shrink-0">
          <button
            onClick={onClose}
            disabled={publishing}
            className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
          >
            Sluiten
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing || validating || !canPublish}
            className="flex-1 px-4 py-2 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-neutral-400 transition-colors"
          >
            {publishing ? 'Bezig met publiceren...' : 'Nu publiceren'}
          </button>
        </div>
      </div>
    </div>
  );
}

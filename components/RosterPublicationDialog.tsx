'use client';

/**
 * Roster Publication Dialog
 *
 * Pre-publication validation checklist and publishing interface.
 */

import { useState, useEffect } from 'react';

interface ValidationCheck {
  slots_filled: boolean;
  no_hard_blocking: boolean;
  band_compliance: boolean;
}

interface CheckResult {
  valid: boolean;
  issues: string[];
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
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const validateRoster = async () => {
      setValidating(true);
      setError(null);

      try {
        const res = await fetch(`/api/planner/period/${periodId}/publication-check`);
        if (!res.ok) throw new Error('Failed to validate roster');

        const data = await res.json();
        setCheckResult(data.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to validate roster');
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
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to publish roster');
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to publish roster');
    } finally {
      setPublishing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Publish Roster"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* Header */}
        <div className="border-b p-6">
          <h2 className="text-xl font-bold">Publish Roster</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Final validation before publishing to staff
          </p>
        </div>

        {/* Content */}
        <div className="p-6">
          {validating && (
            <div className="text-center py-8">
              <p className="text-neutral-600">Validating roster...</p>
            </div>
          )}

          {!validating && checkResult && (
            <div className="space-y-4">
              {/* Status */}
              <div
                className={`p-4 rounded-lg ${
                  checkResult.valid
                    ? 'bg-green-50 border border-green-200'
                    : 'bg-amber-50 border border-amber-200'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl">
                    {checkResult.valid ? '✓' : '⚠️'}
                  </span>
                  <div>
                    <h3 className={`font-semibold ${checkResult.valid ? 'text-green-900' : 'text-amber-900'}`}>
                      {checkResult.valid ? 'Ready to Publish' : 'Issues Found'}
                    </h3>
                    {checkResult.issues.length > 0 && (
                      <ul className={`mt-2 space-y-1 text-sm ${checkResult.valid ? 'text-green-800' : 'text-amber-800'}`}>
                        {checkResult.issues.map((issue, i) => (
                          <li key={i}>• {issue}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>

              {/* Totals */}
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-3 bg-neutral-50 rounded">
                  <p className="text-2xl font-bold text-neutral-900">
                    {checkResult.totals.assigned_slots}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">Slots Filled</p>
                </div>
                <div className="text-center p-3 bg-neutral-50 rounded">
                  <p className="text-2xl font-bold text-neutral-900">
                    {checkResult.totals.total_slots}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">Total Slots</p>
                </div>
                <div className="text-center p-3 bg-neutral-50 rounded">
                  <p className="text-2xl font-bold text-neutral-900">
                    {checkResult.totals.people_affected}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">People</p>
                </div>
              </div>

              {/* Checks */}
              <div className="space-y-2">
                <h4 className="font-semibold text-sm">Validation Checks:</h4>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.slots_filled ? 'text-green-700' : 'text-red-700'}>
                      {checkResult.checks.slots_filled ? '✓' : '✗'}
                    </span>
                    All slots filled
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.no_hard_blocking ? 'text-green-700' : 'text-red-700'}>
                      {checkResult.checks.no_hard_blocking ? '✓' : '✗'}
                    </span>
                    No hard blocking violations
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className={checkResult.checks.band_compliance ? 'text-green-700' : 'text-red-700'}>
                      {checkResult.checks.band_compliance ? '✓' : '✗'}
                    </span>
                    Band compliance
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
        <div className="border-t p-6 flex gap-3">
          <button
            onClick={onClose}
            disabled={publishing}
            className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
          >
            Close
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing || !checkResult?.valid || validating}
            className="flex-1 px-4 py-2 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-neutral-400 transition-colors"
          >
            {publishing ? 'Publishing...' : 'Publish Now'}
          </button>
        </div>
      </div>
    </div>
  );
}

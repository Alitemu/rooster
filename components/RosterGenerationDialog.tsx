'use client';

/**
 * Roster Generation Dialog
 *
 * Modal dialog for initiating solver run, showing progress,
 * and displaying results (assignments, cost, violations, time).
 */

import { useState } from 'react';

interface UnfilledSlot {
  slot_id: string;
  shortfall: number;
  datum: string | null;
  teller: string | null;
}

interface GenerateResult {
  assignments_created: number;
  unfilled_slots: UnfilledSlot[];
  fully_covered: boolean;
  cost: number;
  violations: Record<string, number>;
  time_seconds: number;
  solver_status: string;
}

interface Props {
  periodId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function RosterGenerationDialog({ periodId, isOpen, onClose, onSuccess }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/planner/period/${periodId}/generate-roster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to generate roster');
      }

      const data = await res.json();
      setResult(data.data);

      if (onSuccess) {
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate roster');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        {/* Header */}
        <div className="border-b p-6">
          <h2 className="text-xl font-bold">Generate Roster</h2>
          <p className="text-sm text-neutral-600 mt-1">
            This will run the solver to assign staff to shifts
          </p>
        </div>

        {/* Content */}
        <div className="p-6">
          {!result && !error && (
            <div className="space-y-4">
              <p className="text-sm text-neutral-700">
                The solver will:
              </p>
              <ul className="text-sm text-neutral-600 space-y-2 ml-4 list-disc">
                <li>Respect all blocking preferences (absolute + soft)</li>
                <li>Balance assignments within configured ranges</li>
                <li>Enforce part-time patterns</li>
                <li>Minimize window rule violations</li>
              </ul>
              <p className="text-xs text-neutral-500 pt-2">
                Solver runs for max 30 seconds. May return suboptimal solution if time limit reached.
              </p>
            </div>
          )}

          {loading && (
            <div className="space-y-4">
              <div className="flex justify-center">
                <div className="animate-spin">
                  <svg
                    className="w-8 h-8 text-blue-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="2"
                      opacity="0.1"
                    />
                    <path
                      d="M12 2a10 10 0 010 20"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </div>
              <p className="text-center text-sm text-neutral-600">
                Generating roster...
              </p>
              <p className="text-xs text-center text-neutral-500">
                This may take up to 30 seconds
              </p>
            </div>
          )}

          {result && !error && (
            <div className="space-y-4">
              {!result.fully_covered && (
                <div className="bg-amber-50 border border-amber-200 rounded p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    ⚠️ {result.unfilled_slots.length} shift{result.unfilled_slots.length === 1 ? '' : 's'} still
                    need{result.unfilled_slots.length === 1 ? 's' : ''} someone
                  </p>
                  <p className="text-xs text-amber-800 mt-1">
                    Not enough people were available within the configured limits. Fill the rest in
                    below on the period page.
                  </p>
                </div>
              )}

              <div className="bg-green-50 border border-green-200 rounded p-4">
                <h3 className="font-semibold text-green-900 mb-3">
                  {result.fully_covered ? '✓ Roster Generated' : 'Roster Generated (partial)'}
                </h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Assignments created:</dt>
                    <dd className="font-semibold text-neutral-900">{result.assignments_created}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Solver status:</dt>
                    <dd className="font-semibold text-neutral-900">{result.solver_status}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Total cost:</dt>
                    <dd className="font-semibold text-neutral-900">{result.cost.toFixed(2)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Time taken:</dt>
                    <dd className="font-semibold text-neutral-900">{result.time_seconds.toFixed(2)}s</dd>
                  </div>
                </dl>

                {Object.keys(result.violations).length > 0 && (
                  <div className="mt-4 pt-4 border-t border-green-200">
                    <p className="text-xs font-semibold text-green-900 mb-2">Violations:</p>
                    <div className="space-y-1">
                      {Object.entries(result.violations).map(([key, count]) => (
                        <div key={key} className="flex justify-between text-xs text-green-800">
                          <span>{key}:</span>
                          <span>{count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded p-4">
              <h3 className="font-semibold text-red-900 mb-2">✗ Error</h3>
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-6 flex gap-3">
          {!result && !error && (
            <>
              <button
                onClick={handleClose}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                {loading ? 'Generating...' : 'Generate'}
              </button>
            </>
          )}

          {result && !error && (
            <>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                {loading ? 'Regenerating...' : 'Regenerate'}
              </button>
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Close
              </button>
            </>
          )}

          {error && (
            <>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                Retry
              </button>
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

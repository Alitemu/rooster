'use client';

/**
 * Roster Generation Dialog
 *
 * Modal dialog for initiating solver run, showing progress,
 * and displaying results (assignments, cost, violations, time).
 */

import { useState, useEffect } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';

interface RulesetConfig {
  windowWeeks: number;
  bandAvond: [number, number];
  bandWeekend: [number, number];
  bandFeestdag: [number, number];
}

// Percent form for editing (matches SetupWizard's own Blokkadebudget step,
// and like it applies one percentage across all three tellers) - converted
// to/from the 0-1 maxFraction the ruleset JSON and blockBudget.ts actually
// store. Absent (no budget configured) reads back as 100% - "no limit".
interface BlockBudgetConfig {
  hardPercent: number;
  softPercent: number;
  parttimeExempt: boolean;
}

// Reads just the AVOND fraction back as a percentage - blockBudget.ts stores
// one maxFraction per teller, but the wizard only ever writes the same
// value to all three, so AVOND stands in for "the" configured percentage.
function percentFromBudget(budget: unknown): number {
  if (!budget || typeof budget !== 'object') return 100;
  const avond = (budget as Record<string, unknown>).AVOND as { maxFraction?: unknown } | undefined;
  return avond && typeof avond.maxFraction === 'number' ? Math.round(avond.maxFraction * 100) : 100;
}

function parttimeExemptFromBudget(budget: unknown): boolean {
  if (!budget || typeof budget !== 'object') return true;
  const value = (budget as Record<string, unknown>).parttimeExempt;
  return typeof value === 'boolean' ? value : true;
}

function budgetPayload(percent: number, parttimeExempt: boolean) {
  const maxFraction = Math.min(100, Math.max(0, percent)) / 100;
  return {
    AVOND: { maxFraction },
    WEEKEND: { maxFraction },
    FEESTDAG: { maxFraction },
    parttimeExempt,
  };
}

const COUNTER_LABEL: Record<'AVOND' | 'WEEKEND' | 'FEESTDAG', string> = {
  AVOND: 'Avond',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Feestdag',
};

// Mirrors solver/solver.py's status_map plus its 'ERROR' catch-all - see
// solver.py:227-236 and solver.py:313.
const SOLVER_STATUS_LABEL: Record<string, string> = {
  OPTIMAL: 'Optimaal',
  FEASIBLE: 'Haalbaar (niet per se optimaal)',
  INFEASIBLE: 'Onhaalbaar',
  MODEL_INVALID: 'Ongeldig model',
  UNKNOWN: 'Onbekend',
  ERROR: 'Fout tijdens genereren',
};

// Mirrors the fixed keys solver/constraints.py always initializes on
// `self.violations` - see constraints.py:86, 251, 282, 344.
const VIOLATION_LABEL: Record<string, string> = {
  window_rule: 'Vensterregel',
  blocking_absolute: 'Geblokkeerde dag toch toegewezen',
  capacity: 'Onvoldoende bezetting',
  band_limit: 'Buiten streefbereik',
};

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
  const [rulesetLoading, setRulesetLoading] = useState(false);
  const [ruleset, setRuleset] = useState<RulesetConfig | null>(null);
  const [blockBudgetConfig, setBlockBudgetConfig] = useState<BlockBudgetConfig | null>(null);
  const [rulesetError, setRulesetError] = useState<string | null>(null);
  const [rulesetRowVersion, setRulesetRowVersion] = useState<number | null>(null);
  // Not a hard rule - a planner can always generate early, e.g. once it's
  // clear stragglers won't respond in time. This just makes "generating
  // before everyone's had a chance to answer" a visible choice rather than
  // something that quietly happens by clicking the same button as always.
  const [notReadyWarning, setNotReadyWarning] = useState<string | null>(null);

  // Load the period's current frozen window/band every time the dialog
  // opens - it's otherwise invisible once a period leaves the setup
  // wizard, and a regenerate with nothing changed just reproduces the same
  // roster.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setRulesetLoading(true);
    setRulesetError(null);
    fetch(`/api/periods/${periodId}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const raw = data?.data?.bevroren_ruleset_json;
        const parsed = raw ? JSON.parse(raw) : {};
        setRuleset({
          windowWeeks: typeof parsed.windowWeeks === 'number' ? parsed.windowWeeks : 2,
          bandAvond: Array.isArray(parsed.bandAvond) ? parsed.bandAvond : [7, 8],
          bandWeekend: Array.isArray(parsed.bandWeekend) ? parsed.bandWeekend : [2, 3],
          bandFeestdag: Array.isArray(parsed.bandFeestdag) ? parsed.bandFeestdag : [1, 2],
        });
        setBlockBudgetConfig({
          hardPercent: percentFromBudget(parsed.blockBudget),
          softPercent: percentFromBudget(parsed.softBlockBudget),
          parttimeExempt: parttimeExemptFromBudget(parsed.blockBudget ?? parsed.softBlockBudget),
        });
        setRulesetRowVersion(
          typeof data?.data?.row_version === 'number' ? data.data.row_version : null
        );

        const deadline = data?.data?.deadline;
        if (!deadline || new Date(deadline) < new Date()) {
          setNotReadyWarning(null);
          return;
        }
        fetch(`/api/planner/period/${periodId}/dashboard`)
          .then((res) => res.json())
          .then((dashData) => {
            if (cancelled) return;
            const stats = dashData?.data?.submission_stats;
            if (!stats) return;
            const notDone = (stats.not_started || 0) + (stats.in_progress || 0);
            setNotReadyWarning(
              notDone > 0
                ? `${notDone} ${notDone === 1 ? 'personeelslid heeft zijn/haar voorkeuren' : 'personeelsleden hebben hun voorkeuren'} nog niet bevestigd, en de deadline is nog niet verstreken. Genereer je nu, dan tellen hun voorkeuren mogelijk niet (volledig) mee.`
                : null
            );
          })
          .catch(() => {
            if (!cancelled) setNotReadyWarning(null);
          });
      })
      .catch(() => {
        if (!cancelled) setRulesetError('Laden van huidige instellingen mislukt');
      })
      .finally(() => {
        if (!cancelled) setRulesetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, periodId]);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      if (ruleset) {
        const rulesetRes = await fetch(`/api/periods/${periodId}/ruleset`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...ruleset,
            ...(blockBudgetConfig
              ? {
                  blockBudget: budgetPayload(blockBudgetConfig.hardPercent, blockBudgetConfig.parttimeExempt),
                  softBlockBudget: budgetPayload(blockBudgetConfig.softPercent, blockBudgetConfig.parttimeExempt),
                }
              : {}),
            rowVersion: rulesetRowVersion ?? undefined,
          }),
        });
        const rulesetData = await rulesetRes.json();
        if (!rulesetRes.ok) {
          throw new Error(rulesetData.error?.message || 'Opslaan van venster/streefbereik mislukt');
        }
        if (typeof rulesetData?.data?.row_version === 'number') {
          setRulesetRowVersion(rulesetData.data.row_version);
        }
      }

      const res = await fetch(`/api/planner/period/${periodId}/generate-roster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Genereren van rooster mislukt');
      }

      const data = await res.json();
      setResult(data.data);

      if (onSuccess) {
        onSuccess();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Genereren van rooster mislukt');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setError(null);
    setNotReadyWarning(null);
    onClose();
  };

  useBodyScrollLock(isOpen);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rooster genereren"
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-full flex flex-col">
        {/* Header */}
        <div className="border-b p-6 flex-shrink-0">
          <h2 className="text-xl font-bold">Rooster genereren</h2>
          <p className="text-sm text-neutral-600 mt-1">
            Dit start de solver om personeel aan diensten toe te wijzen
          </p>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto min-h-0">
          {!result && !error && (
            <div className="space-y-4">
              {notReadyWarning && (
                <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
                  ⚠️ {notReadyWarning}
                </div>
              )}

              <div>
                <h3 className="text-sm font-semibold text-neutral-800 mb-1">Venster en streefbereik</h3>
                <p className="text-xs text-neutral-500 mb-3">
                  Dit zijn de huidige instellingen voor deze periode - onveranderd levert opnieuw
                  genereren hetzelfde resultaat op. Pas aan voor een ander resultaat.
                </p>

                {rulesetLoading && <p className="text-sm text-neutral-600">Instellingen laden...</p>}
                {rulesetError && <p className="text-sm text-red-600">{rulesetError}</p>}

                {ruleset && (
                  <div className="space-y-3 bg-neutral-50 border border-neutral-200 rounded p-3">
                    <div>
                      <label className="block text-xs font-medium text-neutral-600 mb-1">
                        Venster (weken tussen diensten)
                      </label>
                      <input
                        type="number"
                        min="0"
                        max="8"
                        value={ruleset.windowWeeks}
                        onChange={(e) =>
                          setRuleset({ ...ruleset, windowWeeks: parseInt(e.target.value) || 0 })
                        }
                        className="w-24 px-2 py-1 border rounded text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      {(['AVOND', 'WEEKEND', 'FEESTDAG'] as const).map((counter) => {
                        const key = `band${counter.charAt(0)}${counter.slice(1).toLowerCase()}` as
                          | 'bandAvond'
                          | 'bandWeekend'
                          | 'bandFeestdag';
                        const [min, max] = ruleset[key];
                        return (
                          <div key={counter}>
                            <label className="block text-xs font-medium text-neutral-600 mb-1">
                              {COUNTER_LABEL[counter]}
                            </label>
                            <div className="flex gap-1">
                              <input
                                type="number"
                                min="0"
                                value={min}
                                onChange={(e) =>
                                  setRuleset({
                                    ...ruleset,
                                    [key]: [parseInt(e.target.value) || 0, max],
                                  })
                                }
                                className="w-1/2 px-1.5 py-1 border rounded text-xs"
                                placeholder="Min"
                              />
                              <input
                                type="number"
                                min="0"
                                value={max}
                                onChange={(e) =>
                                  setRuleset({
                                    ...ruleset,
                                    [key]: [min, parseInt(e.target.value) || 0],
                                  })
                                }
                                className="w-1/2 px-1.5 py-1 border rounded text-xs"
                                placeholder="Max"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-sm font-semibold text-neutral-800 mb-1">Blokkadebudget</h3>
                <p className="text-xs text-neutral-500 mb-3">
                  Begrens hoeveel procent van de diensten één persoon mag blokkeren of als
                  &quot;liever niet&quot; mag opgeven. Op 100% zit er geen limiet op.
                </p>

                {blockBudgetConfig && (
                  <div className="space-y-3 bg-neutral-50 border border-neutral-200 rounded p-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-neutral-600 mb-1">
                          Geblokkeerd (max %)
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={blockBudgetConfig.hardPercent}
                          onChange={(e) => {
                            const parsed = parseInt(e.target.value);
                            if (Number.isNaN(parsed)) return;
                            setBlockBudgetConfig({
                              ...blockBudgetConfig,
                              hardPercent: Math.min(100, Math.max(0, parsed)),
                            });
                          }}
                          className="w-full px-2 py-1 border rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-neutral-600 mb-1">
                          Liever niet (max %)
                        </label>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={blockBudgetConfig.softPercent}
                          onChange={(e) => {
                            const parsed = parseInt(e.target.value);
                            if (Number.isNaN(parsed)) return;
                            setBlockBudgetConfig({
                              ...blockBudgetConfig,
                              softPercent: Math.min(100, Math.max(0, parsed)),
                            });
                          }}
                          className="w-full px-2 py-1 border rounded text-sm"
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-neutral-700">
                      <input
                        type="checkbox"
                        checked={blockBudgetConfig.parttimeExempt}
                        onChange={(e) =>
                          setBlockBudgetConfig({ ...blockBudgetConfig, parttimeExempt: e.target.checked })
                        }
                      />
                      Parttime-vrije dagen tellen niet mee voor het budget
                    </label>
                  </div>
                )}
              </div>

              <p className="text-sm text-neutral-700">
                De solver zal:
              </p>
              <ul className="text-sm text-neutral-600 space-y-2 ml-4 list-disc">
                <li>Alle blokkeervoorkeuren respecteren (blokkerend + liever niet)</li>
                <li>Toewijzingen verdelen binnen het ingestelde bereik</li>
                <li>Deeltijdpatronen afdwingen</li>
                <li>Overtredingen van de venster-regel minimaliseren</li>
              </ul>
              <p className="text-xs text-neutral-500 pt-2">
                De solver draait maximaal 30 seconden. Bij het bereiken van de tijdslimiet kan een
                suboptimale oplossing worden teruggegeven.
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
                Rooster genereren...
              </p>
              <p className="text-xs text-center text-neutral-500">
                Dit kan tot 30 seconden duren
              </p>
            </div>
          )}

          {result && !error && (
            <div className="space-y-4">
              {!result.fully_covered && (
                <div className="bg-amber-50 border border-amber-200 rounded p-4">
                  <p className="text-sm font-semibold text-amber-900">
                    ⚠️ {result.unfilled_slots.length} dienst{result.unfilled_slots.length === 1 ? '' : 'en'} nog
                    niet ingevuld
                  </p>
                  <p className="text-xs text-amber-800 mt-1">
                    Er waren niet genoeg mensen beschikbaar binnen de ingestelde grenzen. Vul de rest
                    hieronder handmatig in op de periodepagina.
                  </p>
                </div>
              )}

              <div className="bg-green-50 border border-green-200 rounded p-4">
                <h3 className="font-semibold text-green-900 mb-3">
                  {result.fully_covered ? '✓ Rooster gegenereerd' : 'Rooster gegenereerd (gedeeltelijk)'}
                </h3>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Toewijzingen aangemaakt:</dt>
                    <dd className="font-semibold text-neutral-900">{result.assignments_created}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Status solver:</dt>
                    <dd className="font-semibold text-neutral-900">
                      {SOLVER_STATUS_LABEL[result.solver_status] || result.solver_status}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Totale kosten:</dt>
                    <dd className="font-semibold text-neutral-900">{result.cost.toFixed(2)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-neutral-700">Duur:</dt>
                    <dd className="font-semibold text-neutral-900">{result.time_seconds.toFixed(2)}s</dd>
                  </div>
                </dl>

                {ruleset && (
                  <p className="text-xs text-green-800 mt-3 pt-3 border-t border-green-200">
                    Gegenereerd met venster {ruleset.windowWeeks} weken · avond {ruleset.bandAvond[0]}-
                    {ruleset.bandAvond[1]} · weekend {ruleset.bandWeekend[0]}-{ruleset.bandWeekend[1]} ·
                    feestdag {ruleset.bandFeestdag[0]}-{ruleset.bandFeestdag[1]}
                  </p>
                )}

                {Object.keys(result.violations).length > 0 && (
                  <div className="mt-4 pt-4 border-t border-green-200">
                    <p className="text-xs font-semibold text-green-900 mb-2">Overtredingen:</p>
                    <div className="space-y-1">
                      {Object.entries(result.violations).map(([key, count]) => (
                        <div key={key} className="flex justify-between text-xs text-green-800">
                          <span>{VIOLATION_LABEL[key] || key}:</span>
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
              <h3 className="font-semibold text-red-900 mb-2">✗ Fout</h3>
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-6 flex gap-3 flex-shrink-0">
          {!result && !error && (
            <>
              <button
                onClick={handleClose}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
              >
                Annuleren
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                {loading ? 'Bezig met genereren...' : 'Genereren'}
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
                {loading ? 'Opnieuw genereren...' : 'Opnieuw genereren'}
              </button>
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Sluiten
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
                Opnieuw proberen
              </button>
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Sluiten
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

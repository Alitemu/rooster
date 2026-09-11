'use client';

/**
 * Roster Generation Dialog
 *
 * Modal dialog for initiating solver run, showing progress,
 * and displaying results (assignments, cost, violations, time).
 */

import { useState, useEffect, useRef } from 'react';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';

// Native fetch() throws a plain TypeError with a browser-specific, English,
// technical message ("Failed to fetch", "NetworkError when attempting to
// fetch resource.", "Load failed" on Safari) when a request never got a
// response at all - never show that raw string to a planner, per
// CLAUDE.md's Dutch-only UI text rule.
function toDutchErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof TypeError) {
    return 'Geen verbinding met de server. Controleer je internetverbinding en probeer het opnieuw.';
  }
  return err instanceof Error ? err.message : fallback;
}

const POLL_INTERVAL_MS = 2000;
// A dropped poll just means "ask again in a moment" - the generation itself
// keeps running server-side regardless (see lib/rosterGenerationJobs.ts).
// Only give up after several consecutive failures, so a brief mobile
// network hiccup (screen lock, wifi/cellular handoff) doesn't surface as a
// false failure the way the old single long-lived request did.
const MAX_CONSECUTIVE_POLL_FAILURES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RulesetConfig {
  windowWeeks: number;
  bandAvond: [number, number];
  bandWeekend: [number, number];
  bandFeestdag: [number, number];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconden`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? 'minuut' : 'minuten'}`;
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
  // The last value actually confirmed to be on the server - either just
  // loaded, or just PATCHed. Compared against `ruleset` in handleGenerate
  // so a plain "opnieuw genereren"/"langer proberen" click (nothing
  // edited) can skip the PATCH entirely: that PATCH unconditionally
  // demotes a GEGENEREERD period back to OPEN (see ruleset/route.ts) even
  // when nothing actually changed, which briefly hides the very
  // assignments/gap-filling UI this dialog's result is about to report on
  // if the generate call after it fails for any reason.
  const [originalRuleset, setOriginalRuleset] = useState<RulesetConfig | null>(null);
  const [rulesetError, setRulesetError] = useState<string | null>(null);
  const [rulesetRowVersion, setRulesetRowVersion] = useState<number | null>(null);
  // Not a hard rule - a planner can always generate early, e.g. once it's
  // clear stragglers won't respond in time. This just makes "generating
  // before everyone's had a chance to answer" a visible choice rather than
  // something that quietly happens by clicking the same button as always.
  const [notReadyWarning, setNotReadyWarning] = useState<string | null>(null);
  // null = the solver's own default (120s) was used. Tracks the limit of
  // the most recently *completed* attempt, so the "langer proberen" option
  // below can offer the next step up (120s -> 300s -> 600s) rather than
  // repeating one already tried. Separate from the in-flight limit so the
  // loading message can name it before the result comes back.
  const [lastTimeLimitSeconds, setLastTimeLimitSeconds] = useState<number | null>(null);
  const [pendingTimeLimitSeconds, setPendingTimeLimitSeconds] = useState<number | null>(null);
  // True while polling is retrying after a network-level failure (not an
  // application error) - shown so a planner sees *why* the wait continues
  // instead of the dialog looking frozen during a brief connection hiccup.
  const [reconnecting, setReconnecting] = useState(false);
  // Stops an in-flight poll loop from touching state after the dialog is
  // closed or a fresh handleGenerate() call starts a new one.
  const pollCancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      pollCancelledRef.current = true;
    };
  }, []);

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
        const loaded: RulesetConfig = {
          windowWeeks: typeof parsed.windowWeeks === 'number' ? parsed.windowWeeks : 2,
          bandAvond: Array.isArray(parsed.bandAvond) ? parsed.bandAvond : [7, 8],
          bandWeekend: Array.isArray(parsed.bandWeekend) ? parsed.bandWeekend : [2, 3],
          bandFeestdag: Array.isArray(parsed.bandFeestdag) ? parsed.bandFeestdag : [1, 2],
        };
        setRuleset(loaded);
        setOriginalRuleset(loaded);
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

  // Polls .../generate-roster/status until the background job (started by
  // handleGenerate below) finishes - see lib/rosterGenerationJobs.ts for
  // why generation itself doesn't run inside one long request anymore. A
  // poll that fails at the network level (not a real 4xx/5xx from the
  // server) is retried rather than treated as the generation having
  // failed: the job keeps running server-side either way, so losing one
  // poll is harmless as long as a later one gets through.
  const pollJobStatus = async (jobId: string, timeLimitSeconds?: number) => {
    let consecutiveFailures = 0;

    while (!pollCancelledRef.current) {
      await sleep(POLL_INTERVAL_MS);
      if (pollCancelledRef.current) return;

      let res: Response;
      try {
        res = await fetch(
          `/api/planner/period/${periodId}/generate-roster/status?job_id=${encodeURIComponent(jobId)}`
        );
      } catch (err) {
        consecutiveFailures++;
        setReconnecting(true);
        if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          if (!pollCancelledRef.current) {
            setError(toDutchErrorMessage(err, 'Status ophalen mislukt'));
            setLoading(false);
            setReconnecting(false);
          }
          return;
        }
        continue;
      }

      if (pollCancelledRef.current) return;
      consecutiveFailures = 0;
      setReconnecting(false);

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        setError(
          (typeof data?.error === 'string' ? data.error : data?.error?.message) ||
            'Genereren van rooster mislukt'
        );
        setLoading(false);
        return;
      }

      const job = data.data;
      if (job.status === 'RUNNING') continue;

      if (job.status === 'DONE') {
        setResult(job.result);
        setLastTimeLimitSeconds(timeLimitSeconds ?? null);
        // generate-roster bumps row_version once more on top of any PATCH
        // in handleGenerate below (it moves the period to/through
        // GEGENEREERD) - without this, the *next* PATCH or generate call in
        // this same dialog session (a second "opnieuw genereren", or
        // "langer proberen") would submit a version that's already one
        // behind and get rejected as a conflict that was actually just
        // this same request.
        if (typeof job.result?.row_version === 'number') {
          setRulesetRowVersion(job.result.row_version);
        }
        setLoading(false);
        if (onSuccess) onSuccess();
        return;
      }

      // job.status === 'ERROR'
      setError(job.error?.message || 'Genereren van rooster mislukt');
      setLoading(false);
      return;
    }
  };

  const handleGenerate = async (timeLimitSeconds?: number) => {
    pollCancelledRef.current = false;
    setLoading(true);
    setError(null);
    setResult(null);
    setReconnecting(false);
    setPendingTimeLimitSeconds(timeLimitSeconds ?? null);

    try {
      // Only send the PATCH when the fields actually differ from what's
      // already on the server - see originalRuleset's comment. This is
      // what makes "opnieuw genereren" and "langer proberen" (which call
      // this with the same `ruleset` every time, since the fields are
      // hidden once a result exists) not demote-then-repromote the period
      // on every single click.
      if (ruleset && JSON.stringify(ruleset) !== JSON.stringify(originalRuleset)) {
        const rulesetRes = await fetch(`/api/periods/${periodId}/ruleset`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...ruleset,
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
        setOriginalRuleset(ruleset);
      }

      // Fast call: just registers the job and returns its id - the actual
      // solve happens server-side afterwards (see generate-roster/route.ts
      // and lib/rosterGenerationJobs.ts). pollJobStatus below finds out how
      // it went via short, resilient polls instead of one long request.
      const res = await fetch(`/api/planner/period/${periodId}/generate-roster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          timeLimitSeconds !== undefined ? { time_limit_seconds: timeLimitSeconds } : {}
        ),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Genereren van rooster mislukt');
      }

      const data = await res.json();
      const jobId = data?.data?.job_id;
      if (typeof jobId !== 'string') {
        throw new Error('Genereren van rooster mislukt');
      }

      await pollJobStatus(jobId, timeLimitSeconds);
    } catch (err) {
      if (!pollCancelledRef.current) {
        setError(toDutchErrorMessage(err, 'Genereren van rooster mislukt'));
        setLoading(false);
      }
    }
  };

  const handleClose = () => {
    pollCancelledRef.current = true;
    setResult(null);
    setError(null);
    setNotReadyWarning(null);
    setLastTimeLimitSeconds(null);
    setPendingTimeLimitSeconds(null);
    setReconnecting(false);
    onClose();
  };

  useBodyScrollLock(isOpen);
  // Same condition as the Annuleren button below (disabled={loading}) -
  // Escape/backdrop-click must not be able to dismiss the dialog mid-solve
  // and leave the generate call's result with nowhere to land.
  const dismissBackdrop = useDialogDismiss(isOpen, handleClose, !loading);

  // The step-up offered after a FEASIBLE result: 120s (the default, tracked
  // as null) -> 300s -> 600s -> no further offer. Matches the two extra
  // steps the planner asked for (5, then 10 minutes) rather than an
  // open-ended doubling that would eventually make "langer proberen" itself
  // an unbounded wait.
  const nextTimeLimitSeconds =
    lastTimeLimitSeconds === null ? 300 : lastTimeLimitSeconds === 300 ? 600 : null;

  // Catches the mistake client-side before a round trip - the server
  // rejects the same thing (ruleset/route.ts's isValidBand), but with the
  // fields sitting right there it's better to point at exactly which one
  // is wrong than to send it off and get a generic error back.
  const bandInvalid =
    !!ruleset &&
    (ruleset.bandAvond[0] > ruleset.bandAvond[1] ||
      ruleset.bandWeekend[0] > ruleset.bandWeekend[1] ||
      ruleset.bandFeestdag[0] > ruleset.bandFeestdag[1]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Rooster genereren"
      onClick={dismissBackdrop}
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
                    {bandInvalid && (
                      <p className="text-xs text-red-600">
                        Min mag niet groter zijn dan max - controleer de streefbereiken hierboven.
                      </p>
                    )}
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
                De solver draait maximaal 2 minuten. Bij het bereiken van de tijdslimiet kan een
                suboptimale oplossing worden teruggegeven - je kunt daarna alsnog langer laten
                doorzoeken.
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
              {reconnecting ? (
                <p className="text-xs text-center text-amber-700">
                  Verbinding onderbroken, opnieuw verbinden... Het genereren loopt gewoon door.
                </p>
              ) : (
                <p className="text-xs text-center text-neutral-500">
                  Dit kan tot {formatDuration(pendingTimeLimitSeconds ?? 120)} duren - je kunt dit
                  scherm open laten staan of later terugkomen.
                </p>
              )}
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

              {result.solver_status === 'FEASIBLE' && nextTimeLimitSeconds !== null && (
                <div className="bg-blue-50 border border-blue-200 rounded p-4">
                  <p className="text-sm text-blue-900">
                    De solver had nog niet bewezen dat dit de best mogelijke oplossing is toen de
                    tijd om was. Langer laten zoeken kan een beter (eerlijker of vollediger) rooster
                    opleveren, maar is geen garantie.
                  </p>
                  <button
                    onClick={() => handleGenerate(nextTimeLimitSeconds)}
                    disabled={loading}
                    className="mt-3 w-full px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
                  >
                    {formatDuration(nextTimeLimitSeconds)} langer proberen
                  </button>
                </div>
              )}
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
                onClick={() => handleGenerate()}
                disabled={loading || bandInvalid}
                title={bandInvalid ? 'Los eerst de ongeldige streefbereiken hierboven op' : undefined}
                className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                {loading ? 'Bezig met genereren...' : 'Genereren'}
              </button>
            </>
          )}

          {result && !error && (
            <>
              <button
                onClick={() => handleGenerate()}
                disabled={loading || bandInvalid}
                title={bandInvalid ? 'Los eerst de ongeldige streefbereiken hierboven op' : undefined}
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
                onClick={() => handleGenerate()}
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

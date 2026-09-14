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
  // "Geavanceerde instellingen" - the solver's objective weights. Mirrors
  // solver/main.py's RuleSet defaults exactly (see the DEFAULT_* constants
  // below), so a period whose ruleset never set these behaves identically
  // to before this panel existed.
  softBlockPenalty: number;
  bandDeviationPenalty: number[];
  bandDeviationMultiplier: number;
  shortfallWeight: number;
  bandImbalanceWeight: number;
  preferenceRewardWeight: number;
  // Which of the four roster-generation approaches to use. 'lexicographic'
  // ("Prioriteitenplanner") solves dekking > eerlijkheid > liever-niet >
  // voorkeur in strict priority order and ignores every weight field above;
  // 'weighted' ("Puntenplanner") is the older single-weighted-sum model
  // those fields tune; 'multi_start' ("Herhaalplanner") repeats a
  // 'lexicographic' solve up to maxAttempts times with a different random
  // seed each time and keeps the best; 'randomized' ("Gerandomiseerde
  // planner") repeats a non-CP-SAT greedy construction instead (see
  // solver/greedy.py and randomizedVariant below), same "keep the best"
  // idea. See solver/solver.py's module docstring for the
  // weighted/lexicographic comparison.
  objectiveMode: 'weighted' | 'lexicographic' | 'multi_start' | 'randomized';
  // Only meaningful when objectiveMode is 'multi_start' or 'randomized'.
  maxAttempts: number;
  // Only meaningful when objectiveMode is 'randomized' - see
  // solver/greedy.py's module docstring for what each variant does.
  randomizedVariant: 'medewerker' | 'dagen';
}

// Matches solver/main.py's RuleSet field defaults - the "Standaardinstellingen
// herstellen" button in the advanced panel resets to exactly these.
const DEFAULT_SOFT_BLOCK_PENALTY = 1.0;
const DEFAULT_BAND_DEVIATION_PENALTY = [5.0];
const DEFAULT_BAND_DEVIATION_MULTIPLIER = 1.0;
const DEFAULT_SHORTFALL_WEIGHT = 1000.0;
const DEFAULT_BAND_IMBALANCE_WEIGHT = 0.5;
const DEFAULT_PREFERENCE_REWARD_WEIGHT = 0.3;

// Matches solver/main.py's RuleSet.objective_mode backward-compat default -
// a period whose frozen ruleset predates this field is treated as
// 'weighted', exactly as the solver itself treats it. New periods get
// 'lexicographic' instead, set by SetupWizard when the period is opened.
const DEFAULT_OBJECTIVE_MODE: 'weighted' | 'lexicographic' | 'multi_start' | 'randomized' = 'weighted';

// maxAttempts has no Python-side counterpart - it's purely a Next.js
// concept, see generate-roster/route.ts's runMultiStart. 100 is the
// default the planner asked for.
const DEFAULT_MAX_ATTEMPTS = 100;

// Matches solver/greedy.py's own RuleSet-equivalent variant default.
const DEFAULT_RANDOMIZED_VARIANT: 'medewerker' | 'dagen' = 'medewerker';

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
// solver.py:227-236 and solver.py:313. 'GREEDY' is solver/greedy.py's own
// fixed status (Gerandomiseerde planner) - always this value regardless of
// coverage, since that algorithm has no OPTIMAL/FEASIBLE/INFEASIBLE
// concept of its own; fully_covered/unfilled_slots already say how
// complete the result is.
const SOLVER_STATUS_LABEL: Record<string, string> = {
  OPTIMAL: 'Optimaal',
  FEASIBLE: 'Haalbaar (niet per se optimaal)',
  INFEASIBLE: 'Onhaalbaar',
  MODEL_INVALID: 'Ongeldig model',
  UNKNOWN: 'Onbekend',
  ERROR: 'Fout tijdens genereren',
  GREEDY: 'Gerandomiseerd opgebouwd',
};

// Mirrors the fixed keys solver/constraints.py always initializes on
// `self.violations` - see constraints.py:86, 251, 282, 344.
const VIOLATION_LABEL: Record<string, string> = {
  window_rule: 'Vensterregel',
  blocking_absolute: 'Geblokkeerde dag toch toegewezen',
  capacity: 'Onvoldoende bezetting',
  band_limit: 'Buiten streefbereik',
};

// Mirrors lib/rosterGenerationJobs.ts's RosterGenerationJobProgress -
// duplicated locally like RulesetConfig above rather than imported, since
// that module also pulls in Node-only globals (crypto.randomUUID) that
// have no place in a client bundle.
interface RosterGenerationJobProgress {
  attempt: number;
  maxAttempts: number;
  bestSoFar: { unfilled_slots: number; max_band_deviation: number } | null;
}

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
  // Only present for a "Herhaalplanner" (multi_start) run - see
  // lib/rosterGenerationJobs.ts's RosterGenerationJobResult.
  attempts_tried?: number;
  stopped_reason?: 'max_attempts' | 'perfect' | 'cancelled';
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
  // "Geavanceerde instellingen" collapsed by default - most planners never
  // need to touch these, so they stay out of the way of the ordinary
  // venster/streefbereik flow above.
  const [showAdvanced, setShowAdvanced] = useState(false);
  // bandDeviationPenalty is a comma-separated list, edited as free text so
  // a planner can type "5, 20, " mid-edit without every keystroke needing
  // to already parse into a valid, non-empty number array - the same
  // reasoning as bandInvalid below, just for a field that can't be a
  // plain <input type="number">.
  const [bandDeviationPenaltyText, setBandDeviationPenaltyText] = useState(
    DEFAULT_BAND_DEVIATION_PENALTY.join(', ')
  );
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
  // Only ever populated while a "Herhaalplanner" (multi_start) job is
  // RUNNING - see pollJobStatus. null both before the first poll response
  // and for an ordinary single-solve job, which never has progress to show.
  const [progress, setProgress] = useState<RosterGenerationJobProgress | null>(null);
  // The job id handleGenerate just started, so handleCancelGeneration knows
  // what to cancel - a plain local variable inside handleGenerate wouldn't
  // survive to a later click on the Stoppen button.
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
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
          softBlockPenalty:
            typeof parsed.softBlockPenalty === 'number' ? parsed.softBlockPenalty : DEFAULT_SOFT_BLOCK_PENALTY,
          bandDeviationPenalty: Array.isArray(parsed.bandDeviationPenalty)
            ? parsed.bandDeviationPenalty
            : DEFAULT_BAND_DEVIATION_PENALTY,
          bandDeviationMultiplier:
            typeof parsed.bandDeviationMultiplier === 'number'
              ? parsed.bandDeviationMultiplier
              : DEFAULT_BAND_DEVIATION_MULTIPLIER,
          shortfallWeight:
            typeof parsed.shortfallWeight === 'number' ? parsed.shortfallWeight : DEFAULT_SHORTFALL_WEIGHT,
          bandImbalanceWeight:
            typeof parsed.bandImbalanceWeight === 'number' ? parsed.bandImbalanceWeight : DEFAULT_BAND_IMBALANCE_WEIGHT,
          preferenceRewardWeight:
            typeof parsed.preferenceRewardWeight === 'number'
              ? parsed.preferenceRewardWeight
              : DEFAULT_PREFERENCE_REWARD_WEIGHT,
          objectiveMode:
            parsed.objectiveMode === 'weighted' ||
            parsed.objectiveMode === 'lexicographic' ||
            parsed.objectiveMode === 'multi_start' ||
            parsed.objectiveMode === 'randomized'
              ? parsed.objectiveMode
              : DEFAULT_OBJECTIVE_MODE,
          maxAttempts:
            typeof parsed.maxAttempts === 'number' && Number.isInteger(parsed.maxAttempts) && parsed.maxAttempts >= 1
              ? parsed.maxAttempts
              : DEFAULT_MAX_ATTEMPTS,
          randomizedVariant:
            parsed.randomizedVariant === 'medewerker' || parsed.randomizedVariant === 'dagen'
              ? parsed.randomizedVariant
              : DEFAULT_RANDOMIZED_VARIANT,
        };
        setRuleset(loaded);
        setOriginalRuleset(loaded);
        setBandDeviationPenaltyText(loaded.bandDeviationPenalty.join(', '));
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
      if (job.status === 'RUNNING') {
        setProgress(job.progress ?? null);
        continue;
      }

      setProgress(null);

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
    setProgress(null);
    setCurrentJobId(null);
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

      setCurrentJobId(jobId);
      await pollJobStatus(jobId, timeLimitSeconds);
    } catch (err) {
      if (!pollCancelledRef.current) {
        setError(toDutchErrorMessage(err, 'Genereren van rooster mislukt'));
        setLoading(false);
      }
    }
  };

  // Only offered while a "Herhaalplanner" run is RUNNING (see the
  // Stoppen-button JSX below) - stops the loop after whichever attempt is
  // currently in flight and applies the best one found so far, exactly
  // like reaching maxAttempts or finding a perfect roster would. The
  // already-running pollJobStatus loop picks up the resulting DONE/ERROR
  // status on its own; this call only has to ask the server to stop.
  const handleCancelGeneration = async () => {
    if (!currentJobId || cancelling) return;
    setCancelling(true);
    try {
      await fetch(`/api/planner/period/${periodId}/generate-roster/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: currentJobId }),
      });
    } catch {
      // A dropped cancel request just means "try again" - the run keeps
      // going server-side either way, same as a dropped status poll.
    } finally {
      setCancelling(false);
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
    setProgress(null);
    setCurrentJobId(null);
    setCancelling(false);
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

  // Same reasoning as bandInvalid above, for the one advanced field that
  // isn't a plain number input - parsed the same permissive way the
  // onChange handler below does, so this always reflects exactly what
  // would be sent.
  const parsedBandDeviationPenalty = bandDeviationPenaltyText
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const tiersInvalid = parsedBandDeviationPenalty.length === 0;
  const formInvalid = bandInvalid || tiersInvalid;

  const handleBandDeviationPenaltyChange = (text: string) => {
    setBandDeviationPenaltyText(text);
    const parsed = text
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    // Only commit a non-empty parse into `ruleset` - an in-progress edit
    // (a trailing comma, a half-typed number) keeps the last valid value
    // there so handleGenerate always has something sendable, while
    // tiersInvalid above still flags the *displayed* text as incomplete.
    if (parsed.length > 0 && ruleset) {
      setRuleset({ ...ruleset, bandDeviationPenalty: parsed });
    }
  };

  const handleResetAdvancedDefaults = () => {
    if (!ruleset) return;
    setRuleset({
      ...ruleset,
      softBlockPenalty: DEFAULT_SOFT_BLOCK_PENALTY,
      bandDeviationPenalty: DEFAULT_BAND_DEVIATION_PENALTY,
      bandDeviationMultiplier: DEFAULT_BAND_DEVIATION_MULTIPLIER,
      shortfallWeight: DEFAULT_SHORTFALL_WEIGHT,
      bandImbalanceWeight: DEFAULT_BAND_IMBALANCE_WEIGHT,
      preferenceRewardWeight: DEFAULT_PREFERENCE_REWARD_WEIGHT,
    });
    setBandDeviationPenaltyText(DEFAULT_BAND_DEVIATION_PENALTY.join(', '));
  };

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

              <div>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="text-sm font-semibold text-neutral-800">Geavanceerde instellingen</h3>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  >
                    {showAdvanced ? 'Verbergen' : 'Tonen'}
                  </button>
                </div>

                {showAdvanced && ruleset && (
                  <div className="space-y-4 bg-neutral-50 border border-neutral-200 rounded p-3">
                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-1">
                        Optimalisatiemethode
                      </label>
                      <div className="space-y-2">
                        {(['lexicographic', 'multi_start', 'randomized', 'weighted'] as const).map((mode) => (
                          <label key={mode} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="radio"
                              name="objective_mode"
                              value={mode}
                              checked={ruleset.objectiveMode === mode}
                              onChange={() => setRuleset({ ...ruleset, objectiveMode: mode })}
                              className="rounded-full"
                            />
                            <span className="text-sm">
                              {mode === 'lexicographic' && 'Prioriteitenplanner (standaard)'}
                              {mode === 'multi_start' && 'Herhaalplanner'}
                              {mode === 'randomized' && 'Gerandomiseerde planner'}
                              {mode === 'weighted' && 'Puntenplanner'}
                            </span>
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-neutral-500 mt-1">
                        {ruleset.objectiveMode === 'lexicographic' &&
                          'Lost eerst dekking zo goed mogelijk op, dan pas een eerlijke verdeling, dan liever-niet-voorkeuren, en als laatste voorkeuren - elke stap staat vast voordat de volgende meetelt, zodat een lagere prioriteit een hogere nooit kan verdringen. De punten hieronder gelden niet voor deze methode.'}
                        {ruleset.objectiveMode === 'multi_start' &&
                          'Draait de Prioriteitenplanner meerdere keren met een andere toevalsvolgorde en bewaart steeds het beste rooster tot nu toe - stopt vanzelf zodra een perfect rooster is gevonden (alles ingevuld, iedereen exact binnen bereik) of het aantal pogingen hieronder is bereikt. Kan langer duren dan de andere methodes; je kunt tussentijds stoppen. De punten hieronder gelden niet voor deze methode.'}
                        {ruleset.objectiveMode === 'randomized' &&
                          'Vult diensten stap voor stap in met een steeds willekeurig geschud personeelslijstje in plaats van met de solver hierboven - geen teruggrabbelen als een keuze verderop tot een probleem leidt. Draait meerdere pogingen en bewaart steeds het beste rooster tot nu toe, net als de Herhaalplanner. Kan een minder eerlijke verdeling opleveren dan de Prioriteitenplanner. De punten hieronder gelden niet voor deze methode.'}
                        {ruleset.objectiveMode === 'weighted' &&
                          'Eén gecombineerde score van alle punten hieronder samen - de solver kiest wat die score het laagst maakt. Kan bij veel personeel of diensten een minder eerlijke verdeling opleveren dan de Prioriteitenplanner, omdat de punten onderling tegen elkaar kunnen opwegen.'}
                      </p>
                    </div>

                    {ruleset.objectiveMode === 'randomized' && (
                      <div>
                        <label className="block text-xs font-medium text-neutral-700 mb-1">
                          Volgorde
                        </label>
                        <div className="space-y-2">
                          {(['medewerker', 'dagen'] as const).map((variant) => (
                            <label key={variant} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name="randomized_variant"
                                value={variant}
                                checked={ruleset.randomizedVariant === variant}
                                onChange={() => setRuleset({ ...ruleset, randomizedVariant: variant })}
                                className="rounded-full"
                              />
                              <span className="text-sm">
                                {variant === 'medewerker' && 'Medewerker gerandomiseerd'}
                                {variant === 'dagen' && 'Dagen gerandomiseerd'}
                              </span>
                            </label>
                          ))}
                        </div>
                        <p className="text-xs text-neutral-500 mt-1">
                          {ruleset.randomizedVariant === 'medewerker'
                            ? 'Dagen worden op volgorde afgewerkt; per dienst wordt het personeelslijstje opnieuw geschud.'
                            : 'Ook de volgorde van de dagen zelf wordt geschud, niet alleen het personeelslijstje per dienst.'}
                        </p>
                      </div>
                    )}

                    {(ruleset.objectiveMode === 'multi_start' || ruleset.objectiveMode === 'randomized') && (
                      <div>
                        <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                          Aantal pogingen
                        </label>
                        <p className="text-xs text-neutral-500 mb-1">
                          Hoe vaak het rooster opnieuw geprobeerd wordt voor gestopt wordt en het
                          beste tot dan toe gevonden rooster gebruikt (of eerder, als een perfect
                          rooster wordt gevonden).
                        </p>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={ruleset.maxAttempts}
                          onChange={(e) =>
                            setRuleset({
                              ...ruleset,
                              maxAttempts: Math.max(1, parseInt(e.target.value) || 1),
                            })
                          }
                          className="w-28 px-2 py-1 border rounded text-sm"
                        />
                      </div>
                    )}

                    {ruleset.objectiveMode === 'weighted' && (
                      <>
                    <p className="text-xs text-neutral-500">
                      Dit zijn de punten waarmee de solver bepaalt hoe hij diensten verdeelt: hoe
                      hoger het getal, hoe zwaarder die actie meetelt. De standaardinstellingen
                      werken voor vrijwel elke periode goed - pas dit alleen aan als je weet wat je
                      doet.
                    </p>

                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                        Lege dienst
                      </label>
                      <p className="text-xs text-neutral-500 mb-1">
                        Straf voor een dienst waar helemaal niemand aan wordt toegewezen. Dit is
                        verreweg de zwaarste straf, zodat de solver bijna altijd liever iemand
                        toewijst dan een dienst leeg te laten.
                      </p>
                      <input
                        type="number"
                        min="0.01"
                        step="1"
                        value={ruleset.shortfallWeight}
                        onChange={(e) =>
                          setRuleset({ ...ruleset, shortfallWeight: parseFloat(e.target.value) || 0 })
                        }
                        className="w-28 px-2 py-1 border rounded text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                        Buiten streefbereik (oplopende straf)
                      </label>
                      <p className="text-xs text-neutral-500 mb-1">
                        Straf per dienst die iemand onder hun streefaantal blijft: de eerste,
                        komma-gescheiden waarde geldt voor de eerste dienst eronder, de tweede voor
                        de tweede, enzovoort - zo wordt een tekort liever over meerdere mensen
                        gespreid dan bij één persoon neergelegd. Komt iemand juist boven hun
                        streefaantal, dan telt bovenop deze waarde ook altijd de volledige straf
                        voor "Lege dienst" mee - zo blijft een dienst leeglaten altijd goedkoper dan
                        iemand over hun streefbereik heen duwen.
                      </p>
                      <input
                        type="text"
                        value={bandDeviationPenaltyText}
                        onChange={(e) => handleBandDeviationPenaltyChange(e.target.value)}
                        placeholder="bijv. 5, 20, 80"
                        className="w-full px-2 py-1 border rounded text-sm"
                      />
                      {tiersInvalid && (
                        <p className="text-xs text-red-600 mt-1">
                          Vul minstens één getal groter dan 0 in, gescheiden door komma&apos;s.
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                        Vermenigvuldigingsfactor extra tredes
                      </label>
                      <p className="text-xs text-neutral-500 mb-1">
                        Hoeveel duurder elke volgende dienst wordt zodra de hierboven ingevulde
                        trappen op zijn (bijvoorbeeld 4 = elke stap daarna 4x zo duur als de vorige).
                      </p>
                      <input
                        type="number"
                        min="1"
                        step="0.1"
                        value={ruleset.bandDeviationMultiplier}
                        onChange={(e) =>
                          setRuleset({ ...ruleset, bandDeviationMultiplier: parseFloat(e.target.value) || 1 })
                        }
                        className="w-28 px-2 py-1 border rounded text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                        Liever-niet-voorkeur genegeerd
                      </label>
                      <p className="text-xs text-neutral-500 mb-1">
                        Straf wanneer iemand toch wordt ingedeeld op een dag die diegene als
                        &quot;liever niet&quot; heeft gemarkeerd.
                      </p>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={ruleset.softBlockPenalty}
                        onChange={(e) =>
                          setRuleset({ ...ruleset, softBlockPenalty: parseFloat(e.target.value) || 0 })
                        }
                        className="w-28 px-2 py-1 border rounded text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                        Ongelijke verdeling
                      </label>
                      <p className="text-xs text-neutral-500 mb-1">
                        Hoe sterk de solver naar een gelijke verdeling rond het midden van het
                        streefbereik trekt, voor mensen die toch al binnen hun bereik vallen.
                      </p>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={ruleset.bandImbalanceWeight}
                        onChange={(e) =>
                          setRuleset({ ...ruleset, bandImbalanceWeight: parseFloat(e.target.value) || 0 })
                        }
                        className="w-28 px-2 py-1 border rounded text-sm"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-neutral-700 mb-0.5">
                        Voorkeur gehonoreerd
                      </label>
                      <p className="text-xs text-neutral-500 mb-1">
                        Beloning wanneer iemand wordt ingedeeld op een dag die diegene als
                        &quot;voorkeur&quot; heeft gemarkeerd.
                      </p>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={ruleset.preferenceRewardWeight}
                        onChange={(e) =>
                          setRuleset({ ...ruleset, preferenceRewardWeight: parseFloat(e.target.value) || 0 })
                        }
                        className="w-28 px-2 py-1 border rounded text-sm"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleResetAdvancedDefaults}
                      className="text-xs font-medium text-neutral-600 hover:text-neutral-900 underline"
                    >
                      Standaardinstellingen herstellen
                    </button>
                      </>
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
              {progress && (
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-neutral-600">
                    <span>
                      Poging {progress.attempt} van {progress.maxAttempts}
                    </span>
                    {progress.bestSoFar && (
                      <span>
                        Beste tot nu toe: {progress.bestSoFar.unfilled_slots}{' '}
                        {progress.bestSoFar.unfilled_slots === 1 ? 'lege dienst' : 'lege diensten'},{' '}
                        {progress.bestSoFar.max_band_deviation === 0
                          ? 'iedereen binnen bereik'
                          : `grootste afwijking ${progress.bestSoFar.max_band_deviation}`}
                      </span>
                    )}
                  </div>
                  <div className="w-full bg-neutral-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${Math.min(100, (progress.attempt / progress.maxAttempts) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              {reconnecting ? (
                <p className="text-xs text-center text-amber-700">
                  Verbinding onderbroken, opnieuw verbinden... Het genereren loopt gewoon door.
                </p>
              ) : progress ? (
                <p className="text-xs text-center text-neutral-500">
                  Je kunt dit scherm open laten staan of later terugkomen, of tussentijds stoppen
                  hieronder.
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

                {result.attempts_tried !== undefined && (
                  <p className="text-xs text-green-800 mt-2 pt-2 border-t border-green-200">
                    {ruleset?.objectiveMode === 'randomized' ? 'Gerandomiseerde planner' : 'Herhaalplanner'}:{' '}
                    {result.attempts_tried} poging{result.attempts_tried === 1 ? '' : 'en'} geprobeerd ·{' '}
                    {result.stopped_reason === 'perfect' &&
                      'gestopt: perfect rooster gevonden (alles ingevuld, iedereen binnen bereik)'}
                    {result.stopped_reason === 'cancelled' && 'gestopt: handmatig gestopt'}
                    {result.stopped_reason === 'max_attempts' && 'gestopt: aantal pogingen bereikt'}
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

              {result.solver_status === 'FEASIBLE' &&
                nextTimeLimitSeconds !== null &&
                result.attempts_tried === undefined && (
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
              {loading && progress ? (
                <button
                  onClick={handleCancelGeneration}
                  disabled={cancelling}
                  className="flex-1 px-4 py-2 rounded font-medium bg-red-100 text-red-800 hover:bg-red-200 disabled:bg-red-50 disabled:text-red-400 transition-colors"
                >
                  {cancelling ? 'Bezig met stoppen...' : 'Stoppen (beste tot nu toe gebruiken)'}
                </button>
              ) : (
                <button
                  onClick={handleClose}
                  disabled={loading}
                  className="flex-1 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
                >
                  Annuleren
                </button>
              )}
              <button
                onClick={() => handleGenerate()}
                disabled={loading || formInvalid}
                title={formInvalid ? 'Los eerst de ongeldige instellingen hierboven op' : undefined}
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
                disabled={loading || formInvalid}
                title={formInvalid ? 'Los eerst de ongeldige instellingen hierboven op' : undefined}
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

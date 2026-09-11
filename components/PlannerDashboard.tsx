'use client';

/**
 * Planner Dashboard Component
 *
 * Shows:
 * - Submission progress per staff member
 * - Live week coverage
 * - Large imbalances
 * - Part-time patterns status
 * - Submit on behalf button
 * - Export/reminder options
 * - Generate roster button
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ExportDialog } from './ExportDialog';
import { RosterGenerationDialog } from './RosterGenerationDialog';
import { AssignmentGrid } from './AssignmentGrid';
import { AssignmentCalendar } from './AssignmentCalendar';
import { StaffingOverview } from './StaffingOverview';
import { RosterPublicationDialog } from './RosterPublicationDialog';

interface PersonProgress {
  person_id: string;
  codenaam: string;
  submission_status: string | null;
  submitted_at: string | null;
  has_parttime_patterns: boolean;
  blocked_days_count: number;
  has_absences: boolean;
}

interface ImbalanceItem {
  person_id: string;
  codenaam: string;
  counter: string;
  delta: number;
  from_period: string;
}

interface DashboardData {
  period_id: string;
  period_name: string;
  status: string;
  submission_stats: {
    not_started: number;
    in_progress: number;
    confirmed: number;
  };
  large_imbalances: ImbalanceItem[];
  large_balance_threshold: number;
  total_staff: number;
  staff_with_parttime: number;
  assignment_count: number;
}

interface Props {
  periodId: string;
  /**
   * Called when this dashboard changes the period's status (publishing,
   * generating). The surrounding page keeps its own copy of the period for
   * the header badge, so without this it would keep showing the old status
   * until a manual reload - you publish and the badge still says "Generated".
   */
  onPeriodChanged?: () => void;
  /**
   * Called when this dashboard's "rooster genereren met solver" dialog
   * (re)generates a roster - for page-level pieces (e.g. FillGapsPanel)
   * that have the same "only knows about periodId, so never notices a
   * regenerate" staleness problem but live outside this component.
   */
  onRosterChanged?: () => void;
  /**
   * Bumped by the page whenever something outside this component changed
   * the roster's assignments - specifically FillGapsPanel applying staged
   * picks. This dashboard's own AssignmentGrid/AssignmentCalendar (and the
   * imbalance/staff-status numbers above them) otherwise have no way to
   * find out: they only ever see the same unchanging periodId. Any value
   * change triggers a reload; the value itself is otherwise meaningless.
   */
  refreshSignal?: number;
}

export function PlannerDashboard({ periodId, onPeriodChanged, onRosterChanged, refreshSignal }: Props) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [progress, setProgress] = useState<PersonProgress[]>([]);
  const [loading, setLoading] = useState(true);
  // loadError means the dashboard itself couldn't be fetched at all - fatal,
  // nothing else on this component can render meaningfully without it.
  // actionError is for an inline action failing (submit-on-behalf) with the
  // dashboard already showing - same split, and the same reasoning, as
  // AssignmentGrid's loadError/error: a rejected action isn't a reason to
  // blank out everything else the planner was looking at, and a planner
  // who fixes the underlying issue needs a way to dismiss it and try again
  // without a full page reload.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submittingFor, setSubmittingFor] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [rosterDialogOpen, setRosterDialogOpen] = useState(false);
  const [publicationDialogOpen, setPublicationDialogOpen] = useState(false);
  const [showAssignments, setShowAssignments] = useState(false);
  // Forces AssignmentGrid/AssignmentCalendar to remount (and so refetch)
  // after any roster (re)generation - their own fetch effects only depend
  // on periodId, which never changes across a regenerate, so without this
  // they'd keep showing the previous roster until an unrelated prop change
  // happened to remount them.
  const [assignmentsRefreshKey, setAssignmentsRefreshKey] = useState(0);
  const [assignmentsView, setAssignmentsView] = useState<'list' | 'calendar' | 'dienstdoende'>('list');

  const loadData = async () => {
    try {
      const [dashRes, progRes] = await Promise.all([
        fetch(`/api/planner/period/${periodId}/dashboard`),
        fetch(`/api/planner/period/${periodId}/progress`),
      ]);

      if (!dashRes.ok || !progRes.ok) throw new Error('Laden van dashboard mislukt');

      const dashData = await dashRes.json();
      const progData = await progRes.json();

      setLoadError(null);
      setDashboard(dashData.data);
      setProgress(progData.data);
      setLoading(false);
      // Any dashboard reload - mount, submit-on-behalf, refreshSignal, or
      // the roster dialog's own onSuccess - also means the assignments
      // list/calendar could be stale, so remount them together with it
      // rather than tracking each trigger separately.
      setAssignmentsRefreshKey((k) => k + 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Laden van dashboard mislukt');
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [periodId]);

  // Skips the first run the same way FillGapsPanel's persist effect does -
  // refreshSignal starts at whatever the page initialized it to, and that
  // initial value must not trigger a second, redundant load on mount.
  const skippedFirstRefreshSignal = useRef(false);
  useEffect(() => {
    if (refreshSignal === undefined) return;
    if (!skippedFirstRefreshSignal.current) {
      skippedFirstRefreshSignal.current = true;
      return;
    }
    loadData();
  }, [refreshSignal]);

  const handleSubmitOnBehalf = async (personId: string) => {
    setSubmittingFor(personId);
    setActionError(null);
    try {
      const res = await fetch(`/api/planner/person/${personId}/submit-on-behalf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: periodId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Indienen mislukt');
      }

      // Reload the full dashboard (not just progress) - the top-level
      // stats (bevestigd-telling, large_imbalances) are stale otherwise
      // until a manual page reload, and loadData() already has the
      // res.ok-checked fetch this used to duplicate without one.
      await loadData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Indienen mislukt');
    } finally {
      setSubmittingFor(null);
    }
  };

  if (loading) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg text-neutral-600">Dashboard laden...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card p-8 bg-red-50 border border-red-200 flex items-center justify-between gap-3">
        <p className="text-red-700">{loadError}</p>
        <button
          onClick={loadData}
          className="shrink-0 px-3 py-1.5 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700"
        >
          Opnieuw proberen
        </button>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="card p-8">
        <p className="text-neutral-600">Geen dashboardgegevens beschikbaar</p>
      </div>
    );
  }

  const stats = dashboard.submission_stats;
  const totalSubmissions = stats.not_started + stats.in_progress + stats.confirmed;
  const submissionProgress =
    totalSubmissions > 0 ? Math.round((stats.confirmed / totalSubmissions) * 100) : 0;

  const counterDisplayName: Record<string, string> = {
    AVOND: 'avonddienst',
    WEEKEND: 'weekenddienst',
    FEESTDAG: 'feestdagdienst',
  };

  // Once GEGENEREERD/GEPUBLICEERD, the solver has run - status alone
  // already answers "how is this roster filled". Before that, the only
  // possible source is a planner's own manual pre-fill (see
  // generate-roster/route.ts's manual_assignments handling for why doing
  // that before generating is safe: the solver respects it).
  const isGenerated = dashboard.status === 'GEGENEREERD' || dashboard.status === 'GEPUBLICEERD';
  const rosterFillState: 'LEEG' | 'HANDMATIG_DEELS' | 'AUTOMATISCH' = isGenerated
    ? 'AUTOMATISCH'
    : dashboard.assignment_count > 0
      ? 'HANDMATIG_DEELS'
      : 'LEEG';
  const rosterHeading: Record<typeof rosterFillState, string> = {
    LEEG: 'Dienstrooster (nog niet ingevuld)',
    HANDMATIG_DEELS: 'Dienstrooster (handmatig deels ingevuld)',
    AUTOMATISCH: 'Dienstrooster (automatisch ingevuld)',
  };
  const generateButtonLabel: Record<typeof rosterFillState, string> = {
    LEEG: '🚀 Rooster genereren met solver',
    HANDMATIG_DEELS: '🚀 Rooster aanvullen met solver',
    AUTOMATISCH: '🔄 Rooster opnieuw genereren met solver',
  };

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="card p-3 bg-red-50 border border-red-200 flex items-start justify-between gap-3">
          <p className="text-red-700 text-sm">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="text-red-700 hover:text-red-900 text-sm font-medium shrink-0"
          >
            Sluiten
          </button>
        </div>
      )}

      {/* Submission Progress Summary */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Voortgang indiening</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center">
            <div className="text-3xl font-bold text-blue-600">{stats.not_started}</div>
            <div className="text-sm text-neutral-600">Niet begonnen</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-amber-600">{stats.in_progress}</div>
            <div className="text-sm text-neutral-600">Bezig</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-bold text-green-600">{stats.confirmed}</div>
            <div className="text-sm text-neutral-600">Bevestigd</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full bg-neutral-200 rounded-full h-2 mb-2">
          <div
            className="bg-green-600 h-2 rounded-full transition-all"
            style={{ width: `${submissionProgress}%` }}
          />
        </div>
        <p className="text-sm text-neutral-600 text-center">
          {submissionProgress}% bevestigd ({stats.confirmed} van {totalSubmissions})
        </p>
      </div>

      {/* Large Imbalances */}
      {dashboard.large_imbalances.length > 0 && (
        <div className="card p-6 bg-amber-50 border border-amber-200">
          <h3 className="font-bold text-lg mb-3">
            ⚠️ Grote verschillen (≥{dashboard.large_balance_threshold} diensten verschil)
          </h3>
          <div className="space-y-2">
            {dashboard.large_imbalances.slice(0, 8).map((item) => (
              <div key={`${item.person_id}-${item.counter}`} className="flex justify-between text-sm">
                <span className="font-medium">{item.codenaam}</span>
                <span className="text-amber-800">
                  {Math.abs(item.delta)} {counterDisplayName[item.counter]} {item.delta > 0 ? 'extra' : 'minder'}
                </span>
              </div>
            ))}
            {dashboard.large_imbalances.length > 8 && (
              <p className="text-xs text-amber-700 pt-2">
                ... en {dashboard.large_imbalances.length - 8} meer verschillen
              </p>
            )}
          </div>
        </div>
      )}

      {/* Pool Info */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card p-4">
          <p className="text-sm text-neutral-600">Totaal personeel</p>
          <p className="text-2xl font-bold text-neutral-900">{dashboard.total_staff}</p>
        </div>
        <div className="card p-4">
          <p className="text-sm text-neutral-600">Met deeltijdpatroon</p>
          <p className="text-2xl font-bold text-neutral-900">{dashboard.staff_with_parttime}</p>
        </div>
      </div>

      {/* Staff Status Table */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Status personeel</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Naam</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-center font-semibold">Geblokkeerde dagen</th>
                <th className="px-3 py-2 text-center font-semibold">Deeltijd</th>
                <th className="px-3 py-2 text-center font-semibold">Acties</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {progress.map((person) => (
                <tr key={person.person_id} className="hover:bg-neutral-50">
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/planner/period/${periodId}/person/${person.person_id}`}
                      className="text-blue-700 hover:underline"
                      title="Bekijk voorkeurenkalender (alleen-lezen)"
                    >
                      {person.codenaam}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {!person.submission_status || person.submission_status === 'NIET_BEGONNEN' ? (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-red-100 text-red-800">
                        Niet begonnen
                      </span>
                    ) : person.submission_status === 'BEZIG' ? (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-amber-100 text-amber-800">
                        Bezig
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-1 rounded-full text-xs bg-green-100 text-green-800">
                        ✓ Bevestigd
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">{person.blocked_days_count}</td>
                  <td className="px-3 py-2 text-center">
                    {person.has_parttime_patterns ? (
                      <span className="text-green-600 font-bold">✓</span>
                    ) : (
                      <span className="text-neutral-400">−</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {(!person.submission_status || person.submission_status === 'NIET_BEGONNEN') && (
                      <button
                        onClick={() => handleSubmitOnBehalf(person.person_id)}
                        disabled={submittingFor === person.person_id}
                        className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
                      >
                        {submittingFor === person.person_id ? 'Bezig...' : 'Indienen'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Roster Generation & Export */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Rooster genereren</h3>
        <div className="mb-6">
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => setRosterDialogOpen(true)}
              disabled={dashboard.status === 'GEPUBLICEERD'}
              title={
                dashboard.status === 'GEPUBLICEERD'
                  ? 'Een gepubliceerd rooster is bevroren en kan niet meer opnieuw gegenereerd worden'
                  : undefined
              }
              className="px-4 py-2 rounded font-medium bg-purple-600 text-white hover:bg-purple-700 disabled:bg-neutral-400 transition-colors"
            >
              {generateButtonLabel[rosterFillState]}
            </button>
            {dashboard.status === 'GEGENEREERD' && (
              <button
                onClick={() => setPublicationDialogOpen(true)}
                className="px-4 py-2 rounded font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
              >
                ✅ Rooster publiceren
              </button>
            )}
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            Status: <span className="font-semibold">{dashboard.status}</span>
          </p>
        </div>

        <h3 className="font-bold text-lg mb-4">Exporteren en communicatie</h3>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => setExportDialogOpen(true)}
            className="px-4 py-2 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            📧 Uitnodigingen en herinneringen
          </button>
          <a
            href={`/api/exports/status-report/${periodId}`}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            📋 Statusrapport downloaden
          </a>
        </div>
      </div>

      {/* Assignments - visible from OPEN onward (not just after the solver
          has run) so a planner can pre-fill strong preferences by hand
          before generating; CONCEPT stays excluded since no shift_slot
          rows exist yet at that point. */}
      {['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status) && (
        <div className="card p-6">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h3 className="font-bold text-lg">{rosterHeading[rosterFillState]}</h3>
            <div className="flex items-center gap-2">
              {showAssignments && (
                <div className="inline-flex rounded overflow-hidden border border-neutral-300">
                  <button
                    onClick={() => setAssignmentsView('list')}
                    className={`px-3 py-1 text-sm font-medium transition-colors ${
                      assignmentsView === 'list'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-neutral-700 hover:bg-neutral-100'
                    }`}
                  >
                    📋 Lijst
                  </button>
                  <button
                    onClick={() => setAssignmentsView('calendar')}
                    className={`px-3 py-1 text-sm font-medium transition-colors border-l border-neutral-300 ${
                      assignmentsView === 'calendar'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-neutral-700 hover:bg-neutral-100'
                    }`}
                  >
                    📅 Kalender
                  </button>
                  <button
                    onClick={() => setAssignmentsView('dienstdoende')}
                    className={`px-3 py-1 text-sm font-medium transition-colors border-l border-neutral-300 ${
                      assignmentsView === 'dienstdoende'
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-neutral-700 hover:bg-neutral-100'
                    }`}
                  >
                    🧑‍⚕️ Dienstdoende
                  </button>
                </div>
              )}
              <button
                onClick={() => setShowAssignments(!showAssignments)}
                className="px-3 py-1 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                {showAssignments ? 'Verbergen' : 'Tonen'}
              </button>
            </div>
          </div>
          {showAssignments && (
            assignmentsView === 'list' ? (
              <AssignmentGrid
                key={assignmentsRefreshKey}
                periodId={periodId}
                periodStatus={dashboard.status}
                onChanged={() => {
                  // A reassign/remove here can open (or close) a gap -
                  // FillGapsPanel lives outside this component and has no
                  // other way to find out (see onRosterChanged's own
                  // docstring). loadData() also refreshes this dashboard's
                  // own imbalance/staff-status numbers, which a reassign
                  // can change too.
                  loadData();
                  onRosterChanged?.();
                }}
              />
            ) : assignmentsView === 'calendar' ? (
              <AssignmentCalendar
                key={assignmentsRefreshKey}
                periodId={periodId}
                periodStatus={dashboard.status}
                onChanged={() => {
                  // Same reasoning as AssignmentGrid's onChanged above - a
                  // right-click assign/reassign/remove here can open or
                  // close a gap FillGapsPanel needs to know about, and can
                  // change this dashboard's own imbalance/staff numbers.
                  loadData();
                  onRosterChanged?.();
                }}
              />
            ) : (
              <StaffingOverview key={assignmentsRefreshKey} periodId={periodId} />
            )
          )}
        </div>
      )}

      {/* Roster Generation Dialog */}
      <RosterGenerationDialog
        periodId={periodId}
        isOpen={rosterDialogOpen}
        onClose={() => setRosterDialogOpen(false)}
        onSuccess={() => {
          // Deliberately does NOT close the dialog - it switches to its own
          // result view (assignments created, solver status, cost) that the
          // planner needs to actually see; closing here immediately would
          // hide that report until they reopened the dialog. The dialog's
          // own "Sluiten" button is how they dismiss it once they've seen it.
          loadData();
          onPeriodChanged?.();
          onRosterChanged?.();
        }}
      />

      {/* Publication Dialog */}
      <RosterPublicationDialog
        periodId={periodId}
        isOpen={publicationDialogOpen}
        onClose={() => setPublicationDialogOpen(false)}
        onSuccess={() => {
          setPublicationDialogOpen(false);
          loadData();
          onPeriodChanged?.();
        }}
      />

      {/* Export Dialog */}
      <ExportDialog
        periodId={periodId}
        periodName={dashboard.period_name}
        isOpen={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
      />
    </div>
  );
}

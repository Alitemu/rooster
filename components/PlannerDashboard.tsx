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

import { useState, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useBodyScrollLock } from '@/lib/useBodyScrollLock';
import { useDialogDismiss } from '@/lib/useDialogDismiss';
import { ExportDialog, type ExportType } from './ExportDialog';
import { AutoReminderPanel } from './AutoReminderPanel';
import { RosterGenerationDialog } from './RosterGenerationDialog';
import { AssignmentGrid } from './AssignmentGrid';
import { AssignmentCalendar } from './AssignmentCalendar';
import { StaffingOverview } from './StaffingOverview';
import { RosterPublicationDialog } from './RosterPublicationDialog';
import { RebalanceSuggestions } from './RebalanceSuggestions';
import { FillGapsSummary } from './FillGapsSummary';
import { SwapRequestsOverview } from './SwapRequestsOverview';
import { hasUnappliedFillGapsDraft } from './FillGapsPanel';
import { periodStatusLabel } from '@/lib/statusLabels';
import { FellowBadge } from './FellowBadge';
import { MailSettingsDialog } from './MailSettingsDialog';
import { MailWarning } from './MailWarning';
import { withBasePath } from '@/lib/basePath';

interface PersonProgress {
  person_id: string;
  codenaam: string;
  submission_status: string | null;
  submitted_at: string | null;
  has_parttime_patterns: boolean;
  blocked_days_count: number;
  has_absences: boolean;
  is_fellow: number;
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
  deadline: string;
  pool_id: string;
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

/**
 * A collapsible card used to group secondary dashboard content (staff
 * status, export actions, rebalance suggestions, the roster itself) so the
 * period page isn't one long scroll of always-expanded cards.
 *
 * Fully controlled (open/pinned come from the parent, via PlannerDashboard's
 * openSections/pinnedSections) rather than native <details> state, because
 * the accordion behavior spans siblings - opening one section closes any
 * other open-but-unpinned one, which a single <details> element can't know
 * about on its own. The pin button only appears while open: pinning is a
 * "keep this open too" decision, meaningless on a section that's already
 * closed.
 */
function Section({
  title,
  hint,
  isOpen,
  pinned,
  onToggleOpen,
  onTogglePin,
  keepMounted = false,
  children,
}: {
  title: string;
  hint?: string;
  isOpen: boolean;
  pinned: boolean;
  onToggleOpen: () => void;
  onTogglePin: () => void;
  /**
   * Keep the body mounted (visually hidden via `hidden`, not unmounted)
   * while closed. Needed when a child fetches data this section's own
   * `hint` depends on (or, for "Voorstellen voor herverdeling", data that
   * decides whether the section should even render at all) - a child that
   * only mounts once the planner opens the section would never get the
   * chance to report anything before that, so the hint would stay blank
   * (or an empty-state section would never learn it's empty) until opened
   * at least once. Left false everywhere else, so heavier content
   * (Dienstrooster's AssignmentGrid/Calendar) still only loads once
   * actually opened.
   */
  keepMounted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="card overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleOpen();
          }
        }}
        aria-expanded={isOpen}
        className="flex items-center justify-between gap-3 p-4 cursor-pointer select-none hover:bg-neutral-50"
      >
        <span className="flex items-center gap-2 font-bold text-neutral-900">
          <svg
            className={`w-4 h-4 text-neutral-500 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clipRule="evenodd"
            />
          </svg>
          {title}
        </span>
        <span className="flex items-center gap-3 shrink-0">
          {hint && <span className="text-sm text-neutral-500 text-right">{hint}</span>}
          {isOpen && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              title={
                pinned
                  ? 'Losmaken: klapt dicht zodra je een andere sectie opent'
                  : 'Vastzetten: blijft open, ook als je een andere sectie opent'
              }
              aria-pressed={pinned}
              className={`px-1.5 py-1 rounded transition-colors ${
                pinned ? 'text-red-600 hover:text-red-800' : 'text-neutral-300 hover:text-neutral-500'
              }`}
            >
              {/* A plain 📌 emoji doesn't work here - emoji glyphs carry
                  their own fixed color and ignore the text-color classes
                  above, so pinned/unpinned would look identical. This SVG
                  uses currentColor instead, so the color toggle above is
                  actually visible. */}
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <circle cx="10" cy="7" r="4" />
                <rect x="9" y="10" width="2" height="7" rx="1" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {(isOpen || keepMounted) && (
        <div className={isOpen ? 'border-t border-neutral-100 p-4' : 'hidden'}>{children}</div>
      )}
    </div>
  );
}

type SectionKey = 'overloop' | 'vooraf' | 'personeel' | 'personeelbeheren' | 'export' | 'voorstellen' | 'rooster';

interface Props {
  periodId: string;
  /**
   * Called when this dashboard changes the period's status (publishing,
   * generating). The surrounding page keeps its own copy of the period for
   * the header badge, so without this it would keep showing the old status
   * until a manual reload - you publish and the badge still says "Generated".
   */
  onPeriodChanged?: () => void;
}

export function PlannerDashboard({ periodId, onPeriodChanged }: Props) {
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
  // without a full page reload. Keyed by personId and rendered inside that
  // person's own row (see below), not as a page-level banner - the staff
  // table can run to 30+ rows, so a banner anywhere outside the row itself
  // (even at the top of this same card) can still land off-screen for
  // whichever row the planner actually scrolled to, making a real
  // rejection (e.g. no preferences to submit yet) look like the button did
  // nothing.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ personId: string; message: string } | null>(null);
  const [submittingFor, setSubmittingFor] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  // Which screen ExportDialog opens straight to - null shows its own picker
  // (uitnodigingen/herinneringen/audit-trail). "Deadlineherinnering
  // versturen" below is a shortcut straight past that picker into
  // reminders, the same jump the period page used to offer on its own,
  // separate from this dashboard.
  const [exportInitialType, setExportInitialType] = useState<ExportType>(
    null
  );
  const [rosterDialogOpen, setRosterDialogOpen] = useState(false);
  // Shown instead of opening rosterDialogOpen when this browser is holding
  // staged-but-unapplied picks from "Rooster vooraf invullen" - see
  // hasUnappliedFillGapsDraft's own docstring for why generating without
  // applying them first silently throws them away.
  const [showUnappliedDraftWarning, setShowUnappliedDraftWarning] = useState(false);
  const [publicationDialogOpen, setPublicationDialogOpen] = useState(false);
  const [showUnpublishConfirm, setShowUnpublishConfirm] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishError, setUnpublishError] = useState<string | null>(null);
  // Accordion state for the four collapsible sections below (Personeel &
  // voortgang / Exporteren & communicatie / Voorstellen voor herverdeling /
  // Dienstrooster). At most one unpinned section is open at a time - opening
  // a section closes every other section that isn't pinned; a pinned one
  // stays open regardless of what else gets opened. Both start empty (every
  // section closed, nothing pinned) so the page loads as short as possible.
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(() => new Set());
  const [pinnedSections, setPinnedSections] = useState<Set<SectionKey>>(() => new Set());

  const toggleSectionOpen = (key: SectionKey) => {
    setOpenSections((prev) => {
      if (prev.has(key)) {
        const next = new Set(prev);
        next.delete(key);
        return next;
      }
      // Opening: keep whichever currently-open sections are pinned, drop
      // the rest, add this one.
      const next = new Set<SectionKey>();
      prev.forEach((k) => {
        if (pinnedSections.has(k)) next.add(k);
      });
      next.add(key);
      return next;
    });
  };

  const toggleSectionPin = (key: SectionKey) => {
    // Pinning/unpinning never itself opens or closes anything - it only
    // changes what happens the next time some OTHER section is opened (see
    // toggleSectionOpen above). Unpinning an already-open section leaves it
    // open until that moment.
    setPinnedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Forces AssignmentGrid/AssignmentCalendar to remount (and so refetch)
  // after any roster (re)generation - their own fetch effects only depend
  // on periodId, which never changes across a regenerate, so without this
  // they'd keep showing the previous roster until an unrelated prop change
  // happened to remount them.
  const [assignmentsRefreshKey, setAssignmentsRefreshKey] = useState(0);
  const [assignmentsView, setAssignmentsView] = useState<'list' | 'calendar' | 'dienstdoende' | 'ruilverzoeken'>('list');
  // The single most recent reversible assign/reassign/remove for this
  // period, read from the server (lib/pendingUndo.ts) rather than kept in
  // this component's own state - that's what makes it still show up after
  // a reload, in a different tab, or for a different planner who opens
  // this same period later, and what makes undoing it a real button
  // instead of a client-only ctrl+z that only the person who made the
  // change could ever use.
  const [pendingUndo, setPendingUndo] = useState<{ label: string; onderdeel?: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [mailSettingsOpen, setMailSettingsOpen] = useState(false);
  // Bumped when the mail settings change, so the automatic-reminder panel
  // re-reads whether sending is set up.
  const [mailSettingsKey, setMailSettingsKey] = useState(0);
  const [undoError, setUndoError] = useState<string | null>(null);
  // null = not known yet (still loading, or load failed) - the "Voorstellen
  // voor herverdeling" section stays visible in that case, so a load error
  // is never silently hidden. Only a confirmed 0 hides the section, so an
  // empty result doesn't cost a permanently-visible empty-state card (see
  // RebalanceSuggestions' own onCountChange call).
  const [suggestionCount, setSuggestionCount] = useState<number | null>(null);
  // Unfilled-slot count behind the "Rooster vooraf invullen" section hint,
  // reported by FillGapsSummary itself (its own dedicated endpoint, not
  // part of the /dashboard payload above).
  const [fillGapsCount, setFillGapsCount] = useState<number | null>(null);
  // Makes FillGapsSummary refetch in place. Deliberately separate from
  // assignmentsRefreshKey: a single reassign/remove (AssignmentGrid/
  // AssignmentCalendar's onChanged) can open or close a gap and so change
  // this count, but must NOT bump assignmentsRefreshKey too - that would
  // remount the assignments list/calendar on every pick, the exact
  // page-refresh-on-assign bug fixed earlier (see loadData's own comment).
  const [fillGapsRefreshKey, setFillGapsRefreshKey] = useState(0);

  // Called unconditionally, above every early return below (loading/error/
  // !dashboard) - both hooks are no-ops while showUnpublishConfirm is
  // false, but React requires the call itself to happen on every render.
  useBodyScrollLock(showUnpublishConfirm);
  const dismissUnpublishBackdrop = useDialogDismiss(showUnpublishConfirm, () => setShowUnpublishConfirm(false), !unpublishing);
  useBodyScrollLock(showUnappliedDraftWarning);
  const dismissUnappliedDraftBackdrop = useDialogDismiss(showUnappliedDraftWarning, () => setShowUnappliedDraftWarning(false));

  // bumpAssignmentsKey defaults to true - a full dashboard reload (mount,
  // submit-on-behalf, or the roster dialog's own onSuccess) means the
  // assignments list/calendar's data could be stale in a way its own
  // fetch effect won't notice on its own (a genuinely new dataset after
  // regeneration), so remounting them is the safe default there.
  //
  // AssignmentGrid/AssignmentCalendar's own onChanged (a single right-click
  // assign/reassign/remove) passes false: both already call their own
  // load()/loadSlots() and update in place before calling onChanged, so
  // remounting them here on top of that threw away the state they'd just
  // fetched and fetched it again from scratch - visible as the whole
  // calendar/list flashing to a loading state and back on every single
  // pick, which read as "the page refreshes" even though no navigation
  // happened.
  const loadData = async (bumpAssignmentsKey: boolean = true) => {
    try {
      const [dashRes, progRes] = await Promise.all([
        fetch(withBasePath(`/api/planner/period/${periodId}/dashboard`)),
        fetch(withBasePath(`/api/planner/period/${periodId}/progress`)),
      ]);

      if (!dashRes.ok || !progRes.ok) throw new Error('Laden van dashboard mislukt');

      const dashData = await dashRes.json();
      const progData = await progRes.json();

      setLoadError(null);
      setDashboard(dashData.data);
      setProgress(progData.data);
      setLoading(false);
      if (bumpAssignmentsKey) setAssignmentsRefreshKey((k) => k + 1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Laden van dashboard mislukt');
      setLoading(false);
    }

    // Best-effort, on its own: this is an auxiliary affordance, not core
    // dashboard data, so a failure here must never block the rest of the
    // page from loading the way the checks above do.
    try {
      const pendingRes = await fetch(withBasePath(`/api/planner/period/${periodId}/assignments/pending-undo`));
      const pendingData = await pendingRes.json();
      setPendingUndo(pendingRes.ok ? pendingData.data?.pending ?? null : null);
    } catch {
      setPendingUndo(null);
    }
  };

  useEffect(() => {
    setSuggestionCount(null);
    loadData();
  }, [periodId]);

  // Only asked for on a GEPUBLICEERD period - every route this calls
  // requires a reason there, same as a direct reassign/remove would.
  const [undoReasonPromptOpen, setUndoReasonPromptOpen] = useState(false);
  const [undoReason, setUndoReason] = useState('');

  const handleUndoLast = async (reason?: string) => {
    setUndoing(true);
    setUndoError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/assignments/undo-last`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error?.code === 'REASON_REQUIRED') {
          setUndoReasonPromptOpen(true);
          return;
        }
        throw new Error(data.error?.message || 'Ongedaan maken mislukt');
      }
      setUndoReasonPromptOpen(false);
      setUndoReason('');
      await loadData(false);
      setAssignmentsRefreshKey((k) => k + 1);
    } catch (err) {
      setUndoError(err instanceof Error ? err.message : 'Ongedaan maken mislukt');
    } finally {
      setUndoing(false);
    }
  };

  const handleUnpublish = async () => {
    setUnpublishing(true);
    setUnpublishError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/period/${periodId}/unpublish`), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Intrekken van publicatie mislukt');
      }
      setShowUnpublishConfirm(false);
      await loadData();
    } catch (err) {
      setUnpublishError(err instanceof Error ? err.message : 'Intrekken van publicatie mislukt');
    } finally {
      setUnpublishing(false);
    }
  };

  const handleSubmitOnBehalf = async (personId: string) => {
    setSubmittingFor(personId);
    setActionError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/person/${personId}/submit-on-behalf`), {
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
      setActionError({ personId, message: err instanceof Error ? err.message : 'Indienen mislukt' });
    } finally {
      setSubmittingFor(null);
    }
  };

  // The planner may change who is a fellow (lib/fellows.ts) until the
  // roster is generated; the participant only until the deadline.
  const handleToggleFellow = async (personId: string, fellow: boolean) => {
    setSubmittingFor(personId);
    setActionError(null);
    // Ticked at once, put back if saving fails (the reload below re-sorts).
    const setLocal = (value: boolean) =>
      setProgress((prev) => prev.map((p) => (p.person_id === personId ? { ...p, is_fellow: value ? 1 : 0 } : p)));
    setLocal(fellow);
    try {
      const res = await fetch(withBasePath(`/api/person/${personId}/fellow`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: periodId, fellow }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || 'Aanpassen mislukt');
      }
      await loadData();
    } catch (err) {
      setLocal(!fellow);
      setActionError({ personId, message: err instanceof Error ? err.message : 'Aanpassen mislukt' });
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
          onClick={() => loadData()}
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

  // The "ongedaan maken" banner sits inside the section the change was
  // made in (pendingUndo.onderdeel, lib/pendingUndo.ts), so it folds away
  // with it. "Voorstellen voor herverdeling" hides itself once nothing is
  // left to suggest; its undo then goes under the roster instead.
  const herverdelingZichtbaar = dashboard.assignment_count > 0 && suggestionCount !== 0;
  const undoOnderdeel = !pendingUndo
    ? null
    : pendingUndo.onderdeel === 'VOORAF' || (pendingUndo.onderdeel === 'HERVERDELING' && herverdelingZichtbaar)
      ? pendingUndo.onderdeel
      : 'ROOSTER';
  const undoBanner = (onderdeel: 'ROOSTER' | 'VOORAF' | 'HERVERDELING') =>
    undoOnderdeel === onderdeel && pendingUndo ? (
      <div className="mb-4 space-y-2">
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-blue-900">
            <span className="font-medium">Laatst gewijzigd:</span> {pendingUndo.label}
          </p>
          {undoReasonPromptOpen ? (
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={undoReason}
                onChange={(e) => setUndoReason(e.target.value)}
                placeholder="Reden (verplicht bij gepubliceerd rooster)"
                className="px-2 py-1 border rounded text-sm"
                autoFocus
              />
              <button
                onClick={() => handleUndoLast(undoReason)}
                disabled={undoing || !undoReason.trim()}
                className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {undoing ? 'Bezig…' : 'Bevestigen'}
              </button>
              <button
                onClick={() => {
                  setUndoReasonPromptOpen(false);
                  setUndoReason('');
                }}
                disabled={undoing}
                className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
              >
                Annuleren
              </button>
            </div>
          ) : (
            <button
              onClick={() => handleUndoLast()}
              disabled={undoing}
              className="shrink-0 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {undoing ? 'Bezig…' : '↩️ Ongedaan maken'}
            </button>
          )}
        </div>
        {undoError && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{undoError}</div>
        )}
      </div>
    ) : onderdeel === 'ROOSTER' && !pendingUndo && undoError ? (
      // The undo went wrong and there is nothing left to undo (someone
      // else changed it meanwhile): the message still needs a place.
      <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{undoError}</div>
    ) : null;

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
    <div className="space-y-4">
      {/* No separate stats-summary card here anymore - it duplicated
          exactly what "Status voorkeuren" already shows in its own
          section hint below (visible whether that section is open or
          closed), just phrased slightly differently. */}

      {/* Mail not going out: period-wide, so above every heading. */}
      <MailWarning refreshKey={`${mailSettingsKey}|${exportDialogOpen}`} onOpenSettings={() => setMailSettingsOpen(true)} />

      {/* Large Imbalances - an actionable warning, not a summary stat, so
          unlike the rest of this reorganization it stays directly visible
          instead of behind a click. */}
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

      {/* Primary actions - the buttons a planner reaches for on every visit,
          kept in one row rather than spread across multiple cards. */}
      <div className="card p-4">
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => {
              if (hasUnappliedFillGapsDraft(periodId)) {
                setShowUnappliedDraftWarning(true);
              } else {
                setRosterDialogOpen(true);
              }
            }}
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
          {dashboard.status === 'GEPUBLICEERD' && (
            <button
              onClick={() => {
                setUnpublishError(null);
                setShowUnpublishConfirm(true);
              }}
              className="px-4 py-2 rounded font-medium bg-white border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
            >
              ↩️ Publicatie intrekken
            </button>
          )}
        </div>
        <p className="text-xs text-neutral-500 mt-2">
          Status: <span className="font-semibold">
            {periodStatusLabel(dashboard.status).charAt(0).toUpperCase() + periodStatusLabel(dashboard.status).slice(1)}
          </span>
        </p>
      </div>

      {/* Same status gate as the page's old link used ("niet CONCEPT") -
          equivalent to Dienstrooster's own gate below, since a CONCEPT
          period has no shift_slot rows yet either. */}
      {['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status) && (
        <Section
          title="Eerdere toewijzingen"
          isOpen={openSections.has('overloop')}
          pinned={pinnedSections.has('overloop')}
          onToggleOpen={() => toggleSectionOpen('overloop')}
          onTogglePin={() => toggleSectionPin('overloop')}
        >
          <p className="text-sm text-neutral-600 mb-3">
            De vensterregel (niemand twee keer binnen het ingestelde venster) geldt ook over de
            grens van de vorige periode heen. De solver moet dus weten wie aan het eind daarvan
            welke dienst had. Hier leg je dat vast. Dat gaat automatisch vanuit de vorige
            gepubliceerde periode, via een CSV-bestand of met de hand. Bevestigen is verplicht
            voordat je het rooster kunt genereren. Alleen de allereerste periode van een team slaat
            dit over, want die heeft niets om over te dragen.
          </p>
          <div className="flex justify-end">
            <Link
              href={`/planner/period/${periodId}/prior-assignments`}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              🔁 Eerdere toewijzingen
            </Link>
          </div>
        </Section>
      )}

      {/* Same status gate as Dienstrooster below - a CONCEPT period has no
          shift_slot rows yet, so "unfilled slots" is meaningless there. */}
      {['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status) && (
        <Section
          title="Rooster vooraf invullen"
          hint={
            fillGapsCount === null
              ? undefined
              : fillGapsCount === 0
                ? 'alles ingevuld'
                : `${fillGapsCount} dienst${fillGapsCount === 1 ? '' : 'en'} nog niet ingevuld`
          }
          isOpen={openSections.has('vooraf')}
          pinned={pinnedSections.has('vooraf')}
          onToggleOpen={() => toggleSectionOpen('vooraf')}
          onTogglePin={() => toggleSectionPin('vooraf')}
          keepMounted
        >
          {undoBanner('VOORAF')}
          <FillGapsSummary refreshKey={fillGapsRefreshKey} periodId={periodId} onCountChange={setFillGapsCount} />
        </Section>
      )}

      <Section
        title="Status voorkeuren"
        hint={`${dashboard.total_staff} personen · ${stats.confirmed} bevestigd, ${stats.in_progress} bezig, ${stats.not_started} niet begonnen`}
        isOpen={openSections.has('personeel')}
        pinned={pinnedSections.has('personeel')}
        onToggleOpen={() => toggleSectionOpen('personeel')}
        onTogglePin={() => toggleSectionPin('personeel')}
      >
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
        <p className="text-sm text-neutral-600 text-center mb-4">
          {submissionProgress}% bevestigd ({stats.confirmed} van {totalSubmissions})
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Naam</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-center font-semibold">Geblokkeerde dagen</th>
                <th className="px-3 py-2 text-center font-semibold">Deeltijd</th>
                <th className="px-3 py-2 text-center font-semibold">Fellow</th>
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
                    {person.is_fellow ? <FellowBadge /> : null}
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
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={Boolean(person.is_fellow)}
                      // Fixed once the roster is made (the API refuses it too, see the fellow route).
                      disabled={submittingFor === person.person_id || isGenerated}
                      onChange={(e) => handleToggleFellow(person.person_id, e.target.checked)}
                      aria-label={`${person.codenaam} is fellow`}
                      title={
                        isGenerated
                          ? 'Het rooster is al gemaakt. Wie fellow is, ligt nu vast.'
                          : 'Fellow: weekenden geblokkeerd voor de AIOS-ondersteuning op zaterdag'
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    {/* Only while preferences still matter: once the roster is
                        generated, confirming for someone changes nothing (the
                        API refuses it too, see submit-on-behalf). */}
                    {(dashboard.status === 'OPEN' || dashboard.status === 'GESLOTEN') &&
                      (!person.submission_status || person.submission_status === 'NIET_BEGONNEN') && (
                      <>
                        <button
                          onClick={() => handleSubmitOnBehalf(person.person_id)}
                          disabled={submittingFor === person.person_id}
                          className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
                        >
                          {submittingFor === person.person_id ? 'Bezig...' : 'Indienen'}
                        </button>
                        {actionError?.personId === person.person_id && (
                          <div className="mt-2 p-2 rounded border border-red-200 bg-red-50 text-left flex items-start gap-2 max-w-xs mx-auto">
                            <p className="text-xs text-red-800">{actionError.message}</p>
                            <button
                              onClick={() => setActionError(null)}
                              className="shrink-0 px-2 py-0.5 rounded border border-red-300 bg-white text-red-700 text-xs font-medium hover:bg-red-100"
                            >
                              Sluiten
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Always shown, regardless of period status - unlike the ruleset,
          pool membership was never actually period-scoped server-side.
          getEligiblePeopleForSlot (lib/rosterGaps.ts) only checks whether
          someone's geldig_vanaf/geldig_tot overlaps this period's dates,
          nothing about the period's own status - so adding someone here
          after publication (a fellow starting partway through the year,
          say) makes them show up in the manual-assign dropdown right away,
          exactly when a planner needs to hand-schedule them into the rest
          of an already-published roster. Hiding this for GEPUBLICEERD
          (as an earlier version of this section did, reasoning from the
          ruleset being frozen - a real but unrelated restriction) would
          have blocked exactly that. Links to the standalone pool-wide
          staff page (not the setup wizard's "Personeel" step) - that step
          only exists to walk through when opening a new period, and
          dropping a planner into it mid-tab for an already-open period
          made it look like part of a multi-step flow they still needed to
          click through, rather than a direct edit. */}
      <Section
        title="Personeel beheren"
        isOpen={openSections.has('personeelbeheren')}
        pinned={pinnedSections.has('personeelbeheren')}
        onToggleOpen={() => toggleSectionOpen('personeelbeheren')}
        onTogglePin={() => toggleSectionPin('personeelbeheren')}
      >
        {/* Text and button stacked, not side-by-side - this paragraph is
            long enough to wrap at normal card widths, and a wrapped
            justify-between row drops the button onto its own line flush
            LEFT (nothing left to space it against there), not right. A
            dedicated justify-end row underneath keeps it at the right
            regardless of how many lines the text takes. */}
        <p className="text-sm text-neutral-600 mb-3">
          Voeg hier personeel toe of verwijder ze. Per persoon pas je hier ook de geldigheidsperiode
          of deelnamefactor aan. Dit werkt op elk moment, ook in een al gepubliceerd rooster. Dat is
          handig als iemand halverwege start: voeg diegene hier toe met de juiste
          geldig-vanaf-datum. Die persoon verschijnt dan meteen in de keuzelijst bij het handmatig
          toewijzen van diensten in deze periode.
        </p>
        <div className="flex justify-end">
          <Link
            href={`/planner/pool/${dashboard.pool_id}/staff`}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            👥 Personeel beheren
          </Link>
        </div>
      </Section>

      <Section
        title="Exporteren & communicatie"
        hint="uitnodigingen, herinneringen, statusrapport, mailinstellingen"
        isOpen={openSections.has('export')}
        pinned={pinnedSections.has('export')}
        onToggleOpen={() => toggleSectionOpen('export')}
        onTogglePin={() => toggleSectionPin('export')}
      >
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => {
              setExportInitialType(null);
              setExportDialogOpen(true);
            }}
            className="px-4 py-2 rounded font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            📧 Uitnodigingen en herinneringen
          </button>
          {/* Herinneren heeft alleen zin zolang de periode nog open staat
              voor indiening - zelfde voorwaarde als "Periode sluiten" op de
              periodepagina zelf. */}
          {dashboard.status === 'OPEN' && (
            <button
              onClick={() => {
                setExportInitialType('reminders');
                setExportDialogOpen(true);
              }}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              📧 Deadlineherinnering versturen
            </button>
          )}
          <button
            onClick={() => setMailSettingsOpen(true)}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            ⚙️ Mailinstellingen
          </button>
          <a
            href={withBasePath(`/api/exports/status-report/${periodId}`)}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            📋 Statusrapport downloaden
          </a>
          <a
            href={withBasePath(`/api/exports/preferences/${periodId}`)}
            className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            🗓️ Alle voorkeuren downloaden (CSV)
          </a>
          {/* Only meaningful once there's something in it - bewaar dit
              bestand ergens veilig: het is de aanbevolen manier om een
              toekomstige periode's "Eerdere toewijzingen" in te vullen als
              deze periode dan zelf niet meer opvraagbaar is (zie de
              uitleg bij dat kopje). */}
          {dashboard.assignment_count > 0 && (
            <a
              href={withBasePath(`/api/exports/assignments/${periodId}`)}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              📅 Rooster downloaden (CSV)
            </a>
          )}
        </div>
        <div className="mt-4">
          {/* Reloaded after a new deadline, a submission or closing the
              export dialog (a reminder sent by hand moves people out of
              the next automatic one). */}
          <AutoReminderPanel
            periodId={periodId}
            refreshKey={`${dashboard.deadline}|${dashboard.status}|${dashboard.submission_stats.confirmed}|${dashboard.submission_stats.in_progress}|${exportDialogOpen}|${mailSettingsKey}`}
          />
        </div>
      </Section>

      {/* Only meaningful once there's an actual roster to rebalance -
          suggestions need existing assignments to move around. Also hidden
          once RebalanceSuggestions has confirmed there's nothing to show
          (suggestionCount === 0) - a permanently-visible empty-state card
          was exactly the kind of clutter this reorganization removes
          elsewhere; suggestionCount stays null (so this stays visible)
          while that hasn't been confirmed yet, including on a load error. */}
      {dashboard.assignment_count > 0 && suggestionCount !== 0 && (
        <Section
          title="Voorstellen voor herverdeling"
          hint={suggestionCount ? `${suggestionCount} voorstel${suggestionCount === 1 ? '' : 'len'}` : undefined}
          isOpen={openSections.has('voorstellen')}
          pinned={pinnedSections.has('voorstellen')}
          onToggleOpen={() => toggleSectionOpen('voorstellen')}
          onTogglePin={() => toggleSectionPin('voorstellen')}
          keepMounted
        >
          {undoBanner('HERVERDELING')}
          <RebalanceSuggestions
            periodId={periodId}
            isPublished={dashboard.status === 'GEPUBLICEERD'}
            onApplied={loadData}
            onCountChange={setSuggestionCount}
          />
        </Section>
      )}

      {/* Dienstrooster - visible from OPEN onward (not just after the
          solver has run) so a planner can pre-fill strong preferences by
          hand before generating; CONCEPT stays excluded since no
          shift_slot rows exist yet at that point. */}
      {['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status) && (
        <Section
          title={rosterHeading[rosterFillState]}
          isOpen={openSections.has('rooster')}
          pinned={pinnedSections.has('rooster')}
          onToggleOpen={() => toggleSectionOpen('rooster')}
          onTogglePin={() => toggleSectionPin('rooster')}
        >
          {undoBanner('ROOSTER')}
          {/* overflow-x-auto on its own is enough here (unlike the old
              header-row version of this button group) - this is a plain
              block-level div now, not a flex sibling fighting a title for
              space, so it doesn't need the min-w-0 workaround too. Still
              needed at all: the four buttons together are wider
              than a 375px screen's content width once this section's own
              padding is subtracted. */}
          <div className="overflow-x-auto mb-4">
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
            <button
              onClick={() => setAssignmentsView('ruilverzoeken')}
              className={`px-3 py-1 text-sm font-medium transition-colors border-l border-neutral-300 ${
                assignmentsView === 'ruilverzoeken'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              🔁 Ruilverzoeken
            </button>
          </div>
          </div>

          {assignmentsView === 'list' ? (
            <AssignmentGrid
              key={assignmentsRefreshKey}
              periodId={periodId}
              periodStatus={dashboard.status}
              onChanged={() => {
                // A reassign/remove here can open (or close) a gap - the
                // "Rooster vooraf invullen" section's count has no other way
                // to find out. loadData(false) also refreshes this
                // dashboard's own imbalance/staff-status numbers, which a
                // reassign can change too - false because AssignmentGrid
                // already reloaded its own rows before calling this, so
                // remounting it here on top of that would throw that away
                // and fetch it all over again for nothing.
                loadData(false);
                setFillGapsRefreshKey((k) => k + 1);
              }}
            />
          ) : assignmentsView === 'calendar' ? (
            <AssignmentCalendar
              key={assignmentsRefreshKey}
              periodId={periodId}
              periodStatus={dashboard.status}
              onChanged={() => {
                // Same reasoning as AssignmentGrid's onChanged above - a
                // right-click assign/reassign/remove here can open or close
                // a gap the "Rooster vooraf invullen" count needs to know
                // about, and can change this dashboard's own
                // imbalance/staff numbers. false because AssignmentCalendar
                // already reloaded its own slots before calling this.
                loadData(false);
                setFillGapsRefreshKey((k) => k + 1);
              }}
            />
          ) : assignmentsView === 'dienstdoende' ? (
            <StaffingOverview key={assignmentsRefreshKey} periodId={periodId} />
          ) : (
            <SwapRequestsOverview key={assignmentsRefreshKey} periodId={periodId} />
          )}
        </Section>
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
          setFillGapsRefreshKey((k) => k + 1);
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
      <MailSettingsDialog
        isOpen={mailSettingsOpen}
        onClose={() => setMailSettingsOpen(false)}
        onChanged={() => setMailSettingsKey((k) => k + 1)}
      />
      <ExportDialog
        periodId={periodId}
        periodName={dashboard.period_name}
        deadline={dashboard.deadline}
        periodStatus={dashboard.status}
        isOpen={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
        onDeadlineChanged={() => {
          loadData();
          onPeriodChanged?.();
        }}
        initialType={exportInitialType}
      />

      {/* Unpublish confirmation - the one way back out of GEPUBLICEERD.
          Assignments and already-sent notifications stay; every pool
          member gets told the publication was withdrawn. */}
      {showUnpublishConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Publicatie intrekken"
          onClick={dismissUnpublishBackdrop}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-2 text-red-700">Publicatie intrekken?</h2>
            <p className="text-sm text-neutral-700 mb-2">
              Het rooster voor &quot;{dashboard.period_name}&quot; gaat terug naar de status
              &quot;Gegenereerd&quot;. De toewijzingen blijven staan. Je kunt ze aanpassen en het
              rooster later opnieuw publiceren.
            </p>
            <p className="text-sm text-neutral-700 mb-4">
              Iedereen die het gepubliceerde rooster kon zien, krijgt een melding dat de publicatie
              is ingetrokken.
            </p>
            {unpublishError && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-4">
                <p className="text-sm text-red-800">{unpublishError}</p>
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setShowUnpublishConfirm(false)}
                disabled={unpublishing}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors disabled:opacity-50"
              >
                Annuleren
              </button>
              <button
                onClick={handleUnpublish}
                disabled={unpublishing}
                className="flex-1 py-2 px-4 rounded font-medium bg-red-700 text-white hover:bg-red-800 transition-colors disabled:opacity-50"
              >
                {unpublishing ? 'Bezig...' : 'Ja, publicatie intrekken'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUnappliedDraftWarning && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Niet-toegepaste toewijzingen"
          onClick={dismissUnappliedDraftBackdrop}
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-2 text-amber-800">⚠️ Niet-toegepaste toewijzingen</h2>
            <p className="text-sm text-neutral-700 mb-4">
              Bij &quot;Rooster vooraf invullen&quot; staan nog keuzes klaar die niet zijn toegepast.
              De solver ziet deze pas zodra je op &quot;Alle toewijzingen toepassen&quot; hebt geklikt.
              Ga je nu verder met genereren, dan worden deze keuzes genegeerd.
            </p>
            <div className="flex gap-3">
              <Link
                href={`/planner/period/${periodId}/fill-gaps`}
                className="flex-1 py-2 px-4 rounded font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors text-center"
              >
                📝 Ga naar Rooster vooraf invullen
              </Link>
              <button
                onClick={() => {
                  setShowUnappliedDraftWarning(false);
                  setRosterDialogOpen(true);
                }}
                className="flex-1 py-2 px-4 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Toch doorgaan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Planner Period Dashboard Page
 *
 * Shows period progress, staff status, and controls
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { PlannerDashboard } from '@/components/PlannerDashboard';
import { ExportDialog } from '@/components/ExportDialog';
import { FillGapsPanel } from '@/components/FillGapsPanel';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  gepubliceerd_op?: string | null;
  bevroren_ruleset_json?: string | null;
}

export default function PlannerPeriodPage() {
  const params = useParams();
  const periodId = params.id as string;

  const [period, setPeriod] = useState<Period | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeConfirmArmed, setCloseConfirmArmed] = useState(false);
  const [editingDeadline, setEditingDeadline] = useState(false);
  const [deadlineInput, setDeadlineInput] = useState('');
  const [savingDeadline, setSavingDeadline] = useState(false);
  const [deadlineError, setDeadlineError] = useState<string | null>(null);
  // Bumped whenever PlannerDashboard's "rooster genereren met solver" dialog
  // (re)generates a roster - FillGapsPanel lives here, on the page, and its
  // own fetch effect only depends on periodId (never changes across a
  // regenerate), so without this signal it would keep showing the previous
  // roster's unfilled slots.
  const [rosterVersion, setRosterVersion] = useState(0);
  // The reverse signal: bumped whenever FillGapsPanel (also here, on the
  // page) applies staged assignments. PlannerDashboard's own assignments
  // list/calendar and imbalance numbers otherwise have no way to notice -
  // they only ever see the same unchanging periodId, same reasoning as
  // rosterVersion above but in the other direction.
  const [assignmentsVersion, setAssignmentsVersion] = useState(0);
  // Stable across renders - FillGapsPanel's own load() is a useCallback
  // depending on [periodId, onAllFilled], re-run by its useEffect whenever
  // that identity changes. A fresh inline arrow function here would give
  // onAllFilled a new identity on every render this causes (bumping
  // assignmentsVersion IS a render), which would re-run load(), which -
  // finding the same zero unfilled slots again - calls onAllFilled again:
  // an infinite fetch loop (the same class of bug useCoverageUpdate's
  // no-op fix addressed on PreferencesCalendar). useCallback with an empty
  // dependency array keeps the identity fixed, breaking that cycle.
  const handleAssignmentsChanged = useCallback(() => {
    setAssignmentsVersion((v) => v + 1);
  }, []);

  const loadPeriod = async () => {
    try {
      const res = await fetch(`/api/periods/${periodId}`);
      if (!res.ok) throw new Error('Laden van periode mislukt');

      const data = await res.json();
      setPeriod(data.data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Laden van periode mislukt');
      setLoading(false);
    }
  };

  // datetime-local wants "YYYY-MM-DDTHH:mm" (no seconds, no timezone) -
  // strip both from the stored ISO value so the input starts pre-filled
  // with the deadline as it already is, not blank.
  const toDatetimeLocal = (iso: string): string => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const startEditDeadline = () => {
    if (!period) return;
    setDeadlineError(null);
    setDeadlineInput(toDatetimeLocal(period.deadline));
    setEditingDeadline(true);
  };

  const handleSaveDeadline = async () => {
    setSavingDeadline(true);
    setDeadlineError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/deadline`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deadline: deadlineInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Aanpassen van deadline mislukt');
      setEditingDeadline(false);
      await loadPeriod();
    } catch (err) {
      setDeadlineError(err instanceof Error ? err.message : 'Aanpassen van deadline mislukt');
    } finally {
      setSavingDeadline(false);
    }
  };

  const handleClosePeriod = async () => {
    if (!closeConfirmArmed) {
      // First click arms the confirmation instead of closing immediately -
      // closing a period is not reversible from this screen.
      setCloseConfirmArmed(true);
      return;
    }
    setCloseConfirmArmed(false);
    setClosing(true);
    setCloseError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/close`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Sluiten van periode mislukt');
      await loadPeriod();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Sluiten van periode mislukt');
    } finally {
      setClosing(false);
    }
  };

  useEffect(() => {
    loadPeriod();
  }, [periodId]);

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center">
          <p className="text-lg text-neutral-600">Periode laden...</p>
        </div>
      </div>
    );
  }

  if (error || !period) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 bg-red-50 border border-red-200">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Fout</h1>
          <p className="text-neutral-700">{error || 'Periode niet gevonden'}</p>
        </div>
      </div>
    );
  }

  const statusColors: Record<string, { bg: string; text: string }> = {
    CONCEPT: { bg: 'bg-neutral-100', text: 'text-neutral-800' },
    OPEN: { bg: 'bg-blue-100', text: 'text-blue-800' },
    GESLOTEN: { bg: 'bg-amber-100', text: 'text-amber-800' },
    GEGENEREERD: { bg: 'bg-green-100', text: 'text-green-800' },
    GEPUBLICEERD: { bg: 'bg-emerald-100', text: 'text-emerald-800' },
  };

  const statusColor = statusColors[period.status] || statusColors.CONCEPT;

  return (
    <div className="container-main py-8 space-y-6">
      {/* Header */}
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-neutral-900 mb-2">{period.naam}</h1>
            <p className="text-neutral-600 mb-2">
              {new Date(period.start_datum).toLocaleDateString('nl-NL')} t/m{' '}
              {new Date(period.eind_datum).toLocaleDateString('nl-NL')}
            </p>
            {editingDeadline ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="text-neutral-600">Deadline:</label>
                <input
                  type="datetime-local"
                  value={deadlineInput}
                  onChange={(e) => setDeadlineInput(e.target.value)}
                  className="px-2 py-1 border rounded text-sm"
                />
                <button
                  onClick={handleSaveDeadline}
                  disabled={savingDeadline}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                >
                  {savingDeadline ? 'Bezig…' : 'Opslaan'}
                </button>
                <button
                  onClick={() => setEditingDeadline(false)}
                  className="text-xs font-medium text-neutral-600 hover:text-neutral-800"
                >
                  Annuleren
                </button>
                <p className="w-full text-xs text-neutral-500">
                  Let op: 00:00 uur is het begin van die dag, dus dezelfde middernacht als het
                  einde van de dag ervoor. Wil je de hele laatste dag nog meenemen, kies dan 00:00
                  op de dág erna (of 23:59 op de laatste dag zelf).
                </p>
                {deadlineError && <p className="w-full text-xs text-red-600">{deadlineError}</p>}
              </div>
            ) : (
              <p className="text-sm text-neutral-600">
                Deadline: {new Date(period.deadline).toLocaleString('nl-NL')}
                {period.status === 'OPEN' && (
                  <button
                    onClick={startEditDeadline}
                    className="ml-2 text-xs font-medium text-blue-600 hover:text-blue-800"
                  >
                    Aanpassen
                  </button>
                )}
              </p>
            )}
            {period.bevroren_ruleset_json && (() => {
              try {
                const cfg = JSON.parse(period.bevroren_ruleset_json);
                return (
                  <p className="text-sm text-neutral-600 mt-1">
                    Venster: {cfg.windowWeeks ?? '?'} weken · Avond {cfg.bandAvond?.[0] ?? '?'}-
                    {cfg.bandAvond?.[1] ?? '?'} · Weekend {cfg.bandWeekend?.[0] ?? '?'}-
                    {cfg.bandWeekend?.[1] ?? '?'} · Feestdag {cfg.bandFeestdag?.[0] ?? '?'}-
                    {cfg.bandFeestdag?.[1] ?? '?'}
                  </p>
                );
              } catch {
                return null;
              }
            })()}
          </div>
          <div>
            <div className={`px-4 py-2 rounded font-semibold ${statusColor.bg} ${statusColor.text}`}>
              {period.status === 'CONCEPT' && '⚙️ Concept'}
              {period.status === 'OPEN' && '📖 Open'}
              {period.status === 'GESLOTEN' && '🔒 Gesloten'}
              {period.status === 'GEGENEREERD' && '🤖 Gegenereerd'}
              {period.status === 'GEPUBLICEERD' && (
                <>
                  ✅ Gepubliceerd
                  {period.gepubliceerd_op && (
                    <span className="ml-2 font-normal text-sm">
                      · Gepubliceerd op {new Date(period.gepubliceerd_op).toLocaleString('nl-NL')}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Period Actions */}
      {period.status === 'CONCEPT' && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-900">
            Deze periode staat nog op concept. Ga naar de{' '}
            <a href={`/planner/setup/${periodId}`} className="font-medium underline">
              instelwizard
            </a>{' '}
            om deze in te stellen en te openen.
          </p>
        </div>
      )}

      {period.status === 'OPEN' && (
        <div className="space-y-2">
          <div className="flex gap-3">
            <button
              onClick={() => setReminderDialogOpen(true)}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              📧 Deadlineherinnering versturen
            </button>
            <button
              onClick={handleClosePeriod}
              disabled={closing}
              className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 disabled:bg-neutral-100 transition-colors"
            >
              {closing ? 'Bezig met sluiten...' : closeConfirmArmed ? 'Zeker weten? Nogmaals klikken' : '🔒 Periode sluiten'}
            </button>
            {closeConfirmArmed && (
              <button
                onClick={() => setCloseConfirmArmed(false)}
                className="px-4 py-2 rounded font-medium text-neutral-600 hover:text-neutral-800 transition-colors"
              >
                Annuleren
              </button>
            )}
          </div>
          {closeError && <p className="text-sm text-red-600">{closeError}</p>}
        </div>
      )}

      {period.status === 'GESLOTEN' && (
        <div className="card p-4 bg-blue-50 border border-blue-200">
          <p className="text-sm text-blue-900">
            Deze periode is gesloten voor nieuwe indieningen. Klaar om het rooster te genereren
            via &quot;Rooster genereren met solver&quot; hieronder.
          </p>
        </div>
      )}

      {['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(period.status) && (
        <FillGapsPanel
          key={rosterVersion}
          periodId={periodId}
          onAssignmentsChanged={handleAssignmentsChanged}
          onAllFilled={handleAssignmentsChanged}
        />
      )}

      {period.status !== 'CONCEPT' && (
        <a
          href={`/planner/period/${periodId}/prior-assignments`}
          className="inline-block px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
        >
          🔁 Eerdere toewijzingen
        </a>
      )}

      {/* Adding pool members has no period-status restriction server-side; GEPUBLICEERD stays excluded since its ruleset is frozen. */}
      {['OPEN', 'GESLOTEN', 'GEGENEREERD'].includes(period.status) && (
        <a
          href={`/planner/setup/${periodId}?stap=staff`}
          className="inline-block ml-3 px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
        >
          👥 Personeel beheren
        </a>
      )}

      <ExportDialog
        periodId={periodId}
        periodName={period.naam}
        isOpen={reminderDialogOpen}
        onClose={() => setReminderDialogOpen(false)}
        initialType="reminders"
      />

      {/* Dashboard */}
      <PlannerDashboard
        periodId={periodId}
        onPeriodChanged={loadPeriod}
        onRosterChanged={() => setRosterVersion((v) => v + 1)}
        refreshSignal={assignmentsVersion}
      />
    </div>
  );
}

/**
 * Planner Period Dashboard Page
 *
 * Shows period progress, staff status, and controls
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { PlannerDashboard } from '@/components/PlannerDashboard';
import { ExportDialog } from '@/components/ExportDialog';
import { RosterGenerationDialog } from '@/components/RosterGenerationDialog';
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
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);

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

  const handleClosePeriod = async () => {
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
              {new Date(period.start_datum).toLocaleDateString()} t/m{' '}
              {new Date(period.eind_datum).toLocaleDateString()}
            </p>
            <p className="text-sm text-neutral-600">
              Deadline: {new Date(period.deadline).toLocaleString()}
            </p>
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
                      · Gepubliceerd op {new Date(period.gepubliceerd_op).toLocaleString()}
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
              {closing ? 'Bezig met sluiten...' : '🔒 Periode sluiten'}
            </button>
          </div>
          {closeError && <p className="text-sm text-red-600">{closeError}</p>}
        </div>
      )}

      {period.status === 'GESLOTEN' && (
        <div className="card p-4 bg-blue-50 border border-blue-200">
          <p className="text-sm text-blue-900 mb-3">
            Deze periode is gesloten voor nieuwe indieningen. Klaar om het rooster te genereren.
          </p>
          <button
            onClick={() => setGenerateDialogOpen(true)}
            className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            🤖 Rooster genereren
          </button>
        </div>
      )}

      {(period.status === 'GEGENEREERD' || period.status === 'GEPUBLICEERD') && (
        <FillGapsPanel periodId={periodId} />
      )}

      {period.status === 'GEGENEREERD' && (
        <button
          onClick={() => setGenerateDialogOpen(true)}
          className="px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
        >
          🔄 Rooster opnieuw genereren
        </button>
      )}

      {period.status !== 'CONCEPT' && (
        <a
          href={`/planner/period/${periodId}/prior-assignments`}
          className="inline-block px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
        >
          🔁 Eerdere toewijzingen
        </a>
      )}

      <ExportDialog
        periodId={periodId}
        periodName={period.naam}
        isOpen={reminderDialogOpen}
        onClose={() => setReminderDialogOpen(false)}
      />

      <RosterGenerationDialog
        periodId={periodId}
        isOpen={generateDialogOpen}
        onClose={() => setGenerateDialogOpen(false)}
        onSuccess={loadPeriod}
      />

      {/* Dashboard */}
      <PlannerDashboard periodId={periodId} onPeriodChanged={loadPeriod} />
    </div>
  );
}

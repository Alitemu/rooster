/**
 * Prior Assignments (Overloop) Screen
 *
 * Lets a planner review, auto-derive, manually fill in, and confirm the
 * carry-over assignments from the last (windowWeeks - 1) weeks of the
 * previous published period, before roster generation is allowed to run.
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { parseCsv } from '@/lib/csv';

interface PriorAssignment {
  datum: string;
  iso_week: number;
  teller: string;
  person_codenaam: string | null;
  bron: string;
}

interface PriorAssignmentsData {
  period_id: string;
  date_range: [string, string];
  total_entries: number;
  assignments: PriorAssignment[];
  status: 'partial' | 'complete';
}

interface Period {
  id: string;
  naam: string;
  pool_id: string;
  overloop_bevestigd_op: string | null;
}

interface StaffMember {
  person_id: string;
  codenaam: string;
}

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'Avond',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Feestdag',
};

const BRON_LABELS: Record<string, string> = {
  AFGELEID: 'Automatisch afgeleid',
  HANDMATIG: 'Handmatig',
  ONBEKEND: 'Onbekend',
};

export default function PriorAssignmentsPage() {
  const params = useParams();
  const router = useRouter();
  const periodId = params.id as string;

  const [period, setPeriod] = useState<Period | null>(null);
  const [data, setData] = useState<PriorAssignmentsData | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [deriving, setDeriving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmResult, setConfirmResult] = useState<string | null>(null);
  // Feedback for "Automatisch afleiden uit vorige periode" - a 0-derived
  // result (no previous published period, or nothing new to pull in) is
  // still a normal, successful response (res.ok), so without this the
  // button visibly did nothing and gave no clue why.
  const [deriveInfo, setDeriveInfo] = useState<string | null>(null);
  // CSV upload (fallback for when auto-derive can't reach the previous
  // period's own live data - see the "Eerdere toewijzingen" section's own
  // explanation on the dashboard). Rows are pre-filtered to the overloop
  // window client-side so the planner sees exactly what will import before
  // confirming, but the server re-filters independently - see
  // import-csv/route.ts's own docstring for why that's not redundant.
  const [csvRows, setCsvRows] = useState<Array<{ datum: string; teller: string; codenaam: string }> | null>(null);
  const [csvOutOfRangeCount, setCsvOutOfRangeCount] = useState(0);
  const [csvParseWarnings, setCsvParseWarnings] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  // Which row's "Toegewezen aan" is being edited via "Wisselen" - same
  // reveal-an-inline-editor pattern as AssignmentGrid.tsx's own Acties
  // column, so a swap that already happened in real life (but isn't in
  // whatever auto-derive or a CSV produced) reads and works the same way
  // here as it does on the live roster.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editCodenaam, setEditCodenaam] = useState('');

  const load = async () => {
    try {
      const periodRes = await fetch(`/api/periods/${periodId}`);
      const periodData = await periodRes.json();
      setPeriod(periodData.data);

      const assignmentsRes = await fetch(`/api/periods/${periodId}/prior-assignments`);
      const assignmentsData = await assignmentsRes.json();
      setData(assignmentsData.data);

      if (periodData.data?.pool_id) {
        const staffRes = await fetch(`/api/planner/pool/${periodData.data.pool_id}/members`);
        const staffData = await staffRes.json();
        setStaff(
          (staffData.data || []).map((m: { person_id: string; codenaam: string }) => ({
            person_id: m.person_id,
            codenaam: m.codenaam,
          }))
        );
      }
    } catch {
      setError('Laden van eerdere toewijzingen mislukt');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [periodId]);

  const handleAutoDerive = async () => {
    setDeriving(true);
    setError(null);
    setDeriveInfo(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments/auto-derive`, {
        method: 'POST',
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || 'Automatisch afleiden mislukt');
      setDeriveInfo(result.data.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Automatisch afleiden mislukt');
    } finally {
      setDeriving(false);
    }
  };

  const handleAssign = async (datum: string, teller: string, codenaam: string | null) => {
    const key = `${datum}-${teller}`;
    setSavingKey(key);
    setError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datum, teller, person_codenaam: codenaam }),
      });
      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error?.message || 'Opslaan mislukt');
      }
      await load();
      // Only closes the inline editor on success - a rejected save leaves
      // it open so the planner can see the error next to what they just
      // tried, and retry without picking the person again.
      setEditingKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan mislukt');
    } finally {
      setSavingKey(null);
    }
  };

  // Header row is Datum,Week,Diensttype,Codenaam (see
  // /api/exports/assignments/[period-id] - built to match this exactly),
  // but only Datum/Diensttype/Codenaam matter here; Week is derived
  // server-side from Datum regardless of what a hand-edited file says.
  const handleCsvFile = async (file: File) => {
    if (!data) return;
    const text = await file.text();
    const [, ...dataLines] = parseCsv(text); // skip header row
    const inRange: Array<{ datum: string; teller: string; codenaam: string }> = [];
    const warnings: string[] = [];
    let outOfRange = 0;
    dataLines.forEach(([datum, , diensttype, codenaam], i) => {
      const rowNum = i + 2; // header is row 1
      if (!datum) return;
      const teller = (diensttype || '').trim().toUpperCase();
      if (!['AVOND', 'WEEKEND', 'FEESTDAG'].includes(teller)) {
        warnings.push(`Rij ${rowNum}: onbekend diensttype "${diensttype}", overgeslagen`);
        return;
      }
      // Automatisch de juiste week selecteren: alles buiten het
      // overloopvenster hierboven wordt hier al genegeerd, niet pas na
      // een importpoging.
      if (datum < data.date_range[0] || datum > data.date_range[1]) {
        outOfRange++;
        return;
      }
      inRange.push({ datum, teller, codenaam: (codenaam || '').trim() });
    });
    setCsvRows(inRange);
    setCsvOutOfRangeCount(outOfRange);
    setCsvParseWarnings(warnings);
    setImportResult(null);
  };

  const handleImportCsv = async () => {
    if (!csvRows || csvRows.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments/import-csv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: csvRows }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || 'Importeren mislukt');
      setImportResult(
        `${result.data.imported} van ${csvRows.length} regel${csvRows.length === 1 ? '' : 's'} geïmporteerd` +
          (result.data.errors.length > 0 ? ` (${result.data.errors.length} waarschuwing${result.data.errors.length === 1 ? '' : 'en'}, zie details in het bestand)` : '.')
      );
      setCsvRows(null);
      setCsvOutOfRangeCount(0);
      setCsvParseWarnings([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Importeren mislukt');
    } finally {
      setImporting(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    setError(null);
    setConfirmResult(null);
    try {
      const res = await fetch(`/api/periods/${periodId}/prior-assignments/confirm`, {
        method: 'PATCH',
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error?.message || 'Bevestigen mislukt');
      setConfirmResult('Eerdere toewijzingen bevestigd.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bevestigen mislukt');
    } finally {
      setConfirming(false);
    }
  };

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">Eerdere toewijzingen laden...</div>
      </div>
    );
  }

  if (!period || !data) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 bg-red-50 border border-red-200">
          <p className="text-red-700">{error || 'Laden van eerdere toewijzingen mislukt'}</p>
        </div>
      </div>
    );
  }

  const knownCount = data.assignments.filter((a) => a.person_codenaam).length;

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <button onClick={() => router.back()} className="text-sm text-blue-700 hover:underline">
          ← Vorige
        </button>
        <h1 className="text-2xl font-bold text-neutral-900 mt-2 mb-1">Eerdere toewijzingen</h1>
        <p className="text-neutral-600">
          {period.naam} · overloopvenster {data.date_range[0]} t/m {data.date_range[1]}
        </p>
        {period.overloop_bevestigd_op && (
          <p className="text-sm text-green-700 mt-2">
            ✓ Bevestigd op {new Date(period.overloop_bevestigd_op).toLocaleString('nl-NL')}
          </p>
        )}
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {knownCount} van {data.total_entries} ingevuld{' '}
            {data.status === 'complete' ? '(alle gegevens compleet)' : '(gegevens ontbreken nog)'}
          </p>
          <button
            onClick={handleAutoDerive}
            disabled={deriving}
            className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
          >
            {deriving ? 'Bezig met afleiden...' : 'Automatisch afleiden uit vorige periode'}
          </button>
        </div>
        {/* result.data.message is a normal (200 OK) response even at 0
            derived - no previous published period, or nothing new to pull
            in are both ordinary outcomes, not errors, so this is shown
            regardless of the count instead of only surfacing a failure. */}
        {deriveInfo && <p className="text-xs text-neutral-600 mt-2">{deriveInfo}</p>}
      </div>

      {/* Fallback voor als de vorige periode zelf niet meer opvraagbaar is
          in deze applicatie (bijv. verwijderd, of een andere installatie) -
          "Automatisch afleiden" hierboven werkt alleen zolang die data hier
          nog live staat. */}
      <div className="card p-4">
        <p className="text-sm font-medium mb-1">Of: CSV-bestand uploaden</p>
        <p className="text-xs text-neutral-500 mb-3">
          Gebruik idealiter een eerder gedownload &quot;Rooster downloaden (CSV)&quot;-bestand
          (kolommen Datum, Week, Diensttype, Codenaam). Regels buiten het overloopvenster
          hierboven ({data.date_range[0]} t/m {data.date_range[1]}) worden automatisch genegeerd.
          Je hoeft dus niet zelf de juiste week eruit te knippen.
        </p>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleCsvFile(file);
            e.target.value = '';
          }}
          className="text-sm"
        />
        {csvRows !== null && (
          <div className="mt-3 p-3 rounded bg-blue-50 border border-blue-200 text-sm">
            <p className="text-blue-900">
              {csvRows.length} regel{csvRows.length === 1 ? '' : 's'} binnen het overloopvenster
              gevonden
              {csvOutOfRangeCount > 0 && `, ${csvOutOfRangeCount} daarbuiten genegeerd`}.
            </p>
            {csvParseWarnings.length > 0 && (
              <ul className="list-disc list-inside text-amber-700 mt-1 text-xs">
                {csvParseWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={handleImportCsv}
                disabled={importing || csvRows.length === 0}
                className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-400 transition-colors"
              >
                {importing ? 'Bezig…' : `${csvRows.length} regel${csvRows.length === 1 ? '' : 's'} importeren`}
              </button>
              <button
                onClick={() => {
                  setCsvRows(null);
                  setCsvOutOfRangeCount(0);
                  setCsvParseWarnings([]);
                }}
                disabled={importing}
                className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
              >
                Annuleren
              </button>
            </div>
          </div>
        )}
        {importResult && <p className="text-sm text-green-700 mt-3">✓ {importResult}</p>}
      </div>

      {error && (
        <div className="card p-4 bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
      )}
      {confirmResult && (
        <div className="card p-4 bg-green-50 border border-green-200 text-sm text-green-700">
          {confirmResult}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-100">
            <tr>
              <th className="px-3 py-2 text-left">Datum</th>
              <th className="px-3 py-2 text-left">Week</th>
              <th className="px-3 py-2 text-left">Dienst</th>
              <th className="px-3 py-2 text-left">Toegewezen aan</th>
              <th className="px-3 py-2 text-left">Bron</th>
              <th className="px-3 py-2 text-left">Acties</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.assignments.map((a) => {
              const key = `${a.datum}-${a.teller}`;
              return (
                <tr key={key} className={!a.person_codenaam ? 'bg-amber-50' : ''}>
                  <td className="px-3 py-2 font-mono">{a.datum}</td>
                  <td className="px-3 py-2">W{a.iso_week}</td>
                  <td className="px-3 py-2">{TELLER_LABELS[a.teller] || a.teller}</td>
                  <td className="px-3 py-2">
                    {a.person_codenaam || <span className="text-neutral-400 italic">Onbekend</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-600">
                    {BRON_LABELS[a.bron] || a.bron}
                  </td>
                  <td className="px-3 py-2">
                    {/* Same "Wisselen" reveal-an-inline-editor pattern as
                        AssignmentGrid.tsx's Acties column, so processing a
                        swap that already happened in real life (but isn't
                        in whatever auto-derive or a CSV produced) reads
                        the same here as it does on the live roster. */}
                    {editingKey === key ? (
                      <div className="flex items-center gap-2">
                        {/* Picking someone applies it straight away and closes
                            the editor, same as the Wisselen menu on the live roster. */}
                        <select
                          value={editCodenaam}
                          disabled={savingKey === key}
                          onChange={(e) => {
                            setEditCodenaam(e.target.value);
                            handleAssign(a.datum, a.teller, e.target.value || null);
                          }}
                          className="text-xs border border-neutral-300 rounded px-2 py-1"
                        >
                          <option value="">Onbekend</option>
                          {staff.map((s) => (
                            <option key={s.person_id} value={s.codenaam}>
                              {s.codenaam}
                            </option>
                          ))}
                        </select>
                        {savingKey === key && <span className="text-xs text-neutral-500">Bezig…</span>}
                        <button
                          onClick={() => setEditingKey(null)}
                          disabled={savingKey === key}
                          className="text-xs px-2 py-1 rounded bg-neutral-200 hover:bg-neutral-300"
                        >
                          Annuleren
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setEditingKey(key);
                          setEditCodenaam(a.person_codenaam || '');
                        }}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        Wisselen
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {data.assignments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-neutral-500">
                  Nog geen gegevens. Probeer ze automatisch af te leiden uit de vorige periode.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <button
        onClick={handleConfirm}
        disabled={confirming || data.status !== 'complete'}
        className={`w-full py-3 px-4 rounded font-semibold text-white transition-colors ${
          confirming || data.status !== 'complete'
            ? 'bg-neutral-400 cursor-not-allowed'
            : 'bg-green-600 hover:bg-green-700'
        }`}
      >
        {confirming
          ? 'Bezig met bevestigen...'
          : data.status !== 'complete'
            ? 'Vul alle gegevens in voordat je bevestigt'
            : 'Eerdere toewijzingen bevestigen'}
      </button>
    </div>
  );
}

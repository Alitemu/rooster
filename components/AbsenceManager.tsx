'use client';

/**
 * Absence Manager
 *
 * Lets a participant register their own vacation/sick leave/other absence
 * periods, mirroring ParttimePatternEditor's self-service UI. Without this,
 * dienstrooster_absence had a full API (GET/POST/PATCH/DELETE) but no
 * screen ever called it - a participant had no way to actually register an
 * absence, and lib/absenceSync.ts (which turns an absence into real
 * ABSOLUUT blocks on the relevant shifts) had nothing to sync.
 */

import { useState } from 'react';
import { addDays } from '@/lib/holidays';

export interface Absence {
  id: string;
  van_datum: string;
  tot_datum: string;
  soort: string;
  notitie?: string | null;
  // Only present when the caller passes periodId - see Props below.
  blocked_days_in_period?: number;
  total_days_in_period?: number;
  slot_dates?: string[];
  blocked_dates?: string[];
}

interface Props {
  personId: string;
  // Optional so this component still works for any future caller that
  // doesn't have one period in view. When present, each absence row shows
  // a real, DB-backed confirmation ("X van de Y dagen geblokkeerd in deze
  // periode") instead of just echoing back the dates the participant
  // typed - proof the absence actually blocked shifts, not just that it
  // saved.
  periodId?: string;
  absences: Absence[];
  defaultVanaf: string;
  defaultTot: string;
  readOnly?: boolean; // True once the period's deadline has passed - view only
  onAbsencesChange: (absences: Absence[]) => void;
}

const SOORT_LABEL: Record<string, string> = {
  VAKANTIE: 'Vakantie',
  CONGRES: 'Congres/cursus',
  OVERIG: 'Overig',
};

const emptyForm = (defaultVanaf: string, defaultTot: string) => ({
  van_datum: defaultVanaf,
  tot_datum: defaultTot,
  soort: 'VAKANTIE',
  notitie: '',
});

export function AbsenceManager({
  personId,
  periodId,
  absences,
  defaultVanaf,
  defaultTot,
  readOnly = false,
  onAbsencesChange,
}: Props) {
  const [form, setForm] = useState(emptyForm(defaultVanaf, defaultTot));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const refresh = async () => {
    const url = periodId
      ? `/api/person/${personId}/absences?period_id=${periodId}`
      : `/api/person/${personId}/absences`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      onAbsencesChange(data.data);
    }
  };

  const startEdit = (absence: Absence) => {
    setError(null);
    setWarning(null);
    setEditingId(absence.id);
    setForm({
      van_datum: absence.van_datum,
      tot_datum: absence.tot_datum,
      soort: absence.soort,
      notitie: absence.notitie || '',
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm(defaultVanaf, defaultTot));
    setError(null);
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    setWarning(null);
    try {
      const url = editingId
        ? `/api/person/${personId}/absences/${editingId}`
        : `/api/person/${personId}/absences`;
      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, notitie: form.notitie || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan van afwezigheid mislukt');
      if (data.data?.warning) setWarning(data.data.warning);

      cancelEdit();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan van afwezigheid mislukt');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (absenceId: string) => {
    setRemovingId(absenceId);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch(`/api/person/${personId}/absences/${absenceId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen van afwezigheid mislukt');

      if (editingId === absenceId) cancelEdit();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verwijderen van afwezigheid mislukt');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="card p-6 space-y-4">
      <div>
        <h3 className="font-bold text-lg mb-1">Afwezigheid opgeven</h3>
        <p className="text-sm text-neutral-600">
          Vakantie, ziekte of ander verlof: geef de periode hier op, dan wordt die automatisch
          geblokkeerd. Dit is de enige plek waar vakantiedagen vandaan komen - blokkeer ze ook
          altijd los in je voorkeurenkalender als extra controle.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>
      )}
      {warning && (
        <div className="p-3 rounded bg-amber-50 border border-amber-200 text-sm text-amber-900">{warning}</div>
      )}

      {absences.length > 0 && (
        <div className="space-y-2">
          {absences.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 p-3 rounded border border-neutral-200 bg-neutral-50 text-sm"
            >
              <div>
                <span className="font-medium">{SOORT_LABEL[a.soort] || a.soort}</span>
                <span className="text-neutral-500 text-xs block sm:inline sm:ml-2">
                  {a.van_datum} t/m {a.tot_datum}
                </span>
                {a.notitie && <span className="text-neutral-600 text-xs block sm:inline sm:ml-2">{a.notitie}</span>}
                {typeof a.total_days_in_period === 'number' && (
                  a.total_days_in_period === 0 ? (
                    <span className="text-neutral-500 text-xs block sm:inline sm:ml-2">
                      (buiten deze periode)
                    </span>
                  ) : a.blocked_days_in_period === a.total_days_in_period ? (
                    <span className="text-green-700 text-xs font-medium block sm:inline sm:ml-2">
                      ✓ {a.blocked_days_in_period} van de {a.total_days_in_period} dagen geblokkeerd in deze periode
                    </span>
                  ) : (
                    <span className="text-amber-700 text-xs font-medium block sm:inline sm:ml-2">
                      ⚠ {a.blocked_days_in_period} van de {a.total_days_in_period} dagen geblokkeerd in deze
                      periode - de rest was al om een andere reden geblokkeerd
                    </span>
                  )
                )}
              </div>
              {!readOnly && (
                <div className="flex gap-3 shrink-0">
                  <button
                    onClick={() => startEdit(a)}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  >
                    Bewerken
                  </button>
                  <button
                    onClick={() => handleDelete(a.id)}
                    disabled={removingId === a.id}
                    className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                  >
                    {removingId === a.id ? 'Bezig…' : 'Verwijderen'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {readOnly ? (
        <div className="border-t border-neutral-200 pt-4">
          <p className="text-sm text-neutral-600">
            De deadline voor deze periode is verstreken - afwezigheid is nu alleen-lezen.
          </p>
        </div>
      ) : (
        <div className="border-t border-neutral-200 pt-4 space-y-3">
          <p className="text-sm font-medium text-neutral-800">
            {editingId ? 'Afwezigheid bewerken' : 'Nieuwe afwezigheid toevoegen'}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Soort</label>
              <select
                value={form.soort}
                onChange={(e) => setForm({ ...form, soort: e.target.value })}
                className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
              >
                {Object.entries(SOORT_LABEL).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Van</label>
              <input
                type="date"
                value={form.van_datum}
                onChange={(e) => {
                  const van_datum = e.target.value;
                  // Most absences are 1-3 weeks - jump "tot en met" to the
                  // day right after "van" so there's a sensible nearby
                  // default to adjust from, instead of leaving it wherever
                  // it was (often forcing the participant to click through
                  // several months in the date picker to reach it). Only
                  // for a brand-new absence - nudging "van" while editing
                  // an existing one must not silently shrink its already-set
                  // range down to a single day.
                  const tot_datum = van_datum && !editingId ? addDays(van_datum, 1) : form.tot_datum;
                  setForm({ ...form, van_datum, tot_datum });
                }}
                className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Tot en met</label>
              <input
                type="date"
                value={form.tot_datum}
                onChange={(e) => setForm({ ...form, tot_datum: e.target.value })}
                className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-600 mb-1">Notitie (optioneel)</label>
              <input
                type="text"
                value={form.notitie}
                onChange={(e) => setForm({ ...form, notitie: e.target.value })}
                className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
              />
            </div>
          </div>
          {form.van_datum > form.tot_datum && (
            <p className="text-xs text-red-600">&quot;Van&quot; moet vóór of op &quot;tot&quot; liggen</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={handleSubmit}
              disabled={saving || !form.van_datum || !form.tot_datum || form.van_datum > form.tot_datum}
              className="px-4 py-2 rounded font-medium text-sm bg-blue-600 text-white hover:bg-blue-700
                disabled:bg-neutral-300 transition-colors"
            >
              {saving ? 'Bezig…' : editingId ? 'Wijzigen opslaan' : 'Toevoegen'}
            </button>
            {editingId && (
              <button
                onClick={() => {
                  cancelEdit();
                  setWarning(null);
                }}
                className="px-4 py-2 rounded font-medium text-sm bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
              >
                Annuleren
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


'use client';

/**
 * Part-time Pattern Editor
 *
 * Lets a participant set up their own recurring part-time day(s), rather
 * than relying on the planner to enter it for them. The API
 * (/api/person/[id]/parttime-patterns) already supported this from either
 * side; this was the missing self-service half. Sits above
 * PartTimeCheckStep in the "Deeltijd" step - that component still owns
 * reviewing the generated days and the final confirmation checkbox, this
 * one only owns the pattern(s) that feed it.
 */

import { useState } from 'react';

export interface ParttimePattern {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface Props {
  personId: string;
  patterns: ParttimePattern[];
  defaultVanaf: string;
  defaultTot: string;
  onPatternsChange: (patterns: ParttimePattern[]) => void;
}

// Full map (incl. weekend) so any pre-existing pattern still displays
// correctly. Selectable options below are deliberately narrower: a
// part-time pattern only ever means "I don't work this weekday" - weekend
// shifts are their own separate WEEKEND counter, not something a part-time
// pattern blocks.
const WEEKDAG_LABEL: Record<string, string> = {
  MA: 'Maandag',
  DI: 'Dinsdag',
  WO: 'Woensdag',
  DO: 'Donderdag',
  VR: 'Vrijdag',
  ZA: 'Zaterdag',
  ZO: 'Zondag',
};

const WEEKDAG_OPTIONS = ['MA', 'DI', 'WO', 'DO', 'VR'];

const FREQUENTIE_LABEL: Record<string, string> = {
  ELKE_WEEK: 'Elke week',
  EVEN_WEKEN: 'Even weken',
  ONEVEN_WEKEN: 'Oneven weken',
};

const emptyForm = (defaultVanaf: string, defaultTot: string) => ({
  weekdag: 'MA',
  frequentie: 'ELKE_WEEK',
  geldig_vanaf: defaultVanaf,
  geldig_tot: defaultTot,
});

export function ParttimePatternEditor({ personId, patterns, defaultVanaf, defaultTot, onPatternsChange }: Props) {
  const [form, setForm] = useState(emptyForm(defaultVanaf, defaultTot));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const res = await fetch(`/api/person/${personId}/parttime-patterns`);
    if (res.ok) {
      const data = await res.json();
      onPatternsChange(data.data);
    }
  };

  const startEdit = (pattern: ParttimePattern) => {
    setError(null);
    setEditingId(pattern.id);
    setForm({
      weekdag: pattern.weekdag,
      frequentie: pattern.frequentie,
      geldig_vanaf: pattern.geldig_vanaf,
      geldig_tot: pattern.geldig_tot,
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
    try {
      const url = editingId
        ? `/api/person/${personId}/parttime-patterns/${editingId}`
        : `/api/person/${personId}/parttime-patterns`;
      const res = await fetch(url, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan van deeltijdpatroon mislukt');

      cancelEdit();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan van deeltijdpatroon mislukt');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (patternId: string) => {
    setRemovingId(patternId);
    setError(null);
    try {
      const res = await fetch(`/api/person/${personId}/parttime-patterns/${patternId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen van deeltijdpatroon mislukt');

      if (editingId === patternId) cancelEdit();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verwijderen van deeltijdpatroon mislukt');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="card p-6 space-y-4">
      <div>
        <h3 className="font-bold text-lg mb-1">Deeltijdpatroon instellen</h3>
        <p className="text-sm text-neutral-600">
          Werk je een vaste dag (of om de week) niet? Geef dat hier op - die dagen worden dan
          automatisch geblokkeerd. Je kunt hieronder controleren of dat klopt.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>
      )}

      {patterns.length > 0 && (
        <div className="space-y-2">
          {patterns.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 p-3 rounded border border-neutral-200 bg-neutral-50 text-sm"
            >
              <div>
                <span className="font-medium">{WEEKDAG_LABEL[p.weekdag] || p.weekdag}</span>
                <span className="text-neutral-600"> · {FREQUENTIE_LABEL[p.frequentie] || p.frequentie}</span>
                <span className="text-neutral-500 text-xs block sm:inline sm:ml-2">
                  {p.geldig_vanaf} t/m {p.geldig_tot}
                </span>
              </div>
              <div className="flex gap-3 shrink-0">
                <button
                  onClick={() => startEdit(p)}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                >
                  Bewerken
                </button>
                <button
                  onClick={() => handleDelete(p.id)}
                  disabled={removingId === p.id}
                  className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {removingId === p.id ? 'Bezig…' : 'Verwijderen'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-neutral-200 pt-4 space-y-3">
        <p className="text-sm font-medium text-neutral-800">
          {editingId ? 'Patroon bewerken' : 'Nieuw patroon toevoegen'}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1">Dag</label>
            <select
              value={form.weekdag}
              onChange={(e) => setForm({ ...form, weekdag: e.target.value })}
              className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
            >
              {WEEKDAG_OPTIONS.map((code) => (
                <option key={code} value={code}>{WEEKDAG_LABEL[code]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1">Frequentie</label>
            <select
              value={form.frequentie}
              onChange={(e) => setForm({ ...form, frequentie: e.target.value })}
              className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
            >
              {Object.entries(FREQUENTIE_LABEL).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1">Vanaf</label>
            <input
              type="date"
              value={form.geldig_vanaf}
              onChange={(e) => setForm({ ...form, geldig_vanaf: e.target.value })}
              className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-600 mb-1">Tot en met</label>
            <input
              type="date"
              value={form.geldig_tot}
              onChange={(e) => setForm({ ...form, geldig_tot: e.target.value })}
              className="w-full px-2 py-2 border border-neutral-300 rounded text-sm"
            />
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleSubmit}
            disabled={saving || !form.geldig_vanaf || !form.geldig_tot}
            className="px-4 py-2 rounded font-medium text-sm bg-blue-600 text-white hover:bg-blue-700
              disabled:bg-neutral-300 transition-colors"
          >
            {saving ? 'Bezig…' : editingId ? 'Wijzigen opslaan' : 'Toevoegen'}
          </button>
          {editingId && (
            <button
              onClick={cancelEdit}
              className="px-4 py-2 rounded font-medium text-sm bg-neutral-200 text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Annuleren
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

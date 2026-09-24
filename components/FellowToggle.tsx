'use client';

/**
 * "Ik ben fellow" on the participant's preferences step (lib/fellows.ts).
 * Ticking it blocks every weekend day of the period; unticking removes
 * those blocks again. After the deadline it only shows what was chosen.
 */

import { useEffect, useState } from 'react';

interface Props {
  personId: string;
  periodId: string;
  /** Called after a change, so the calendar can show the new blocks. */
  onChanged?: () => void;
}

export function FellowToggle({ personId, periodId, onChanged }: Props) {
  const [fellow, setFellow] = useState<boolean | null>(null);
  const [uitleg, setUitleg] = useState('');
  const [wijzigbaar, setWijzigbaar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    fetch(`/api/person/${personId}/fellow?period_id=${encodeURIComponent(periodId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!current || !data?.success) return;
        setFellow(data.data.fellow);
        setUitleg(data.data.uitleg);
        setWijzigbaar(data.data.wijzigbaar);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [personId, periodId]);

  if (fellow === null) return null;

  // Ticked at once, put back if saving fails - otherwise the box sits
  // unchanged for the length of a request and looks like it didn't react.
  const toggle = async (next: boolean) => {
    setSaving(true);
    setError(null);
    setFellow(next);
    try {
      const res = await fetch(`/api/person/${personId}/fellow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: periodId, fellow: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error?.message || 'Opslaan is mislukt.');
      }
      onChanged?.();
    } catch (err) {
      setFellow(!next);
      setError(err instanceof Error ? err.message : 'Opslaan is mislukt.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-4 space-y-1">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          checked={fellow}
          disabled={saving || !wijzigbaar}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>
          <span className="font-semibold text-neutral-900">Ik ben fellow</span>
          <span className="block text-sm text-neutral-600">{uitleg}</span>
          {fellow && (
            <span className="block text-sm text-neutral-600 mt-1">
              Wil je toch een weekenddag werken? Klik die dag in de kalender dan vrij of geef er een voorkeur op.
            </span>
          )}
        </span>
      </label>
      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

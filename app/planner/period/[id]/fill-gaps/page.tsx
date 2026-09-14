/**
 * Rooster vooraf invullen (Fill Gaps) Screen
 *
 * The full per-slot "pick someone" list that used to sit directly on the
 * period dashboard, unconditionally - moved to its own page (linked via
 * FillGapsSummary's "Rooster vooraf invullen" button) so a planner opening
 * a brand new period doesn't immediately see every one of its still-empty
 * slots at once.
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { FillGapsPanel } from '@/components/FillGapsPanel';

interface Period {
  id: string;
  naam: string;
}

export default function FillGapsPage() {
  const params = useParams();
  const periodId = params.id as string;

  const [period, setPeriod] = useState<Period | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/periods/${periodId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) throw new Error(data.error?.message || 'Laden van periode mislukt');
        setPeriod(data.data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Laden van periode mislukt');
        setLoading(false);
      });
  }, [periodId]);

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">Periode laden...</div>
      </div>
    );
  }

  if (error || !period) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 bg-red-50 border border-red-200">
          <p className="text-red-700">{error || 'Periode niet gevonden'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container-main py-8 space-y-6">
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <Link
          href={`/planner/period/${periodId}`}
          className="text-sm text-blue-700 hover:underline"
        >
          ← Terug naar periode
        </Link>
        <h1 className="text-2xl font-bold text-neutral-900 mt-2 mb-1">Rooster vooraf invullen</h1>
        <p className="text-neutral-600">{period.naam}</p>
      </div>

      <FillGapsPanel periodId={periodId} />
    </div>
  );
}

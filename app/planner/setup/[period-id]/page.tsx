/**
 * Period Setup Page
 *
 * Planner-only interface for configuring a new scheduling period
 * with 7-step wizard
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { SetupWizard } from '@/components/SetupWizard';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  pool_id: string;
}

export default function SetupPage() {
  const params = useParams();
  const periodId = params['period-id'] as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);

  useEffect(() => {
    const loadPeriod = async () => {
      try {
        const res = await fetch(`/api/periods/${periodId}`);
        if (!res.ok) throw new Error('Laden van periode mislukt');

        const data = await res.json();
        setPeriod(data.data);
        setLoading(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Laden van periode mislukt';
        setError(message);
        setLoading(false);
      }
    };

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

  if (error) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Fout</h1>
          <p className="text-neutral-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!period) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <p className="text-neutral-600">Periode niet gevonden</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container-main py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-neutral-900 mb-2">Periode instellen</h1>
        <p className="text-neutral-600">Stel een nieuwe roosterperiode in en open deze</p>
      </div>

      <SetupWizard
        period={period}
        onComplete={() => {
          // Redirect to period dashboard
          window.location.href = `/planner/period/${periodId}`;
        }}
      />
    </div>
  );
}

/**
 * Read-Only Person Calendar (planner view)
 *
 * Lets a planner click through from "Status personeel" on the period
 * dashboard to see exactly what a participant sees in their own
 * Voorkeuren-kalender - purely for insight, never editable from here.
 * Reuses PreferencesCalendar in readOnly mode: it fetches the same
 * preferences/coverage data a participant's own page does, and
 * requirePersonAccess already allows any ADMIN/PLANNER to read another
 * person's preferences (see lib/auth-context.ts), so no new API route is
 * needed for this.
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { PreferencesCalendar } from '@/components/PreferencesCalendar';

interface Period {
  id: string;
  naam: string;
  pool_id: string;
}

interface PoolMember {
  person_id: string;
  codenaam: string;
}

export default function PersonCalendarPage() {
  const params = useParams();
  const periodId = params.id as string;
  const personId = params.personId as string;

  const [period, setPeriod] = useState<Period | null>(null);
  const [codenaam, setCodenaam] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const periodRes = await fetch(`/api/periods/${periodId}`);
        if (!periodRes.ok) throw new Error('Laden van periode mislukt');
        const periodData = await periodRes.json();
        setPeriod(periodData.data);

        if (periodData.data?.pool_id) {
          const membersRes = await fetch(`/api/planner/pool/${periodData.data.pool_id}/members`);
          if (membersRes.ok) {
            const membersData = await membersRes.json();
            const member = (membersData.data || []).find(
              (m: PoolMember) => m.person_id === personId
            );
            setCodenaam(member?.codenaam ?? null);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Laden mislukt');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [periodId, personId]);

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center text-neutral-600">Kalender laden...</div>
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
        <h1 className="text-2xl font-bold text-neutral-900 mt-2 mb-1">
          {codenaam || 'Medewerker'}
        </h1>
        <p className="text-neutral-600">{period.naam} · alleen-lezen overzicht</p>
      </div>

      <div className="card p-6">
        <PreferencesCalendar personId={personId} periodId={periodId} readOnly />
      </div>
    </div>
  );
}

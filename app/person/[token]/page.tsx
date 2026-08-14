/**
 * Personal Link Page - Preferences Entry
 *
 * Staff access via personal link (token)
 * Shows preferences calendar, part-time verification, and confirmation flow
 */

'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import { PreferencesCalendar } from '@/components/PreferencesCalendar';
import { PartTimeCheckStep } from '@/components/PartTimeCheckStep';
import { PreferencesConfirmation } from '@/components/PreferencesConfirmation';
import { PersonalRosterView } from '@/components/PersonalRosterView';
import { NotificationCenter } from '@/components/NotificationCenter';

type Step = 'calendar' | 'parttime' | 'confirmation' | 'submitted' | 'roster';

interface Period {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
}

interface RosterData {
  person: { id: string; codenaam: string };
  period: { id: string; naam: string; start_datum: string; eind_datum: string; gepubliceerd_op: string };
  assignments: Array<{
    id: string;
    slot_id: string;
    datum: string;
    iso_week: number;
    shift_type_id: string;
    aangemaakt_op: string;
  }>;
  summary: {
    total_assignments: number;
    by_shift_type: Record<string, number>;
    balances: Record<string, number>;
  };
}

interface ParttimePattern {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface BlockedDaysSummary {
  AVOND: number;
  WEEKEND: number;
  FEESTDAG: number;
  total: number;
}

export default function PersonalLinkPage() {
  const params = useParams();
  const token = params.token as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<Step>('calendar');
  const [personId, setPersonId] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [patterns, setPatterns] = useState<ParttimePattern[]>([]);
  const [rosterData, setRosterData] = useState<RosterData | null>(null);
  const [blockedDays] = useState<BlockedDaysSummary>({
    AVOND: 0,
    WEEKEND: 0,
    FEESTDAG: 0,
    total: 0,
  });
  const [parttimeConfirmed, setParttimeConfirmed] = useState(false);
  const [_preferencesChanged, setPreferencesChanged] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // Verify token and load person data
  useEffect(() => {
    const verifyToken = async () => {
      try {
        // Validate token format and fetch person info
        const res = await fetch(`/api/auth/verify-link?token=${encodeURIComponent(token)}`);
        if (!res.ok) {
          throw new Error('Invalid or expired access link');
        }

        const data = await res.json();
        const { person_id, period_id } = data.data;

        setPersonId(person_id);

        // Fetch period details
        const periodRes = await fetch(`/api/periods/${period_id}`);
        if (!periodRes.ok) throw new Error('Failed to load period');

        const periodData = await periodRes.json();
        const periodInfo = periodData.data;
        setPeriod(periodInfo);

        // If period is published, load roster; otherwise load patterns
        if (periodInfo.status === 'GEPUBLICEERD') {
          const rosterRes = await fetch(`/api/person/${person_id}/roster/${period_id}`);
          if (rosterRes.ok) {
            const rosterInfo = await rosterRes.json();
            setRosterData(rosterInfo.data);
            setCurrentStep('roster');
          }
        } else {
          // Fetch part-time patterns for preference entry
          const patternsRes = await fetch(`/api/person/${person_id}/parttime-patterns`);
          if (patternsRes.ok) {
            const patternsData = await patternsRes.json();
            setPatterns(patternsData.data);
          }
        }

        setLoading(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load preferences';
        setError(message);
        setLoading(false);
      }
    };

    verifyToken();
  }, [token]);


  const handleSubmitSuccess = () => {
    setCurrentStep('submitted');
  };

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center">
          <p className="text-lg text-neutral-600">Loading preferences...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Access Error</h1>
          <p className="text-neutral-700 mb-6">{error}</p>
          <p className="text-sm text-neutral-600">
            If you received this link in an email, please check that the URL is complete and correct.
            The link may have expired. Contact your scheduler for a new link.
          </p>
        </div>
      </div>
    );
  }

  if (!period || !personId) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <p className="text-neutral-600">Failed to load period information</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container-main py-8 space-y-6">
      {/* Header */}
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-neutral-900 mb-2">
              {period.naam}
            </h1>
            <p className="text-neutral-600 mb-4">
              {new Date(period.start_datum).toLocaleDateString()} to{' '}
              {new Date(period.eind_datum).toLocaleDateString()}
            </p>
            <p className="text-sm text-neutral-600">
              Deadline: {new Date(period.deadline).toLocaleString()}
            </p>
          </div>
          {period.status === 'GEPUBLICEERD' && (
            <button
              onClick={() => setNotificationsOpen(!notificationsOpen)}
              className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm"
            >
              🔔 Notifications
            </button>
          )}
        </div>
      </div>

      {/* Notifications Panel */}
      {period.status === 'GEPUBLICEERD' && notificationsOpen && personId && (
        <div className="card p-4 bg-blue-50 border border-blue-200">
          <button
            onClick={() => setNotificationsOpen(false)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium mb-3"
          >
            Close Notifications
          </button>
          <NotificationCenter personId={personId} />
        </div>
      )}

      {/* Pre-published: Step indicator and preferences entry */}
      {period.status !== 'GEPUBLICEERD' && (
        <div className="flex gap-2 justify-center">
          {(['calendar', 'parttime', 'confirmation', 'submitted'] as const).map((step) => (
            <button
              key={step}
              onClick={() => step !== 'submitted' && setCurrentStep(step)}
              disabled={step === 'submitted'}
              className={`px-4 py-2 rounded font-medium text-sm transition-colors
                ${currentStep === step
                  ? 'bg-blue-600 text-white'
                  : currentStep === 'submitted'
                    ? 'bg-green-100 text-green-800'
                    : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'}`}
            >
              {step === 'calendar' && '📅 Preferences'}
              {step === 'parttime' && '⏰ Part-time'}
              {step === 'confirmation' && '✓ Confirm'}
              {step === 'submitted' && '✅ Submitted'}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      {period.status === 'GEPUBLICEERD' && rosterData && personId && (
        <PersonalRosterView
          personId={personId}
          periodId={period.id}
          assignedShifts={rosterData.assignments.map((a) => ({
            datum: a.datum,
            iso_week: a.iso_week,
            teller: a.shift_type_id,
          }))}
          balances={[
            {
              counter: 'AVOND',
              current: rosterData.summary.balances['AVOND'] || 0,
              target_min: 0,
              target_max: 0,
              message: `${rosterData.summary.by_shift_type['AVOND'] || 0} evening shifts assigned`,
            },
            {
              counter: 'WEEKEND',
              current: rosterData.summary.balances['WEEKEND'] || 0,
              target_min: 0,
              target_max: 0,
              message: `${rosterData.summary.by_shift_type['WEEKEND'] || 0} weekend shifts assigned`,
            },
            {
              counter: 'FEESTDAG',
              current: rosterData.summary.balances['FEESTDAG'] || 0,
              target_min: 0,
              target_max: 0,
              message: `${rosterData.summary.by_shift_type['FEESTDAG'] || 0} holiday shifts assigned`,
            },
          ]}
          softBlockViolations={[]}
          holidayHistory={[]}
        />
      )}

      {period.status !== 'GEPUBLICEERD' && currentStep === 'calendar' && (
        <div className="space-y-4">
          <PreferencesCalendar
            personId={personId}
            periodId={period.id}
            onPreferencesChange={setPreferencesChanged}
            onCoverageUpdate={() => {}}
          />
          <button
            onClick={() => setCurrentStep('parttime')}
            className="w-full py-3 px-4 rounded font-semibold bg-blue-600
                       text-white hover:bg-blue-700 active:bg-blue-800
                       transition-colors"
          >
            Next: Review Part-time Days
          </button>
        </div>
      )}

      {period.status !== 'GEPUBLICEERD' && currentStep === 'parttime' && (
        <div className="space-y-4">
          <PartTimeCheckStep
            patterns={patterns}
            onConfirm={setParttimeConfirmed}
          />
          <div className="flex gap-3">
            <button
              onClick={() => setCurrentStep('calendar')}
              className="flex-1 py-3 px-4 rounded font-semibold bg-neutral-200
                         text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setCurrentStep('confirmation')}
              disabled={!parttimeConfirmed}
              className={`flex-1 py-3 px-4 rounded font-semibold text-white
                transition-colors
                ${parttimeConfirmed
                  ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800'
                  : 'bg-neutral-400 cursor-not-allowed'}`}
            >
              Next: Confirm
            </button>
          </div>
        </div>
      )}

      {period.status !== 'GEPUBLICEERD' && currentStep === 'confirmation' && (
        <div className="space-y-4">
          <PreferencesConfirmation
            personId={personId}
            periodId={period.id}
            blockedDays={blockedDays}
            parttimeConfirmed={parttimeConfirmed}
            onSubmit={handleSubmitSuccess}
          />
          <button
            onClick={() => setCurrentStep('parttime')}
            className="w-full py-3 px-4 rounded font-semibold bg-neutral-200
                       text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            Back
          </button>
        </div>
      )}

      {period.status !== 'GEPUBLICEERD' && currentStep === 'submitted' && (
        <div className="card p-8 bg-green-50 border-2 border-green-300 text-center space-y-4">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-green-900">Preferences Submitted</h2>
          <p className="text-green-800">
            Your preferences have been successfully submitted. You will receive a confirmation
            email shortly.
          </p>
          <p className="text-sm text-green-700">
            You can close this window. The scheduler will generate the roster based on all
            submitted preferences.
          </p>
        </div>
      )}
    </div>
  );
}

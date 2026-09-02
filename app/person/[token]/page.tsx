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
import { ParttimePatternEditor } from '@/components/ParttimePatternEditor';
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
    teller: string;
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

interface VoorkeurDaysSummary {
  total: number;
}

interface SoftBlockViolation {
  datum: string;
  teller: string;
  date_str: string;
}

export default function PersonalLinkPage() {
  const params = useParams();
  const token = params.token as string;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<Step>('parttime');
  const [personId, setPersonId] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [patterns, setPatterns] = useState<ParttimePattern[]>([]);
  const [rosterData, setRosterData] = useState<RosterData | null>(null);
  const [blockedDays, setBlockedDays] = useState<BlockedDaysSummary>({
    AVOND: 0,
    WEEKEND: 0,
    FEESTDAG: 0,
    total: 0,
  });
  const [voorkeurDays, setVoorkeurDays] = useState<VoorkeurDaysSummary>({ total: 0 });
  const [softBlockViolations, setSoftBlockViolations] = useState<SoftBlockViolation[]>([]);
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
          throw new Error('Ongeldige of verlopen toegangslink');
        }

        const data = await res.json();
        const { person_id, period_id } = data.data;

        setPersonId(person_id);

        // Fetch period details
        const periodRes = await fetch(`/api/periods/${period_id}`);
        if (!periodRes.ok) throw new Error('Kon periode niet laden');

        const periodData = await periodRes.json();
        const periodInfo = periodData.data;
        setPeriod(periodInfo);

        // If period is published, load roster; otherwise load patterns
        if (periodInfo.status === 'GEPUBLICEERD') {
          const [rosterRes, preferencesRes] = await Promise.all([
            fetch(`/api/person/${person_id}/roster/${period_id}`),
            fetch(`/api/person/${person_id}/preferences/${period_id}`),
          ]);

          if (rosterRes.ok) {
            const rosterInfo = await rosterRes.json();
            setRosterData(rosterInfo.data);
            setCurrentStep('roster');

            if (preferencesRes.ok) {
              const preferencesInfo = await preferencesRes.json();
              const lieverNietSlotIds = new Set(
                preferencesInfo.data.preferences
                  .filter((p: { blocking_level: string | null }) => p.blocking_level === 'LIEVER_NIET')
                  .map((p: { slot_id: string }) => p.slot_id)
              );
              const violations: SoftBlockViolation[] = rosterInfo.data.assignments
                .filter((a: { slot_id: string }) => lieverNietSlotIds.has(a.slot_id))
                .map((a: { datum: string; teller: string }) => ({
                  datum: a.datum,
                  teller: a.teller,
                  date_str: new Date(a.datum).toLocaleDateString(),
                }));
              setSoftBlockViolations(violations);
            }
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
        const message = err instanceof Error ? err.message : 'Kon voorkeuren niet laden';
        setError(message);
        setLoading(false);
      }
    };

    verifyToken();
  }, [token]);

  // Recompute the blocked-days summary from the real preferences whenever
  // the confirmation step is reached, so it reflects whatever was just set
  // in the calendar step.
  useEffect(() => {
    if (currentStep !== 'confirmation' || !personId || !period) return;

    const loadBlockedDays = async () => {
      try {
        const res = await fetch(`/api/person/${personId}/preferences/${period.id}`);
        if (!res.ok) return;
        const data = await res.json();

        const summary: BlockedDaysSummary = { AVOND: 0, WEEKEND: 0, FEESTDAG: 0, total: 0 };
        let voorkeurCount = 0;
        for (const pref of data.data.preferences as Array<{ teller: string; blocking_level: string | null }>) {
          if (pref.blocking_level === 'VOORKEUR') {
            voorkeurCount++;
            continue;
          }
          if (pref.blocking_level !== 'ABSOLUUT') continue;
          if (pref.teller in summary) {
            summary[pref.teller as 'AVOND' | 'WEEKEND' | 'FEESTDAG']++;
            summary.total++;
          }
        }
        setBlockedDays(summary);
        setVoorkeurDays({ total: voorkeurCount });
      } catch {
        // Leave the previous summary in place on failure
      }
    };

    loadBlockedDays();
  }, [currentStep, personId, period]);

  const handleSubmitSuccess = () => {
    setCurrentStep('submitted');
  };

  if (loading) {
    return (
      <div className="container-main py-12">
        <div className="card p-8 text-center">
          <p className="text-lg text-neutral-600">Voorkeuren laden...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Toegangsfout</h1>
          <p className="text-neutral-700 mb-6">{error}</p>
          <p className="text-sm text-neutral-600">
            Controleer of de URL volledig en juist is als je deze link via e-mail hebt gekregen.
            De link kan verlopen zijn. Neem contact op met de roosteraar voor een nieuwe link.
          </p>
        </div>
      </div>
    );
  }

  if (!period || !personId) {
    return (
      <div className="container-main py-12">
        <div className="card p-8">
          <p className="text-neutral-600">Kon periode-informatie niet laden</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container-main py-8 space-y-6">
      {/* Header */}
      <div className="card p-6 bg-gradient-to-r from-blue-50 to-neutral-50">
        {/* Stacks on narrow screens; side by side the button cannot shrink
            and pushed the header past a 375px viewport. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold text-neutral-900 mb-2 break-words">
              {period.naam}
            </h1>
            <p className="text-neutral-600 mb-4">
              {new Date(period.start_datum).toLocaleDateString()} t/m{' '}
              {new Date(period.eind_datum).toLocaleDateString()}
            </p>
            <p className="text-sm text-neutral-600">
              Deadline: {new Date(period.deadline).toLocaleString()}
            </p>
          </div>
          {period.status === 'GEPUBLICEERD' && (
            <button
              onClick={() => setNotificationsOpen(!notificationsOpen)}
              className="shrink-0 self-start px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm"
            >
              🔔 Meldingen
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
            Meldingen sluiten
          </button>
          <NotificationCenter personId={personId} />
        </div>
      )}

      {/* Pre-published: Step indicator and preferences entry */}
      {period.status !== 'GEPUBLICEERD' && (
        <div className="flex gap-2 justify-center">
          {(['parttime', 'calendar', 'confirmation', 'submitted'] as const).map((step) => (
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
              {step === 'calendar' && '📅 Voorkeuren'}
              {step === 'parttime' && '⏰ Deeltijd'}
              {step === 'confirmation' && '✓ Bevestigen'}
              {step === 'submitted' && '✅ Ingediend'}
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
            teller: a.teller,
          }))}
          balances={[
            {
              counter: 'AVOND',
              current: rosterData.summary.balances['AVOND'] || 0,
              target_min: 0,
              target_max: 0,
              message: `${rosterData.summary.by_shift_type['AVOND'] || 0} avonddiensten toegewezen`,
            },
            {
              counter: 'WEEKEND',
              current: rosterData.summary.balances['WEEKEND'] || 0,
              target_min: 0,
              target_max: 0,
              message: `${rosterData.summary.by_shift_type['WEEKEND'] || 0} weekenddiensten toegewezen`,
            },
            {
              counter: 'FEESTDAG',
              current: rosterData.summary.balances['FEESTDAG'] || 0,
              target_min: 0,
              target_max: 0,
              message: `${rosterData.summary.by_shift_type['FEESTDAG'] || 0} feestdagdiensten toegewezen`,
            },
          ]}
          softBlockViolations={softBlockViolations}
        />
      )}

      {/* Deeltijddagen komen eerst: welke dagen automatisch geblokkeerd
          worden staat dan al vast voordat je de voorkeurenkalender ziet,
          in plaats van dat je halverwege moet terugspringen om dat nog te
          controleren. */}
      {period.status !== 'GEPUBLICEERD' && currentStep === 'parttime' && (
        <div className="space-y-4">
          <ParttimePatternEditor
            personId={personId}
            patterns={patterns}
            defaultVanaf={period.start_datum}
            defaultTot={period.eind_datum}
            onPatternsChange={(next) => {
              setPatterns(next);
              // A changed pattern means the generated days below may have
              // changed too - make the participant look at them again
              // rather than carrying over a confirmation that no longer
              // matches what they just edited.
              setParttimeConfirmed(false);
            }}
          />
          <PartTimeCheckStep
            key={patterns.map((p) => `${p.id}:${p.weekdag}:${p.frequentie}:${p.geldig_vanaf}:${p.geldig_tot}`).join(',')}
            personId={personId}
            periodId={period.id}
            periodStart={period.start_datum}
            periodEnd={period.eind_datum}
            periodStatus={period.status}
            patterns={patterns}
            onConfirm={setParttimeConfirmed}
          />
          <button
            onClick={() => setCurrentStep('calendar')}
            disabled={!parttimeConfirmed}
            className={`w-full py-3 px-4 rounded font-semibold text-white
              transition-colors
              ${parttimeConfirmed
                ? 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800'
                : 'bg-neutral-400 cursor-not-allowed'}`}
          >
            Volgende: voorkeuren opgeven
          </button>
        </div>
      )}

      {period.status !== 'GEPUBLICEERD' && currentStep === 'calendar' && (
        <div className="space-y-4">
          <PreferencesCalendar
            personId={personId}
            periodId={period.id}
            onPreferencesChange={setPreferencesChanged}
            onCoverageUpdate={() => {}}
          />
          <div className="flex gap-3">
            <button
              onClick={() => setCurrentStep('parttime')}
              className="flex-1 py-3 px-4 rounded font-semibold bg-neutral-200
                         text-neutral-900 hover:bg-neutral-300 transition-colors"
            >
              Terug
            </button>
            <button
              onClick={() => setCurrentStep('confirmation')}
              className="flex-1 py-3 px-4 rounded font-semibold bg-blue-600
                         text-white hover:bg-blue-700 active:bg-blue-800
                         transition-colors"
            >
              Volgende: bevestigen
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
            voorkeurDays={voorkeurDays.total}
            parttimeConfirmed={parttimeConfirmed}
            onSubmit={handleSubmitSuccess}
          />
          <button
            onClick={() => setCurrentStep('calendar')}
            className="w-full py-3 px-4 rounded font-semibold bg-neutral-200
                       text-neutral-900 hover:bg-neutral-300 transition-colors"
          >
            Terug
          </button>
        </div>
      )}

      {period.status !== 'GEPUBLICEERD' && currentStep === 'submitted' && (
        <div className="card p-8 bg-green-50 border-2 border-green-300 text-center space-y-4">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-2xl font-bold text-green-900">Voorkeuren ingediend</h2>
          <p className="text-green-800">
            Je voorkeuren zijn succesvol ingediend.
          </p>
          <p className="text-sm text-green-700">
            Je kunt dit venster sluiten. De roosteraar genereert het rooster op basis van alle
            ingediende voorkeuren.
          </p>
        </div>
      )}
    </div>
  );
}

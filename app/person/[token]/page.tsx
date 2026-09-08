/**
 * Personal Link Page - Preferences Entry
 *
 * Staff access via personal link (token)
 * Shows preferences calendar, part-time verification, and confirmation flow
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { PreferencesCalendar } from '@/components/PreferencesCalendar';
import { PartTimeCheckStep } from '@/components/PartTimeCheckStep';
import { ParttimePatternEditor } from '@/components/ParttimePatternEditor';
import { AbsenceManager, type Absence } from '@/components/AbsenceManager';
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
    target_bands: Record<string, { min: number; max: number }>;
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
  // Separate from `error` (which means "the link itself is invalid/expired"
  // and shows advice to that effect) - a mid-flow data fetch failing after
  // the link was already verified is a different situation, and showing
  // "your link may have expired" for a transient server error would send
  // the participant chasing a new link they don't actually need.
  const [dataLoadWarning, setDataLoadWarning] = useState<string | null>(null);
  // Whether `error` (if set) means the link itself is bad, vs. a later
  // fetch in the same flow failing after the link was already verified -
  // only the former should tell the participant their link may have
  // expired.
  const [isLinkError, setIsLinkError] = useState(true);
  const [currentStep, setCurrentStep] = useState<Step>('parttime');
  const [personId, setPersonId] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [patterns, setPatterns] = useState<ParttimePattern[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
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

  // Nothing on this page reacts to a coverage update, but a fresh inline
  // `() => {}` on every render would still change PreferencesCalendar's
  // `onCoverageUpdate` prop identity each time, re-firing its coverage
  // fetch effect on every unrelated parent re-render instead of only when
  // personId/periodId actually change (see that effect's useCallback
  // deps). A stable no-op avoids that.
  const noopCoverageUpdate = useCallback(() => {}, []);

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
        setIsLinkError(false);

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
                  date_str: new Date(a.datum).toLocaleDateString('nl-NL'),
                }));
              setSoftBlockViolations(violations);
            } else {
              // Not fatal for the roster view itself, but "liever niet"
              // violations silently staying empty here would look
              // identical to "no violations" - the participant has no way
              // to tell those apart, so say so explicitly instead.
              setDataLoadWarning(
                'Kon niet controleren of er diensten zijn toegewezen op dagen die je liever niet wilde werken.'
              );
            }
          } else {
            // The roster is the entire point of this step - without it
            // there is nothing useful left to show, so this is fatal.
            throw new Error('Kon je rooster niet laden. Probeer de pagina te vernieuwen.');
          }
        } else {
          // Fetch part-time patterns and absences for preference entry
          const [patternsRes, absencesRes] = await Promise.all([
            fetch(`/api/person/${person_id}/parttime-patterns`),
            fetch(`/api/person/${person_id}/absences`),
          ]);
          const failedParts: string[] = [];
          if (patternsRes.ok) {
            const patternsData = await patternsRes.json();
            setPatterns(patternsData.data);
          } else {
            failedParts.push('je eerder opgegeven deeltijdpatroon');
          }
          if (absencesRes.ok) {
            const absencesData = await absencesRes.json();
            setAbsences(absencesData.data);
          } else {
            failedParts.push('je eerder opgegeven afwezigheden');
          }
          if (failedParts.length > 0) {
            // These pre-fill an existing state rather than being required
            // to proceed, so this shouldn't block the flow - but silently
            // leaving them empty would look identical to "nothing was ever
            // saved" and risk the participant re-entering (or skipping)
            // something that was already there.
            setDataLoadWarning(
              `Kon ${failedParts.join(' en ')} niet laden - mogelijk niet up-to-date hieronder. Probeer de pagina te vernieuwen.`
            );
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
          <h1 className="text-2xl font-bold text-red-600 mb-4">
            {isLinkError ? 'Toegangsfout' : 'Laden mislukt'}
          </h1>
          <p className="text-neutral-700 mb-6">{error}</p>
          {isLinkError && (
            <p className="text-sm text-neutral-600">
              Controleer of de URL volledig en juist is als je deze link via e-mail hebt gekregen.
              De link kan verlopen zijn. Neem contact op met de roosteraar voor een nieuwe link.
            </p>
          )}
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

  // Deadline is the actual cutoff for input, independent of whether the
  // planner has gotten around to closing the period yet - see
  // lib/periodInputGate.ts, which the server-side routes enforce this
  // same way. Viewing what was entered is never blocked, only changing it.
  const deadlinePassed = period.status !== 'GEPUBLICEERD' && new Date() > new Date(period.deadline);

  // The sync from preferences/absences/deeltijd into the solver's input
  // only runs while a period is OPEN (lib/absenceSync.ts, lib/parttimeSync.ts)
  // - once a roster has been generated, a change saved here is stored but
  // has no effect on the already-generated roster until the planner
  // regenerates it by hand. Distinct from deadlinePassed: the deadline may
  // still be in the future, so the form stays editable, but a save here
  // would otherwise look like it "took" with no indication that it hasn't
  // actually reached the roster yet.
  const rosterAlreadyGenerated = period.status === 'GEGENEREERD';

  return (
    <div className="container-main py-8 space-y-6">
      {dataLoadWarning && (
        <div className="card p-4 bg-amber-50 border border-amber-200 text-sm text-amber-900">
          {dataLoadWarning}
        </div>
      )}

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
              {new Date(period.start_datum).toLocaleDateString('nl-NL')} t/m{' '}
              {new Date(period.eind_datum).toLocaleDateString('nl-NL')}
            </p>
            <p className="text-sm text-neutral-600">
              Deadline: {new Date(period.deadline).toLocaleString('nl-NL')}
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

      {deadlinePassed && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-900">
            ⏰ De deadline voor deze periode is verstreken. Je kunt hieronder nog zien wat je hebt
            ingevuld, maar wijzigen kan niet meer.
          </p>
        </div>
      )}

      {!deadlinePassed && rosterAlreadyGenerated && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <p className="text-sm text-amber-900">
            ⚠️ Het rooster voor deze periode is al gegenereerd. Wijzigingen die je nu opslaat,
            worden bewaard, maar tellen pas mee als de planner het rooster opnieuw genereert.
          </p>
        </div>
      )}

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
              assigned: rosterData.summary.by_shift_type['AVOND'] || 0,
              target_min: rosterData.summary.target_bands['AVOND']?.min ?? 0,
              target_max: rosterData.summary.target_bands['AVOND']?.max ?? 0,
              message: `${rosterData.summary.by_shift_type['AVOND'] || 0} avonddiensten toegewezen`,
            },
            {
              counter: 'WEEKEND',
              assigned: rosterData.summary.by_shift_type['WEEKEND'] || 0,
              target_min: rosterData.summary.target_bands['WEEKEND']?.min ?? 0,
              target_max: rosterData.summary.target_bands['WEEKEND']?.max ?? 0,
              message: `${rosterData.summary.by_shift_type['WEEKEND'] || 0} weekenddiensten toegewezen`,
            },
            {
              counter: 'FEESTDAG',
              assigned: rosterData.summary.by_shift_type['FEESTDAG'] || 0,
              target_min: rosterData.summary.target_bands['FEESTDAG']?.min ?? 0,
              target_max: rosterData.summary.target_bands['FEESTDAG']?.max ?? 0,
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
            readOnly={deadlinePassed}
            onPatternsChange={(next) => {
              setPatterns(next);
              // A changed pattern means the generated days below may have
              // changed too - make the participant look at them again
              // rather than carrying over a confirmation that no longer
              // matches what they just edited.
              setParttimeConfirmed(false);
            }}
          />
          <AbsenceManager
            personId={personId}
            absences={absences}
            defaultVanaf={period.start_datum}
            defaultTot={period.eind_datum}
            readOnly={deadlinePassed}
            onAbsencesChange={setAbsences}
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
            readOnly={deadlinePassed}
            onPreferencesChange={setPreferencesChanged}
            onCoverageUpdate={noopCoverageUpdate}
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
            readOnly={deadlinePassed}
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
            {deadlinePassed
              ? `Je kunt dit venster sluiten. De deadline (${new Date(period.deadline).toLocaleString('nl-NL')}) is verstreken, dus wijzigen kan niet meer.`
              : `Je kunt dit venster sluiten - maar je kunt ook nog iets aanpassen: zolang de deadline (${new Date(period.deadline).toLocaleString('nl-NL')}) niet verstreken is, tellen je laatste wijzigingen automatisch mee bij het maken van het rooster. Je hoeft daarvoor niet opnieuw in te dienen.`}
          </p>
          <button
            onClick={() => setCurrentStep('calendar')}
            className="px-4 py-2 rounded font-medium bg-white border border-green-300 text-green-900 hover:bg-green-100 transition-colors"
          >
            {deadlinePassed ? 'Ingevoerde voorkeuren bekijken' : 'Voorkeuren aanpassen'}
          </button>
        </div>
      )}
    </div>
  );
}

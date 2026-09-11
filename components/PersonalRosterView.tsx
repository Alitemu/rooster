'use client';

/**
 * Personal Roster View Component
 *
 * Displays assigned shifts after publication/deadline.
 * Shows balance in human-readable words.
 * Highlights soft-blocked days (prefer-not) that were assigned.
 * Mobile-responsive calendar view.
 * Includes shift swap request functionality.
 */

import { useState, useEffect } from 'react';
import { parseISO } from '@/lib/holidays';
import { SwapRequestDialog } from './SwapRequestDialog';
import { SwapManagementPanel } from './SwapManagementPanel';

interface AssignedShift {
  datum: string;
  iso_jaar: number;
  iso_week: number;
  teller: string; // AVOND, WEEKEND, FEESTDAG
}

interface BalanceDisplay {
  counter: string; // Evening, Weekend, Holiday
  assigned: number;
  target_min: number;
  target_max: number;
  message: string; // e.g., "1 fewer evening shifts" or "8 or 9 evening shifts"
}

interface SoftBlockViolation {
  datum: string;
  teller: string;
  date_str: string;
}

interface Props {
  personId: string;
  periodId: string;
  assignedShifts: AssignedShift[];
  balances: BalanceDisplay[];
  softBlockViolations?: SoftBlockViolation[];
  // A hard block (ABSOLUUT) the planner knowingly overrode by hand - a
  // materially different situation from softBlockViolations (LIEVER_NIET,
  // never a hard rule to begin with), so shown as its own, more urgent
  // notice rather than folded into the same list.
  blockedOverrideViolations?: SoftBlockViolation[];
}

interface WeekGroup {
  isoJaar: number;
  isoWeek: number;
  shifts: string[];
}

export function PersonalRosterView({
  personId,
  periodId,
  assignedShifts,
  balances,
  softBlockViolations = [],
  blockedOverrideViolations = [],
}: Props) {
  const [weekView, setWeekView] = useState<Map<string, WeekGroup>>(new Map());
  const [swapDialogOpen, setSwapDialogOpen] = useState(false);
  const [showSwapManagement, setShowSwapManagement] = useState(false);
  const [swapSuccessMessage, setSwapSuccessMessage] = useState(false);

  // Group shifts by ISO week - keyed on (iso_jaar, iso_week) together, not
  // iso_week alone: a period spanning a year boundary (e.g. October to
  // March) reuses week numbers 1-12 from the new year right after week
  // 40-52 of the old one, so week alone can't tell two different weeks
  // apart or sort them correctly (a plain numeric sort put January before
  // December).
  useEffect(() => {
    const grouped = new Map<string, WeekGroup>();

    for (const shift of assignedShifts) {
      const key = `${shift.iso_jaar}-${shift.iso_week}`;
      if (!grouped.has(key)) {
        grouped.set(key, { isoJaar: shift.iso_jaar, isoWeek: shift.iso_week, shifts: [] });
      }
      grouped.get(key)!.shifts.push(`${shift.datum}/${shift.teller}`);
    }

    setWeekView(grouped);
  }, [assignedShifts]);

  // Map counter type to display name
  const counterDisplayName: Record<string, string> = {
    AVOND: 'Avond',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Feestdag',
  };

  const counterPluralLower: Record<string, string> = {
    AVOND: 'avonddiensten',
    WEEKEND: 'weekenddiensten',
    FEESTDAG: 'feestdagdiensten',
  };

  // "8 of 9 avonddiensten" rather than a raw "8–9" range or tuple - CLAUDE.md
  // is explicit that a balance/band is always expressed in words, never as
  // a bare number or [min,max] pair.
  const targetRangeLabel = (balance: BalanceDisplay): string => {
    const noun = counterPluralLower[balance.counter] || balance.counter.toLowerCase();
    return balance.target_min === balance.target_max
      ? `${balance.target_min} ${noun}`
      : `${balance.target_min} of ${balance.target_max} ${noun}`;
  };

  const softBlockSet = new Set(
    softBlockViolations.map((v) => `${v.datum}/${v.teller}`)
  );
  const blockedOverrideSet = new Set(
    blockedOverrideViolations.map((v) => `${v.datum}/${v.teller}`)
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-neutral-900 mb-2">Jouw rooster</h2>
        <p className="text-neutral-600">
          Toegewezen diensten voor deze periode, op basis van je voorkeuren en beschikbaarheid
        </p>
      </div>

      {/* Balance summary */}
      <div className="card p-6 space-y-4">
        <h3 className="font-bold text-lg">Overzicht saldo</h3>
        <div className="space-y-3">
          {balances.map((balance) => (
            <div key={balance.counter} className="flex items-start gap-4 pb-3 border-b last:border-b-0">
              <div className="font-semibold text-neutral-800 w-24">
                {counterDisplayName[balance.counter] || balance.counter}
              </div>
              <div className="flex-1">
                <p className="text-neutral-900 font-medium mb-1">
                  {balance.message}
                </p>
                <p className="text-xs text-neutral-600">
                  Streefbereik: je krijgt {targetRangeLabel(balance)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Overruled hard-block warning - shown before the softer "liever
          niet" notice below since this is the more urgent of the two: it
          was supposed to be impossible, and the planner made a deliberate
          exception (see manual-assign's BLOCKED_OVERRIDE/PARTTIME_OVERRIDE). */}
      {blockedOverrideViolations.length > 0 && (
        <div className="card p-4 bg-red-50 border-2 border-red-300">
          <div className="flex gap-3">
            <span className="text-xl">🚫</span>
            <div>
              <p className="font-semibold text-red-900">
                Ingedeeld op een dag die je had geblokkeerd
              </p>
              <p className="text-sm text-red-800 mt-1">
                De roosteraar heeft je bewust ingedeeld op {blockedOverrideViolations.length}{' '}
                dag(en) die je had geblokkeerd. Neem contact op met de roosteraar als dit niet
                klopt.
              </p>
              <ul className="text-sm text-red-800 mt-2 space-y-1">
                {blockedOverrideViolations.slice(0, 5).map((v) => (
                  <li key={`${v.datum}-${v.teller}`}>
                    • {v.date_str} ({counterDisplayName[v.teller]})
                  </li>
                ))}
                {blockedOverrideViolations.length > 5 && (
                  <li>• ... en {blockedOverrideViolations.length - 5} meer</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Soft-block violations warning */}
      {softBlockViolations.length > 0 && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <div className="flex gap-3">
            <span className="text-xl">⚠️</span>
            <div>
              <p className="font-semibold text-amber-900">
                Ingedeeld op dagen met voorkeur "liever niet"
              </p>
              <p className="text-sm text-amber-800 mt-1">
                Je bent ingedeeld op {softBlockViolations.length} dag(en) die je hebt
                gemarkeerd als "liever niet":
              </p>
              <ul className="text-sm text-amber-800 mt-2 space-y-1">
                {softBlockViolations.slice(0, 5).map((v) => (
                  <li key={`${v.datum}-${v.teller}`}>
                    • {v.date_str} ({counterDisplayName[v.teller]})
                  </li>
                ))}
                {softBlockViolations.length > 5 && (
                  <li>• ... en {softBlockViolations.length - 5} meer</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Shifts by week */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Diensten per week</h3>
        <div className="space-y-4">
          {Array.from(weekView.values())
            .sort((a, b) => a.isoJaar * 100 + a.isoWeek - (b.isoJaar * 100 + b.isoWeek))
            .map((group) => (
              <div key={`${group.isoJaar}-${group.isoWeek}`} className="border-b pb-4 last:border-b-0">
                <h4 className="font-semibold text-neutral-800 mb-2">Week {group.isoWeek}</h4>
                <div className="grid grid-cols-7 gap-2">
                  {group.shifts.map((shift) => {
                    const [datum, teller] = shift.split('/');
                    const date = parseISO(datum);
                    const dayName = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'][
                      date.getDay()
                    ];
                    const isBlockedOverride = blockedOverrideSet.has(shift);
                    const isSoftBlocked = softBlockSet.has(shift);

                    return (
                      <div
                        key={shift}
                        className={`p-2 rounded text-center text-xs ${
                          isBlockedOverride
                            ? 'bg-red-100 border-2 border-red-400'
                            : isSoftBlocked
                              ? 'bg-amber-100 border border-amber-300'
                              : 'bg-blue-100 border border-blue-300'
                        }`}
                        title={isBlockedOverride ? 'Geblokkeerde dag toch toegewezen' : undefined}
                      >
                        <div className="font-bold text-neutral-900">
                          {dayName} {date.getDate()}
                        </div>
                        <div className="text-neutral-700 font-semibold">
                          {teller[0]}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* Shift Swap Management */}
      <div className="card p-6 space-y-4">
        {/* Stacks on narrow screens: side by side, the button cannot shrink
            and pushed this row ~18px past the viewport at 375px, which
            CLAUDE.md rules out ("readable on 375px width"). */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="font-bold text-lg">Diensten ruilen</h3>
            <p className="text-sm text-neutral-600 mt-1">
              Vraag een collega om een dienst te ruilen
            </p>
          </div>
          <button
            onClick={() => setSwapDialogOpen(true)}
            className="shrink-0 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            + Ruilverzoek
          </button>
        </div>

        {swapSuccessMessage && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-800">
            Ruilverzoek aangemaakt
          </div>
        )}

        {/* Show/Hide swap requests */}
        {showSwapManagement && (
          <div className="mt-4 pt-4 border-t">
            <button
              onClick={() => setShowSwapManagement(false)}
              className="text-sm text-neutral-600 hover:text-neutral-900 mb-3"
            >
              Ruilverzoeken verbergen
            </button>
            <SwapManagementPanel personId={personId} periodId={periodId} />
          </div>
        )}
        {!showSwapManagement && (
          <button
            onClick={() => setShowSwapManagement(true)}
            className="text-sm text-blue-600 hover:text-blue-700 font-medium"
          >
            Ruilverzoeken bekijken
          </button>
        )}
      </div>

      {/* Help text */}
      <div className="bg-neutral-50 p-4 rounded text-sm text-neutral-600 space-y-2">
        <p>
          <strong>A</strong> = Avonddienst | <strong>W</strong> = Weekenddienst |{' '}
          <strong>F</strong> = Feestdagdienst
        </p>
        <p>
          Vragen over je rooster? Neem contact op met de roosteraar.
        </p>
      </div>

      {/* Swap Request Dialog */}
      <SwapRequestDialog
        personId={personId}
        periodId={periodId}
        isOpen={swapDialogOpen}
        onClose={() => setSwapDialogOpen(false)}
        onSuccess={() => {
          setSwapDialogOpen(false);
          setShowSwapManagement(true);
          setSwapSuccessMessage(true);
          setTimeout(() => setSwapSuccessMessage(false), 5000);
        }}
      />
    </div>
  );
}

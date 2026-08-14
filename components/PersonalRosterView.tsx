'use client';

/**
 * Personal Roster View Component
 *
 * Displays assigned shifts after publication/deadline.
 * Shows balance in human-readable words.
 * Highlights soft-blocked days (prefer-not) that were assigned.
 * Mobile-responsive calendar view.
 */

import { useState, useEffect } from 'react';
import { parseISO } from '@/lib/holidays';

interface AssignedShift {
  datum: string;
  iso_week: number;
  teller: string; // AVOND, WEEKEND, FEESTDAG
}

interface BalanceDisplay {
  counter: string; // Evening, Weekend, Holiday
  current: number;
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
  assignedShifts: AssignedShift[];
  balances: BalanceDisplay[];
  softBlockViolations?: SoftBlockViolation[];
  holidayHistory?: Array<{ feestdag: string; année: number }>;
}

export function PersonalRosterView({
  assignedShifts,
  balances,
  softBlockViolations = [],
  holidayHistory = [],
}: Props) {
  const [weekView, setWeekView] = useState<Map<string, string[]>>(new Map());

  // Group shifts by ISO week
  useEffect(() => {
    const grouped = new Map<string, string[]>();

    for (const shift of assignedShifts) {
      const key = `${shift.iso_week}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(`${shift.datum}/${shift.teller}`);
    }

    setWeekView(grouped);
  }, [assignedShifts]);

  // Map counter type to display name
  const counterDisplayName: Record<string, string> = {
    AVOND: 'Evening',
    WEEKEND: 'Weekend',
    FEESTDAG: 'Holiday',
  };

  const softBlockSet = new Set(
    softBlockViolations.map((v) => `${v.datum}/${v.teller}`)
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-neutral-900 mb-2">Your Roster</h2>
        <p className="text-neutral-600">
          Shifts assigned for this period based on your preferences and availability
        </p>
      </div>

      {/* Balance summary */}
      <div className="card p-6 space-y-4">
        <h3 className="font-bold text-lg">Balance Summary</h3>
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
                  Current: {balance.current} | Target: {balance.target_min}–{balance.target_max}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Soft-block violations warning */}
      {softBlockViolations.length > 0 && (
        <div className="card p-4 bg-amber-50 border border-amber-200">
          <div className="flex gap-3">
            <span className="text-xl">⚠️</span>
            <div>
              <p className="font-semibold text-amber-900">
                Assigned on preferred days off
              </p>
              <p className="text-sm text-amber-800 mt-1">
                You are scheduled on {softBlockViolations.length} day(s) that you
                marked as "prefer not":
              </p>
              <ul className="text-sm text-amber-800 mt-2 space-y-1">
                {softBlockViolations.slice(0, 5).map((v) => (
                  <li key={`${v.datum}-${v.teller}`}>
                    • {v.date_str} ({counterDisplayName[v.teller]})
                  </li>
                ))}
                {softBlockViolations.length > 5 && (
                  <li>• ... and {softBlockViolations.length - 5} more</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Shifts by week */}
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-4">Shifts by Week</h3>
        <div className="space-y-4">
          {Array.from(weekView.entries())
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .map(([week, shifts]) => (
              <div key={week} className="border-b pb-4 last:border-b-0">
                <h4 className="font-semibold text-neutral-800 mb-2">Week {week}</h4>
                <div className="grid grid-cols-7 gap-2">
                  {shifts.map((shift) => {
                    const [datum, teller] = shift.split('/');
                    const date = parseISO(datum);
                    const dayName = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'][
                      date.getDay()
                    ];
                    const isSoftBlocked = softBlockSet.has(shift);

                    return (
                      <div
                        key={shift}
                        className={`p-2 rounded text-center text-xs ${
                          isSoftBlocked
                            ? 'bg-amber-100 border border-amber-300'
                            : 'bg-blue-100 border border-blue-300'
                        }`}
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

      {/* Holiday history */}
      {holidayHistory.length > 0 && (
        <div className="card p-6">
          <h3 className="font-bold text-lg mb-3">Holiday Rotation</h3>
          <p className="text-sm text-neutral-600 mb-4">
            Your holiday shift assignments for recent years
          </p>
          <div className="grid grid-cols-2 gap-3">
            {holidayHistory.map((entry) => (
              <div key={`${entry.feestdag}-${entry.année}`} className="text-sm">
                <span className="font-medium text-neutral-800">{entry.feestdag}</span>
                <span className="text-neutral-600"> {entry.année}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Help text */}
      <div className="bg-neutral-50 p-4 rounded text-sm text-neutral-600 space-y-2">
        <p>
          <strong>A</strong> = Evening shift | <strong>W</strong> = Weekend shift |{' '}
          <strong>H</strong> = Holiday shift
        </p>
        <p>
          Questions about your roster? Contact your scheduler or visit the help section.
        </p>
      </div>
    </div>
  );
}

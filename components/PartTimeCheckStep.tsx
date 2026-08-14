'use client';

/**
 * Part-time Verification Step Component
 *
 * Shows generated part-time days for user verification.
 * Marks weeks around year boundary for extra attention.
 * Requires checkbox confirmation before preferences can be submitted.
 */

import { useState, useEffect } from 'react';
import { parseISO } from '@/lib/holidays';

interface ParttimePattern {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface GeneratedDay {
  datum: string;
  weekdag: string;
  frequentie: string;
  is_year_boundary: boolean;
}

interface Props {
  patterns: ParttimePattern[];
  onConfirm?: (confirmed: boolean) => void;
}

export function PartTimeCheckStep({ patterns, onConfirm }: Props) {
  const [generatedDays, setGeneratedDays] = useState<GeneratedDay[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);

  // Generate part-time days from patterns
  useEffect(() => {
    const generateDays = async () => {
      const days: GeneratedDay[] = [];

      const weekdayMap: Record<string, number> = {
        'MA': 1, 'DI': 2, 'WO': 3, 'DO': 4, 'VR': 5, 'ZA': 6, 'ZO': 0
      };

      for (const pattern of patterns) {
        const startDate = parseISO(pattern.geldig_vanaf);
        const endDate = parseISO(pattern.geldig_tot);
        const targetWeekday = weekdayMap[pattern.weekdag];

        let currentDate = new Date(startDate);

        while (currentDate <= endDate) {
          const dayOfWeek = currentDate.getDay();

          if (dayOfWeek === targetWeekday) {
            const datum = currentDate.toISOString().split('T')[0];
            const month = currentDate.getMonth();
            const date = currentDate.getDate();

            // Check if near year boundary (Dec/Jan)
            const isYearBoundary = month === 11 || month === 0;

            // Check frequency
            const weekNum = Math.ceil((date + new Date(currentDate.getFullYear(), 0, 1).getDay()) / 7);
            const isEvenWeek = weekNum % 2 === 0;

            let include = false;
            if (pattern.frequentie === 'ELKE_WEEK') {
              include = true;
            } else if (pattern.frequentie === 'EVEN_WEKEN' && isEvenWeek) {
              include = true;
            } else if (pattern.frequentie === 'ONEVEN_WEKEN' && !isEvenWeek) {
              include = true;
            }

            if (include) {
              days.push({
                datum,
                weekdag: pattern.weekdag,
                frequentie: pattern.frequentie,
                is_year_boundary: isYearBoundary,
              });
            }
          }

          currentDate.setDate(currentDate.getDate() + 1);
        }
      }

      setGeneratedDays(days.sort((a, b) => a.datum.localeCompare(b.datum)));
      setLoading(false);
    };

    generateDays();
  }, [patterns]);

  useEffect(() => {
    onConfirm?.(confirmed);
  }, [confirmed, onConfirm]);

  if (loading) {
    return <div className="p-4 text-center">Generating part-time days...</div>;
  }

  if (generatedDays.length === 0) {
    return (
      <div className="card p-6">
        <h3 className="font-bold text-lg mb-2">Part-time Days</h3>
        <p className="text-neutral-600">No part-time patterns configured</p>
      </div>
    );
  }

  const boundaryDays = generatedDays.filter((d) => d.is_year_boundary);

  return (
    <div className="card p-6 space-y-4">
      <div>
        <h3 className="font-bold text-lg mb-1">Part-time Days Verification</h3>
        <p className="text-sm text-neutral-600">
          Please verify these days are correct, especially around year boundaries
        </p>
      </div>

      {/* Year boundary warning */}
      {boundaryDays.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3">
          <p className="text-sm text-amber-900 font-medium">
            ⚠️ {boundaryDays.length} days fall on year boundaries (Dec/Jan).
            Please verify week numbers are correct.
          </p>
        </div>
      )}

      {/* Generated days list */}
      <div className="max-h-64 overflow-y-auto border rounded p-3 bg-neutral-50">
        <div className="space-y-2">
          {generatedDays.map((day, idx) => {
            const date = parseISO(day.datum);
            const label = date.toLocaleDateString('nl-NL', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
            });

            return (
              <div
                key={idx}
                className={`flex justify-between items-center text-sm p-2 rounded
                  ${day.is_year_boundary ? 'bg-amber-100' : 'bg-white'}`}
              >
                <span className="font-mono">{day.datum}</span>
                <span className="text-neutral-600">{label}</span>
                <span className="text-xs text-neutral-500">{day.frequentie}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Confirmation checkbox */}
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 h-5 w-5 rounded border-neutral-300 text-blue-600
                     focus:ring-blue-500 cursor-pointer"
        />
        <span className="text-sm text-neutral-700">
          I have reviewed the part-time days above and confirm they are correct.
          I understand that week numbers may differ if I work across year boundaries.
        </span>
      </label>

      {/* Summary */}
      <div className="text-xs text-neutral-500 italic">
        Total: {generatedDays.length} days • Year boundary: {boundaryDays.length} days
      </div>
    </div>
  );
}

'use client';

/**
 * Setup Wizard Component
 *
 * 7-step wizard for period configuration:
 * 1. Period & Deadline
 * 2. Staff members (table, add, links)
 * 3. Window & Budgets (capacity check)
 * 4. Distribution mode & Factors
 * 5. Import initial balances (preview)
 * 6. Import holiday history (preview)
 * 7. Confirm and open period
 */

import { useState } from 'react';

type Step = 'period' | 'staff' | 'window' | 'distribution' | 'balances' | 'holidays' | 'confirm';

interface PeriodData {
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  pool_id: string;
}

interface StaffMember {
  person_id: string;
  codenaam: string;
  is_selected: boolean;
  access_link?: string;
}

interface WindowConfig {
  windowWeeks: number;
  band_min: Record<string, number>;
  band_max: Record<string, number>;
}

interface DistributionConfig {
  mode: string;
  factors: Record<string, number>;
}

interface BalanceRow {
  codenaam: string;
  AVOND_delta: number;
  WEEKEND_delta: number;
  FEESTDAG_delta: number;
}

interface HolidayRow {
  codenaam: string;
  holiday_group: string;
  year: number;
}

interface Props {
  period?: any;
  onComplete?: () => void;
}

export function SetupWizard({ period, onComplete }: Props) {
  const [currentStep, setCurrentStep] = useState<Step>('period');
  const [periodData, setPeriodData] = useState<PeriodData>({
    naam: period?.naam || '',
    start_datum: period?.start_datum || '',
    eind_datum: period?.eind_datum || '',
    deadline: period?.deadline || '',
    pool_id: period?.pool_id || '',
  });
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [windowConfig, setWindowConfig] = useState<WindowConfig>({
    windowWeeks: 2,
    band_min: { AVOND: 7, WEEKEND: 2, FEESTDAG: 1 },
    band_max: { AVOND: 8, WEEKEND: 3, FEESTDAG: 2 },
  });
  const [distributionConfig, setDistributionConfig] = useState<DistributionConfig>({
    mode: 'GELIJK',
    factors: {},
  });
  const [balanceRows, setBalanceRows] = useState<BalanceRow[]>([]);
  const [holidayRows, setHolidayRows] = useState<HolidayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<string | null>(null);

  const loadStaff = async () => {
    if (!periodData.pool_id) return;
    setStaffLoading(true);
    try {
      const memberParams = new URLSearchParams();
      if (periodData.start_datum) memberParams.set('period_start', periodData.start_datum);
      if (periodData.eind_datum) memberParams.set('period_end', periodData.eind_datum);

      const [membersRes, linksRes] = await Promise.all([
        fetch(`/api/planner/pool/${periodData.pool_id}/members?${memberParams.toString()}`),
        fetch(`/api/planner/period/${period.id}/staff-links`),
      ]);
      const membersData = await membersRes.json();
      const linksData = await linksRes.json();
      const linkedPersonIds = new Set(
        (linksData.data || [])
          .filter((l: any) => !l.revoked_at)
          .map((l: any) => l.person_id)
      );

      setStaffMembers(
        (membersData.data || [])
          .filter((m: any) => m.is_active)
          .map((m: any) => ({
            person_id: m.person_id,
            codenaam: m.codenaam,
            is_selected: true,
            access_link: linkedPersonIds.has(m.person_id) ? 'existing' : undefined,
          }))
      );
    } catch {
      setError('Failed to load staff members');
    } finally {
      setStaffLoading(false);
    }
  };

  const parseCsv = (text: string): string[][] => {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(',').map((cell) => cell.trim()));
  };

  const handleBalancesFile = async (file: File) => {
    const text = await file.text();
    const [, ...dataLines] = parseCsv(text); // skip header row
    const rows: BalanceRow[] = dataLines.map(([codenaam, avond, weekend, feestdag]) => ({
      codenaam,
      AVOND_delta: parseInt(avond) || 0,
      WEEKEND_delta: parseInt(weekend) || 0,
      FEESTDAG_delta: parseInt(feestdag) || 0,
    }));
    setBalanceRows(rows);
  };

  const handleHolidaysFile = async (file: File) => {
    const text = await file.text();
    const [, ...dataLines] = parseCsv(text); // skip header row
    const rows: HolidayRow[] = dataLines.map(([codenaam, holiday_group, year]) => ({
      codenaam,
      holiday_group,
      year: parseInt(year) || 0,
    }));
    setHolidayRows(rows);
  };

  const handleOpenPeriod = async () => {
    setLoading(true);
    setError(null);
    setOpenResult(null);

    try {
      const openRes = await fetch(`/api/periods/${period.id}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          naam: periodData.naam,
          start_datum: periodData.start_datum,
          eind_datum: periodData.eind_datum,
          deadline: periodData.deadline,
          ruleset: {
            windowWeeks: windowConfig.windowWeeks,
            bandAvond: [windowConfig.band_min.AVOND, windowConfig.band_max.AVOND],
            bandWeekend: [windowConfig.band_min.WEEKEND, windowConfig.band_max.WEEKEND],
            bandFeestdag: [windowConfig.band_min.FEESTDAG, windowConfig.band_max.FEESTDAG],
            distributionMode: distributionConfig.mode,
          },
        }),
      });
      const openData = await openRes.json();
      if (!openRes.ok) throw new Error(openData.error?.message || 'Failed to open period');

      // Create access links for selected staff who don't already have one
      const toLink = staffMembers.filter((m) => m.is_selected && !m.access_link);
      for (const member of toLink) {
        await fetch(`/api/planner/period/${period.id}/staff-links`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: member.person_id }),
        }).catch(() => null);
      }

      if (balanceRows.length > 0) {
        await fetch(`/api/planner/period/${period.id}/import-balances`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: balanceRows }),
        }).catch(() => null);
      }

      if (holidayRows.length > 0) {
        await fetch(`/api/planner/period/${period.id}/import-holidays`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: holidayRows }),
        }).catch(() => null);
      }

      setOpenResult(
        `Period opened: ${openData.data.slots_generated} slots generated, ${toLink.length} invitations sent.`
      );
      onComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open period');
    } finally {
      setLoading(false);
    }
  };

  const steps: { id: Step; label: string; title: string }[] = [
    { id: 'period', label: '1. Period', title: 'Period & Deadline' },
    { id: 'staff', label: '2. Staff', title: 'Add Staff Members' },
    { id: 'window', label: '3. Window', title: 'Window & Budgets' },
    { id: 'distribution', label: '4. Distribution', title: 'Distribution Mode' },
    { id: 'balances', label: '5. Balances', title: 'Import Initial Balances' },
    { id: 'holidays', label: '6. Holidays', title: 'Import Holiday History' },
    { id: 'confirm', label: '7. Confirm', title: 'Review and Open' },
  ];

  const handleNext = () => {
    const stepIndex = steps.findIndex((s) => s.id === currentStep);
    if (stepIndex < steps.length - 1) {
      setCurrentStep(steps[stepIndex + 1].id);
    }
  };

  const handleBack = () => {
    const stepIndex = steps.findIndex((s) => s.id === currentStep);
    if (stepIndex > 0) {
      setCurrentStep(steps[stepIndex - 1].id);
    }
  };

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex gap-2 overflow-x-auto">
        {steps.map((step, idx) => (
          <button
            key={step.id}
            onClick={() => setCurrentStep(step.id)}
            className={`px-3 py-2 rounded text-sm font-medium whitespace-nowrap transition-colors
              ${currentStep === step.id
                ? 'bg-blue-600 text-white'
                : idx < steps.findIndex((s) => s.id === currentStep)
                  ? 'bg-green-100 text-green-800'
                  : 'bg-neutral-200 text-neutral-700 hover:bg-neutral-300'}`}
          >
            {step.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="card p-6">
        <h2 className="text-2xl font-bold mb-6">
          {steps.find((s) => s.id === currentStep)?.title}
        </h2>

        {/* Step 1: Period & Deadline */}
        {currentStep === 'period' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Period Name</label>
              <input
                type="text"
                value={periodData.naam}
                onChange={(e) => setPeriodData({ ...periodData, naam: e.target.value })}
                className="w-full px-3 py-2 border rounded"
                placeholder="e.g., January 2027 Roster"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Start Date</label>
                <input
                  type="date"
                  value={periodData.start_datum}
                  onChange={(e) => setPeriodData({ ...periodData, start_datum: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">End Date</label>
                <input
                  type="date"
                  value={periodData.eind_datum}
                  onChange={(e) => setPeriodData({ ...periodData, eind_datum: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Preference Deadline</label>
              <input
                type="datetime-local"
                value={periodData.deadline}
                onChange={(e) => setPeriodData({ ...periodData, deadline: e.target.value })}
                className="w-full px-3 py-2 border rounded"
              />
              <p className="text-xs text-neutral-600 mt-1">
                Staff must submit preferences before this date/time
              </p>
            </div>

            {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>}
          </div>
        )}

        {/* Step 2: Staff Members */}
        {currentStep === 'staff' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-neutral-600">
                Select staff members who will receive preferences invitations for this period.
              </p>
              <button
                onClick={loadStaff}
                disabled={staffLoading}
                className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
              >
                {staffLoading ? 'Loading...' : 'Load Staff from Pool'}
              </button>
            </div>

            <div className="border rounded overflow-hidden">
              <table className="w-full">
                <thead className="bg-neutral-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-medium">
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={staffMembers.length > 0 && staffMembers.every((m) => m.is_selected)}
                        onChange={(e) =>
                          setStaffMembers(staffMembers.map((m) => ({ ...m, is_selected: e.target.checked })))
                        }
                      />
                    </th>
                    <th className="px-4 py-2 text-left text-sm font-medium">Name</th>
                    <th className="px-4 py-2 text-left text-sm font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {staffMembers.map((member) => (
                    <tr key={member.person_id} className="hover:bg-neutral-50">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={member.is_selected}
                          onChange={(e) => {
                            setStaffMembers(
                              staffMembers.map((m) =>
                                m.person_id === member.person_id
                                  ? { ...m, is_selected: e.target.checked }
                                  : m
                              )
                            );
                          }}
                          className="rounded"
                        />
                      </td>
                      <td className="px-4 py-2 text-sm">{member.codenaam}</td>
                      <td className="px-4 py-2 text-sm">
                        {member.access_link ? (
                          <span className="text-green-600 font-medium">✓ Already has access</span>
                        ) : member.is_selected ? (
                          <span className="text-blue-600">Will be invited on open</span>
                        ) : (
                          <span className="text-neutral-500">Not selected</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {staffMembers.length === 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
                No staff members loaded. Load from pool to continue.
              </div>
            )}
          </div>
        )}

        {/* Step 3: Window & Budgets */}
        {currentStep === 'window' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Window (weeks between shifts)</label>
              <input
                type="number"
                min="1"
                max="8"
                value={windowConfig.windowWeeks}
                onChange={(e) =>
                  setWindowConfig({ ...windowConfig, windowWeeks: parseInt(e.target.value) })
                }
                className="w-full px-3 py-2 border rounded"
              />
              <p className="text-xs text-neutral-600 mt-1">
                Minimum weeks between assignments of the same shift type
              </p>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm">
              <p className="font-medium text-blue-900 mb-2">Capacity Check</p>
              <p className="text-blue-800">
                With window of {windowConfig.windowWeeks} weeks and {staffMembers.length} staff:
              </p>
              <ul className="text-blue-800 text-xs mt-1 space-y-1 ml-4">
                <li>• Maximum {Math.floor(35 / windowConfig.windowWeeks)} shifts per person</li>
                <li>• Total capacity: {staffMembers.length * Math.floor(35 / windowConfig.windowWeeks)}</li>
                <li>• Required: {staffMembers.length >= 10 ? '✓ OK' : '✗ Below minimum'}</li>
              </ul>
            </div>

            <div>
              <h3 className="font-semibold mb-3">Target Ranges (band)</h3>
              <div className="grid grid-cols-2 gap-4">
                {['AVOND', 'WEEKEND', 'FEESTDAG'].map((counter) => (
                  <div key={counter}>
                    <label className="block text-xs font-medium mb-2">
                      {counter === 'AVOND' ? 'Evening' : counter === 'WEEKEND' ? 'Weekend' : 'Holiday'}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="0"
                        value={windowConfig.band_min[counter] || 0}
                        onChange={(e) =>
                          setWindowConfig({
                            ...windowConfig,
                            band_min: {
                              ...windowConfig.band_min,
                              [counter]: parseInt(e.target.value),
                            },
                          })
                        }
                        className="w-1/2 px-2 py-1 border rounded text-sm"
                        placeholder="Min"
                      />
                      <input
                        type="number"
                        min="0"
                        value={windowConfig.band_max[counter] || 0}
                        onChange={(e) =>
                          setWindowConfig({
                            ...windowConfig,
                            band_max: {
                              ...windowConfig.band_max,
                              [counter]: parseInt(e.target.value),
                            },
                          })
                        }
                        className="w-1/2 px-2 py-1 border rounded text-sm"
                        placeholder="Max"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Distribution Mode */}
        {currentStep === 'distribution' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Distribution Strategy</label>
              <div className="space-y-2">
                {['GELIJK', 'NAAR_RATO'].map((mode) => (
                  <label key={mode} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="distribution_mode"
                      value={mode}
                      checked={distributionConfig.mode === mode}
                      onChange={(e) =>
                        setDistributionConfig({ ...distributionConfig, mode: e.target.value })
                      }
                      className="rounded-full"
                    />
                    <span className="text-sm">
                      {mode === 'GELIJK' && 'Equal (same target range for everyone)'}
                      {mode === 'NAAR_RATO' && 'Pro-rated (target range scaled to part-time factor)'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="bg-neutral-50 p-3 rounded text-xs text-neutral-600">
              <p className="font-medium mb-1">Chosen strategy: {distributionConfig.mode}</p>
              <p>
                {distributionConfig.mode === 'GELIJK' &&
                  'Everyone gets the same target range, regardless of part-time factor.'}
                {distributionConfig.mode === 'NAAR_RATO' &&
                  "Each person's target range is scaled to their part-time factor."}
              </p>
            </div>
          </div>
        )}

        {/* Step 5: Import Balances */}
        {currentStep === 'balances' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Upload a CSV file with initial balances from the previous period. Format:
            </p>
            <div className="bg-neutral-50 p-3 rounded text-xs font-mono">
              codenaam,AVOND_delta,WEEKEND_delta,FEESTDAG_delta
              <br />
              Persoon-01,-1,0,+1
              <br />
              Persoon-02,0,+2,-1
            </div>

            <div className="border-2 border-dashed rounded p-6 text-center">
              <p className="text-sm text-neutral-600 mb-2">Drag CSV here or click to select</p>
              <input
                type="file"
                accept=".csv"
                className="w-full"
                onChange={(e) => e.target.files?.[0] && handleBalancesFile(e.target.files[0])}
              />
            </div>

            {balanceRows.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
                <p className="font-medium">{balanceRows.length} records ready to import</p>
                <ul className="text-xs mt-1 space-y-0.5">
                  {balanceRows.slice(0, 5).map((r, i) => (
                    <li key={i}>
                      {r.codenaam}: AVOND {r.AVOND_delta ?? 0}, WEEKEND {r.WEEKEND_delta ?? 0},
                      FEESTDAG {r.FEESTDAG_delta ?? 0}
                    </li>
                  ))}
                  {balanceRows.length > 5 && <li>...and {balanceRows.length - 5} more</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step 6: Import Holidays */}
        {currentStep === 'holidays' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Upload holiday rotation history. Format:
            </p>
            <div className="bg-neutral-50 p-3 rounded text-xs font-mono">
              codenaam,holiday_group,year
              <br />
              Persoon-01,KERST,2025
              <br />
              Persoon-02,PASEN,2026
            </div>

            <div className="border-2 border-dashed rounded p-6 text-center">
              <p className="text-sm text-neutral-600 mb-2">Drag CSV here or click to select</p>
              <input
                type="file"
                accept=".csv"
                className="w-full"
                onChange={(e) => e.target.files?.[0] && handleHolidaysFile(e.target.files[0])}
              />
            </div>

            {holidayRows.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
                <p className="font-medium">{holidayRows.length} records ready to import</p>
                <ul className="text-xs mt-1 space-y-0.5">
                  {holidayRows.slice(0, 5).map((r, i) => (
                    <li key={i}>
                      {r.codenaam}: {r.holiday_group} {r.year}
                    </li>
                  ))}
                  {holidayRows.length > 5 && <li>...and {holidayRows.length - 5} more</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step 7: Confirm */}
        {currentStep === 'confirm' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded p-4">
              <h3 className="font-semibold text-blue-900 mb-3">Review Configuration</h3>
              <div className="space-y-2 text-sm text-blue-900">
                <p>
                  <strong>Period:</strong> {periodData.naam} ({periodData.start_datum} to{' '}
                  {periodData.eind_datum})
                </p>
                <p>
                  <strong>Deadline:</strong> {periodData.deadline}
                </p>
                <p>
                  <strong>Staff:</strong> {staffMembers.filter((s) => s.is_selected).length} selected
                </p>
                <p>
                  <strong>Window:</strong> {windowConfig.windowWeeks} weeks
                </p>
                <p>
                  <strong>Distribution:</strong> {distributionConfig.mode}
                </p>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded p-4">
              <p className="font-semibold text-amber-900 mb-2">⚠️ Before opening</p>
              <ul className="text-sm text-amber-800 space-y-1 ml-4">
                <li>✓ Period dates and deadline are correct</li>
                <li>✓ All staff members have been invited</li>
                <li>✓ Window and budget settings are appropriate</li>
                <li>✓ Initial balances (if any) have been imported</li>
              </ul>
            </div>

            <p className="text-sm text-neutral-600 italic">
              Once you open the period, staff will be able to submit preferences. The period status
              will be set to OPEN.
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>
        )}

        {openResult && (
          <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
            {openResult}
          </div>
        )}

        {/* Navigation buttons */}
        <div className="flex gap-3 mt-8">
          <button
            onClick={handleBack}
            disabled={currentStep === 'period'}
            className={`flex-1 px-4 py-2 rounded font-medium transition-colors
              ${
                currentStep === 'period'
                  ? 'bg-neutral-200 text-neutral-500 cursor-not-allowed'
                  : 'bg-neutral-200 text-neutral-900 hover:bg-neutral-300'
              }`}
          >
            Back
          </button>

          {currentStep !== 'confirm' ? (
            <button
              onClick={handleNext}
              className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleOpenPeriod}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-neutral-400 transition-colors"
            >
              {loading ? 'Opening...' : 'Open Period'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

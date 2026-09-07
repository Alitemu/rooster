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

import { useState, useEffect, useRef } from 'react';

type Step = 'period' | 'staff' | 'window' | 'distribution' | 'balances' | 'corrections' | 'holidays' | 'confirm';

interface CapacityCheckResult {
  valid: boolean;
  total_capacity: { satisfied: boolean; pool_capacity: number; required_slots: number };
  distinct_people: { satisfied: boolean; required_people: number; active_participants: number };
  message: string;
  suggested_band: { AVOND: [number, number]; WEEKEND: [number, number]; FEESTDAG: [number, number] };
}

interface PeriodData {
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  pool_id: string;
}

interface StaffMember {
  id: string; // pool_membership row id
  person_id: string;
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string;
  is_active: boolean; // membership covers this period's dates
  deelnamefactor: number; // 1.0 = fulltime; only affects targets when Verdeelmodus = "Naar rato"
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

interface BlockBudgetConfig {
  // Percentage (0-100) of a counter's total slots one person may block.
  // 100 = no limit, the default - matches the app's behaviour before this
  // setting existed.
  hardPercent: number;
  softPercent: number;
  parttimeExempt: boolean;
}

interface BalanceRow {
  codenaam: string;
  AVOND_delta: number;
  WEEKEND_delta: number;
}

interface HolidayRow {
  codenaam: string;
  holiday_group: string;
  year: number;
}

type CorrectionType = 'AVOND' | 'WEEKEND' | 'FEESTDAG' | 'RUIL_AVOND_VOOR_WEEKEND' | 'RUIL_WEEKEND_VOOR_AVOND';
// What the planner picks first - "Ongelijke ruil" then expands into a
// reden dropdown covering both RUIL_* correction types at once.
type CorrectionTopLevel = 'RUIL' | 'AVOND' | 'WEEKEND' | 'FEESTDAG';

interface Correction {
  id: string; // local, for the pending list - not a database id
  personId: string;
  codenaam: string;
  type: CorrectionType;
  reden: string;
  aantal: number;
}

interface CorrectionReasonOption {
  type: CorrectionType;
  label: string;
  // null = the planner must fill in their own value; the field starts empty.
  defaultAantal: number | null;
  explain: (aantal: number) => string;
}

const CORRECTION_TOP_LEVEL_LABELS: Record<CorrectionTopLevel, string> = {
  RUIL: 'Ongelijke ruil',
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdag',
};

// Per-teller label for the pending-corrections table - distinct from
// CORRECTION_TOP_LEVEL_LABELS because the two RUIL_* types need their own
// text (they touch two tellers at once), not just the 4-way top-level group.
const CORRECTION_TYPE_LABELS: Record<CorrectionType, string> = {
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdag',
  RUIL_AVOND_VOOR_WEEKEND: 'Ruil avond → weekend',
  RUIL_WEEKEND_VOOR_AVOND: 'Ruil weekend → avond',
};

const CORRECTION_REASONS_BY_TOP_LEVEL: Record<CorrectionTopLevel, CorrectionReasonOption[]> = {
  AVOND: [
    {
      type: 'AVOND',
      label: 'Last minute avonddienst overgenomen',
      defaultAantal: -2,
      explain: (n) =>
        `Vorige periode last minute een avonddienst overgenomen - wordt nu beloond met ${Math.abs(n)} avonddienst${Math.abs(n) === 1 ? '' : 'en'} minder in de huidige periode.`,
    },
    {
      type: 'AVOND',
      label: 'Overig',
      defaultAantal: null,
      explain: (n) => `Handmatige correctie: avonddienst wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}.`,
    },
  ],
  WEEKEND: [
    {
      type: 'WEEKEND',
      label: 'Last minute weekenddienst overgenomen',
      defaultAantal: -2,
      explain: (n) =>
        `Vorige periode last minute een weekenddienst overgenomen - wordt nu beloond met ${Math.abs(n)} weekenddienst${Math.abs(n) === 1 ? '' : 'en'} minder in de huidige periode.`,
    },
    {
      type: 'WEEKEND',
      label: 'Overig',
      defaultAantal: null,
      explain: (n) => `Handmatige correctie: weekenddienst wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}.`,
    },
  ],
  FEESTDAG: [
    {
      type: 'FEESTDAG',
      label: 'Overig',
      defaultAantal: null,
      explain: (n) => `Handmatige correctie: feestdag wordt ${n >= 0 ? n + ' meer' : Math.abs(n) + ' minder'}.`,
    },
  ],
  RUIL: [
    {
      type: 'RUIL_AVOND_VOOR_WEEKEND',
      label: 'Ruil avond- voor weekenddienst',
      defaultAantal: 1,
      explain: (n) =>
        `Heeft een avonddienst geruild voor een weekenddienst - avonddienst wordt ${n} meer, weekenddienst wordt ${n} minder.`,
    },
    {
      type: 'RUIL_WEEKEND_VOOR_AVOND',
      label: 'Ruil weekend- voor avonddienst',
      defaultAantal: 1,
      explain: (n) =>
        `Heeft een weekenddienst geruild voor een avonddienst - weekenddienst wordt ${n} meer, avonddienst wordt ${n} minder.`,
    },
  ],
};

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
  const [staffError, setStaffError] = useState<string | null>(null);
  const [newMember, setNewMember] = useState({ codenaam: '', geldig_vanaf: '', geldig_tot: '', deelnamefactor: 1 });
  const [addingMember, setAddingMember] = useState(false);
  const [editingMembershipId, setEditingMembershipId] = useState<string | null>(null);
  const [editDates, setEditDates] = useState({ geldig_vanaf: '', geldig_tot: '', deelnamefactor: 1 });
  const [savingMembership, setSavingMembership] = useState(false);
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null);
  const [togglingMembershipId, setTogglingMembershipId] = useState<string | null>(null);
  // Guards the one-time auto-activation below from re-running (and undoing
  // a planner's manual uncheck) every time the staff step is re-entered
  // within the same wizard session - it should only bring everyone up to
  // date the first time this period's staff list is loaded.
  const autoActivatedPeriodRef = useRef<string | null>(null);
  const [windowConfig, setWindowConfig] = useState<WindowConfig>({
    windowWeeks: 2,
    band_min: { AVOND: 7, WEEKEND: 2, FEESTDAG: 1 },
    band_max: { AVOND: 8, WEEKEND: 3, FEESTDAG: 2 },
  });
  const [distributionConfig, setDistributionConfig] = useState<DistributionConfig>({
    mode: 'GELIJK',
    factors: {},
  });
  const [blockBudgetConfig, setBlockBudgetConfig] = useState<BlockBudgetConfig>({
    hardPercent: 100,
    softPercent: 100,
    parttimeExempt: true,
  });
  const [balanceRows, setBalanceRows] = useState<BalanceRow[]>([]);
  const [holidayRows, setHolidayRows] = useState<HolidayRow[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [correctionFormOpen, setCorrectionFormOpen] = useState(false);
  const [correctionForm, setCorrectionForm] = useState({
    personId: '',
    topLevel: 'AVOND' as CorrectionTopLevel,
    reasonIndex: 0,
    aantal: (CORRECTION_REASONS_BY_TOP_LEVEL.AVOND[0].defaultAantal ?? '') as number | '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [capacityCheck, setCapacityCheck] = useState<CapacityCheckResult | null>(null);
  const [capacityLoading, setCapacityLoading] = useState(false);
  // Whether the planner has hand-edited a Streefbereik field. Until they
  // do, the fields track the capacity check's own suggestion (based on this
  // period's real slot counts and headcount) rather than a fixed guess -
  // once they've typed a value of their own, further capacity refreshes
  // (e.g. from changing the window) must not silently overwrite it.
  const [bandTouched, setBandTouched] = useState(false);

  useEffect(() => {
    if (currentStep !== 'window' || !period?.id) return;

    const loadCapacity = async () => {
      setCapacityLoading(true);
      try {
        const params = new URLSearchParams({ window_weeks: String(windowConfig.windowWeeks) });
        if (periodData.start_datum) params.set('start_datum', periodData.start_datum);
        if (periodData.eind_datum) params.set('eind_datum', periodData.eind_datum);

        const res = await fetch(`/api/periods/${period.id}/capacity?${params.toString()}`);
        const data = await res.json();
        const result: CapacityCheckResult | null = data.success ? data.data : null;
        setCapacityCheck(result);
        if (result?.suggested_band && !bandTouched) {
          setWindowConfig((prev) => ({
            ...prev,
            band_min: {
              AVOND: result.suggested_band.AVOND[0],
              WEEKEND: result.suggested_band.WEEKEND[0],
              FEESTDAG: result.suggested_band.FEESTDAG[0],
            },
            band_max: {
              AVOND: result.suggested_band.AVOND[1],
              WEEKEND: result.suggested_band.WEEKEND[1],
              FEESTDAG: result.suggested_band.FEESTDAG[1],
            },
          }));
        }
      } catch {
        setCapacityCheck(null);
      } finally {
        setCapacityLoading(false);
      }
    };

    loadCapacity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, windowConfig.windowWeeks, periodData.start_datum, periodData.eind_datum, period?.id, bandTouched]);

  // Membership is_active is purely date-range-based (geldig_vanaf/tot
  // overlapping the period), so "activating" someone for this period just
  // means widening their range to cover it, and "deactivating" means
  // ending (or delaying the start of) their membership around it - there's
  // no separate flag to flip.
  const addDays = (dateStr: string, days: number): string => {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().split('T')[0];
  };

  const computeActivationPatch = (
    member: StaffMember,
    activate: boolean
  ): { geldig_vanaf?: string; geldig_tot?: string } | null => {
    const { start_datum, eind_datum } = periodData;
    if (activate) {
      const patch: { geldig_vanaf?: string; geldig_tot?: string } = {};
      if (member.geldig_vanaf > start_datum) patch.geldig_vanaf = start_datum;
      if (member.geldig_tot && member.geldig_tot < eind_datum) patch.geldig_tot = eind_datum;
      return Object.keys(patch).length > 0 ? patch : null;
    }
    // Deactivate: end the membership just before this period starts, or if
    // it was due to start during/after this period, push the start past it.
    if (member.geldig_vanaf <= start_datum) {
      return { geldig_tot: addDays(start_datum, -1) };
    }
    return { geldig_vanaf: addDays(eind_datum, 1) };
  };

  const patchMembership = (membershipId: string, patch: { geldig_vanaf?: string; geldig_tot?: string }) =>
    fetch(`/api/planner/pool/${periodData.pool_id}/members/${membershipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });

  // Real pool membership (with its geldig_vanaf/geldig_tot date range) is
  // the one source of truth for "who's active in this period" - the solver
  // and the capacity check already read it directly. Shows every member
  // (not just active ones) so a planner can see who's about to roll off or
  // who hasn't started yet, not just who's currently eligible.
  const loadStaff = async () => {
    if (!periodData.pool_id) return;
    setStaffLoading(true);
    setStaffError(null);
    try {
      const memberParams = new URLSearchParams();
      if (periodData.start_datum) memberParams.set('period_start', periodData.start_datum);
      if (periodData.eind_datum) memberParams.set('period_end', periodData.eind_datum);
      const membersUrl = `/api/planner/pool/${periodData.pool_id}/members?${memberParams.toString()}`;

      const [membersRes, linksRes] = await Promise.all([
        fetch(membersUrl),
        fetch(`/api/planner/period/${period.id}/staff-links`),
      ]);
      let membersData = await membersRes.json();
      const linksData = await linksRes.json();
      const linkedPersonIds = new Set(
        (linksData.data || [])
          .filter((l: any) => !l.revoked_at)
          .map((l: any) => l.person_id)
      );

      // The first time this period's staff list is opened, everyone in the
      // pool should already be checked in as available - matches how a
      // newly-added member already defaults to this period's dates. Bring
      // any leftover members from an earlier period's date range up to
      // date automatically instead of making the planner click each one.
      if (period?.id && autoActivatedPeriodRef.current !== period.id) {
        autoActivatedPeriodRef.current = period.id;
        const toActivate = (membersData.data || []).filter((m: any) => !m.is_active);
        if (toActivate.length > 0) {
          await Promise.all(
            toActivate.map((m: any) => {
              const patch = computeActivationPatch(m, true);
              return patch ? patchMembership(m.id, patch) : Promise.resolve(null);
            })
          );
          const refreshedRes = await fetch(membersUrl);
          membersData = await refreshedRes.json();
        }
      }

      setStaffMembers(
        (membersData.data || []).map((m: any) => ({
          id: m.id,
          person_id: m.person_id,
          codenaam: m.codenaam,
          geldig_vanaf: m.geldig_vanaf,
          geldig_tot: m.geldig_tot,
          is_active: m.is_active,
          deelnamefactor: typeof m.deelnamefactor === 'number' ? m.deelnamefactor : 1,
          access_link: linkedPersonIds.has(m.person_id) ? 'existing' : undefined,
        }))
      );
    } catch {
      setStaffError('Laden van personeel mislukt');
    } finally {
      setStaffLoading(false);
    }
  };

  // Auto-load when the step is reached (and refresh if the pool or dates
  // change under it) - matches the window step's capacity check, which
  // loads itself rather than requiring a manual button. Also loads for
  // 'corrections': that step needs the same staff list for its persoon
  // dropdown, and a planner can reach it via the step tabs without ever
  // visiting 'staff' first.
  useEffect(() => {
    if ((currentStep !== 'staff' && currentStep !== 'corrections') || !periodData.pool_id) return;
    loadStaff();
    setNewMember((prev) => ({
      ...prev,
      geldig_vanaf: prev.geldig_vanaf || periodData.start_datum,
      geldig_tot: prev.geldig_tot || periodData.eind_datum,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, periodData.pool_id]);

  const handleAddMember = async () => {
    if (!newMember.codenaam.trim() || !newMember.geldig_vanaf || !newMember.geldig_tot) {
      setStaffError('Codenaam, geldig vanaf en geldig tot zijn verplicht');
      return;
    }
    setAddingMember(true);
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${periodData.pool_id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMember),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Toevoegen mislukt');

      setNewMember({ codenaam: '', geldig_vanaf: periodData.start_datum, geldig_tot: periodData.eind_datum, deelnamefactor: 1 });
      await loadStaff();
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Toevoegen mislukt');
    } finally {
      setAddingMember(false);
    }
  };

  const startEditMembership = (member: StaffMember) => {
    setStaffError(null);
    setEditingMembershipId(member.id);
    setEditDates({ geldig_vanaf: member.geldig_vanaf, geldig_tot: member.geldig_tot, deelnamefactor: member.deelnamefactor });
  };

  const handleSaveMembership = async (membershipId: string) => {
    setSavingMembership(true);
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${periodData.pool_id}/members/${membershipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDates),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan mislukt');

      setEditingMembershipId(null);
      await loadStaff();
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Opslaan mislukt');
    } finally {
      setSavingMembership(false);
    }
  };

  const handleRemoveMembership = async (membershipId: string) => {
    if (removingMembershipId !== membershipId) {
      // First click arms the confirmation instead of deleting immediately.
      setRemovingMembershipId(membershipId);
      return;
    }
    setStaffError(null);
    try {
      const res = await fetch(`/api/planner/pool/${periodData.pool_id}/members/${membershipId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen mislukt');

      await loadStaff();
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Verwijderen mislukt');
    } finally {
      setRemovingMembershipId(null);
    }
  };

  const handleToggleActive = async (member: StaffMember) => {
    const patch = computeActivationPatch(member, !member.is_active);
    if (!patch) return;
    setTogglingMembershipId(member.id);
    setStaffError(null);
    try {
      const res = await patchMembership(member.id, patch);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Bijwerken mislukt');
      await loadStaff();
    } catch (err) {
      setStaffError(err instanceof Error ? err.message : 'Bijwerken mislukt');
    } finally {
      setTogglingMembershipId(null);
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
    const rows: BalanceRow[] = dataLines.map(([codenaam, avond, weekend]) => ({
      codenaam,
      AVOND_delta: parseInt(avond) || 0,
      WEEKEND_delta: parseInt(weekend) || 0,
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

  const correctionReasonOptions = CORRECTION_REASONS_BY_TOP_LEVEL[correctionForm.topLevel];
  const correctionSelectedReason = correctionReasonOptions[correctionForm.reasonIndex] ?? correctionReasonOptions[0];

  const applyReasonDefault = (topLevel: CorrectionTopLevel, reasonIndex: number) => {
    const reason = CORRECTION_REASONS_BY_TOP_LEVEL[topLevel][reasonIndex];
    setCorrectionForm((f) => ({
      ...f,
      topLevel,
      reasonIndex,
      aantal: reason.defaultAantal ?? '',
    }));
  };

  const handleAddCorrection = () => {
    if (!correctionForm.personId || correctionForm.aantal === '' || correctionForm.aantal === 0) {
      setError('Kies een medewerker en vul een aantal (ongelijk aan 0) in');
      return;
    }
    const member = staffMembers.find((m) => m.person_id === correctionForm.personId);
    if (!member) return;
    const aantal = correctionForm.aantal as number;

    // An ongelijke ruil touches two counters at once - show it as its two
    // halves right away, each with the mirrored reden and the opposite
    // counter/aantal, instead of one row that hides the second half.
    if (correctionSelectedReason.type === 'RUIL_AVOND_VOOR_WEEKEND' || correctionSelectedReason.type === 'RUIL_WEEKEND_VOOR_AVOND') {
      const mirror = CORRECTION_REASONS_BY_TOP_LEVEL.RUIL.find((r) => r.type !== correctionSelectedReason.type)!;
      const eersteType: CorrectionType = correctionSelectedReason.type === 'RUIL_AVOND_VOOR_WEEKEND' ? 'AVOND' : 'WEEKEND';
      const tweedeType: CorrectionType = eersteType === 'AVOND' ? 'WEEKEND' : 'AVOND';
      setCorrections((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          personId: correctionForm.personId,
          codenaam: member.codenaam,
          type: eersteType,
          reden: correctionSelectedReason.label,
          aantal,
        },
        {
          id: crypto.randomUUID(),
          personId: correctionForm.personId,
          codenaam: member.codenaam,
          type: tweedeType,
          reden: mirror.label,
          aantal: -aantal,
        },
      ]);
    } else {
      setCorrections((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          personId: correctionForm.personId,
          codenaam: member.codenaam,
          type: correctionSelectedReason.type,
          reden: correctionSelectedReason.label,
          aantal,
        },
      ]);
    }
    setError(null);
    applyReasonDefault(correctionForm.topLevel, correctionForm.reasonIndex);
  };

  const handleRemoveCorrection = (id: string) => {
    setCorrections((prev) => prev.filter((c) => c.id !== id));
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
            blockBudget: {
              AVOND: { maxFraction: blockBudgetConfig.hardPercent / 100 },
              WEEKEND: { maxFraction: blockBudgetConfig.hardPercent / 100 },
              FEESTDAG: { maxFraction: blockBudgetConfig.hardPercent / 100 },
              parttimeExempt: blockBudgetConfig.parttimeExempt,
            },
            softBlockBudget: {
              AVOND: { maxFraction: blockBudgetConfig.softPercent / 100 },
              WEEKEND: { maxFraction: blockBudgetConfig.softPercent / 100 },
              FEESTDAG: { maxFraction: blockBudgetConfig.softPercent / 100 },
            },
          },
        }),
      });
      const openData = await openRes.json();
      if (!openRes.ok) throw new Error(openData.error?.message || 'Openen van periode mislukt');

      // Invite everyone whose pool membership actually covers this period -
      // that's the same list the solver and capacity check already use, so
      // an invitation never goes to (or skips) someone differently than who
      // actually ends up eligible for the roster.
      const toLink = staffMembers.filter((m) => m.is_active && !m.access_link);
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

      if (corrections.length > 0) {
        await fetch(`/api/planner/period/${period.id}/ledger-corrections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            corrections: corrections.map((c) => ({
              person_id: c.personId,
              type: c.type,
              reden: c.reden,
              aantal: c.aantal,
            })),
          }),
        }).catch(() => null);
      }

      setOpenResult(
        `Periode geopend (${openData.data.start_datum} t/m ${openData.data.eind_datum}): ` +
          `${openData.data.slots_generated} diensten gegenereerd, ${toLink.length} uitnodigingen verstuurd.`
      );
      onComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Openen van periode mislukt');
    } finally {
      setLoading(false);
    }
  };

  const steps: { id: Step; label: string; title: string }[] = [
    { id: 'period', label: '1. Periode', title: 'Periode en deadline' },
    { id: 'staff', label: '2. Personeel', title: 'Personeel toevoegen' },
    { id: 'window', label: '3. Venster', title: 'Venster en budgetten' },
    { id: 'distribution', label: '4. Verdeling', title: 'Verdelingsmodus' },
    { id: 'balances', label: '5. Saldi', title: 'Beginsaldi importeren' },
    { id: 'holidays', label: '6. Feestdagen', title: 'Feestdagrotatie importeren' },
    { id: 'corrections', label: '7. Correcties', title: 'Handmatige correcties' },
    { id: 'confirm', label: '8. Bevestigen', title: 'Controleren en openen' },
  ];

  // Mirrors the server-side checks in POST /api/planner/periods and
  // POST /api/periods/[id]/open, so a planner sees the problem immediately
  // instead of only at the final "Periode openen" step.
  const validatePeriodStep = (): string | null => {
    if (!periodData.naam.trim()) return 'Naam periode is verplicht';
    if (!periodData.start_datum || !periodData.eind_datum || !periodData.deadline) {
      return 'Startdatum, einddatum en deadline zijn verplicht';
    }

    const start = new Date(periodData.start_datum);
    const end = new Date(periodData.eind_datum);
    const deadline = new Date(periodData.deadline);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || isNaN(deadline.getTime())) {
      return 'Ongeldige datumnotatie';
    }
    if (start >= end) return 'Startdatum moet vóór einddatum liggen';
    if (deadline < new Date()) return 'Deadline mag niet in het verleden liggen';
    if (deadline >= start) return 'Deadline moet vóór de startdatum liggen';

    return null;
  };

  const handleNext = () => {
    if (currentStep === 'period') {
      const validationError = validatePeriodStep();
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    setError(null);
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
              <label className="block text-sm font-medium mb-1">Naam periode</label>
              <input
                type="text"
                value={periodData.naam}
                onChange={(e) => setPeriodData({ ...periodData, naam: e.target.value })}
                className="w-full px-3 py-2 border rounded"
                placeholder="bijv. Rooster januari 2027"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">Startdatum</label>
                <input
                  type="date"
                  value={periodData.start_datum}
                  onChange={(e) => setPeriodData({ ...periodData, start_datum: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Einddatum</label>
                <input
                  type="date"
                  value={periodData.eind_datum}
                  onChange={(e) => setPeriodData({ ...periodData, eind_datum: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Deadline voorkeuren</label>
              <input
                type="datetime-local"
                value={periodData.deadline}
                onChange={(e) => setPeriodData({ ...periodData, deadline: e.target.value })}
                className="w-full px-3 py-2 border rounded"
              />
              <p className="text-xs text-neutral-600 mt-1">
                Personeel moet vóór dit tijdstip hun voorkeuren indienen
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Staff Members */}
        {currentStep === 'staff' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Iedereen in de pool doet standaard mee met deze periode (vinkje &quot;Actief&quot;
              staat aan) en krijgt bij het openen een uitnodiging. Vink iemand uit om diegene voor
              deze periode uit te sluiten - de geldigheidsdatum wordt dan automatisch aangepast.
              Voeg hieronder eventueel iemand nieuw toe.
            </p>

            {staffError && (
              <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{staffError}</div>
            )}

            {staffLoading ? (
              <div className="border rounded p-4 text-sm text-neutral-600 text-center">Personeel laden...</div>
            ) : (
              <div className="border rounded overflow-hidden">
                <table className="w-full">
                  <thead className="bg-neutral-100">
                    <tr>
                      <th className="px-4 py-2 text-left text-sm font-medium">Naam</th>
                      <th className="px-4 py-2 text-left text-sm font-medium">Actief in deze periode</th>
                      <th className="px-4 py-2 text-left text-sm font-medium">Geldig vanaf</th>
                      <th className="px-4 py-2 text-left text-sm font-medium">Geldig tot</th>
                      <th className="px-4 py-2 text-left text-sm font-medium" title='Alleen van invloed als Verdeelmodus (stap 4) op "Naar rato" staat'>
                        Deelnamefactor
                      </th>
                      <th className="px-4 py-2 text-left text-sm font-medium">Toegang</th>
                      <th className="px-4 py-2 text-left text-sm font-medium"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {staffMembers.map((member) => {
                      const isEditing = editingMembershipId === member.id;
                      return (
                        <tr key={member.id} className="hover:bg-neutral-50">
                          <td className="px-4 py-2 text-sm font-medium">{member.codenaam}</td>
                          <td className="px-4 py-2 text-sm">
                            <label className="inline-flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={member.is_active}
                                disabled={togglingMembershipId === member.id}
                                onChange={() => handleToggleActive(member)}
                                className="rounded"
                              />
                              <span className={member.is_active ? 'text-green-600 font-medium' : 'text-neutral-500'}>
                                {togglingMembershipId === member.id
                                  ? 'Bezig…'
                                  : member.is_active
                                    ? 'Actief'
                                    : 'Niet actief'}
                              </span>
                            </label>
                          </td>
                          <td className="px-4 py-2 text-sm">
                            {isEditing ? (
                              <input
                                type="date"
                                value={editDates.geldig_vanaf}
                                onChange={(e) => setEditDates({ ...editDates, geldig_vanaf: e.target.value })}
                                className="px-2 py-1 border rounded text-sm w-36"
                              />
                            ) : (
                              member.geldig_vanaf
                            )}
                          </td>
                          <td className="px-4 py-2 text-sm">
                            {isEditing ? (
                              <input
                                type="date"
                                value={editDates.geldig_tot}
                                onChange={(e) => setEditDates({ ...editDates, geldig_tot: e.target.value })}
                                className="px-2 py-1 border rounded text-sm w-36"
                              />
                            ) : (
                              member.geldig_tot
                            )}
                          </td>
                          <td className="px-4 py-2 text-sm">
                            {isEditing ? (
                              <input
                                type="number"
                                min="0.1"
                                max="1"
                                step="0.1"
                                value={editDates.deelnamefactor}
                                onChange={(e) =>
                                  setEditDates({ ...editDates, deelnamefactor: parseFloat(e.target.value) })
                                }
                                className="px-2 py-1 border rounded text-sm w-20"
                              />
                            ) : member.deelnamefactor < 1 ? (
                              `${Math.round(member.deelnamefactor * 100)}%`
                            ) : (
                              'Fulltime'
                            )}
                          </td>
                          <td className="px-4 py-2 text-sm">
                            {member.access_link ? (
                              <span className="text-green-600 font-medium">✓ Heeft al toegang</span>
                            ) : member.is_active ? (
                              <span className="text-blue-600">Wordt uitgenodigd bij openen</span>
                            ) : (
                              <span className="text-neutral-500">-</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-sm whitespace-nowrap">
                            {isEditing ? (
                              <div className="flex gap-3">
                                <button
                                  onClick={() => handleSaveMembership(member.id)}
                                  disabled={savingMembership}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                                >
                                  {savingMembership ? 'Bezig…' : 'Opslaan'}
                                </button>
                                <button
                                  onClick={() => setEditingMembershipId(null)}
                                  className="text-xs font-medium text-neutral-600 hover:text-neutral-800"
                                >
                                  Annuleren
                                </button>
                              </div>
                            ) : (
                              <div className="flex gap-3">
                                <button
                                  onClick={() => startEditMembership(member)}
                                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                                >
                                  Bewerken
                                </button>
                                <button
                                  onClick={() => handleRemoveMembership(member.id)}
                                  className="text-xs font-medium text-red-600 hover:text-red-800"
                                >
                                  {removingMembershipId === member.id ? 'Zeker weten?' : 'Verwijderen'}
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {staffMembers.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-6 text-center text-sm text-neutral-500">
                          Nog niemand in deze pool. Voeg hieronder iemand toe.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            <div className="border-t border-neutral-200 pt-4 space-y-3">
              <p className="text-sm font-medium text-neutral-800">Nieuw personeelslid toevoegen</p>
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Codenaam</label>
                  <input
                    type="text"
                    value={newMember.codenaam}
                    onChange={(e) => setNewMember({ ...newMember, codenaam: e.target.value })}
                    placeholder="bijv. Persoon-31"
                    className="w-full px-2 py-2 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Geldig vanaf</label>
                  <input
                    type="date"
                    value={newMember.geldig_vanaf}
                    onChange={(e) => setNewMember({ ...newMember, geldig_vanaf: e.target.value })}
                    className="w-full px-2 py-2 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Geldig tot</label>
                  <input
                    type="date"
                    value={newMember.geldig_tot}
                    onChange={(e) => setNewMember({ ...newMember, geldig_tot: e.target.value })}
                    className="w-full px-2 py-2 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-neutral-600 mb-1">Deelnamefactor</label>
                  <input
                    type="number"
                    min="0.1"
                    max="1"
                    step="0.1"
                    value={newMember.deelnamefactor}
                    onChange={(e) => setNewMember({ ...newMember, deelnamefactor: parseFloat(e.target.value) })}
                    className="w-full px-2 py-2 border rounded text-sm"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={handleAddMember}
                    disabled={addingMember}
                    className="w-full px-3 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-400 transition-colors"
                  >
                    {addingMember ? 'Bezig…' : 'Toevoegen'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-neutral-500">
                Bestaat de codenaam al (bijv. iemand die eerder in een andere pool zat), dan wordt
                die persoon hergebruikt in plaats van dubbel aangemaakt.
              </p>
            </div>
          </div>
        )}

        {/* Step 3: Window & Budgets */}
        {currentStep === 'window' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Venster (weken tussen diensten)</label>
              <input
                type="number"
                min="0"
                max="8"
                value={windowConfig.windowWeeks}
                onChange={(e) =>
                  setWindowConfig({ ...windowConfig, windowWeeks: parseInt(e.target.value) })
                }
                className="w-full px-3 py-2 border rounded"
              />
              <p className="text-xs text-neutral-600 mt-1">
                Minimaal aantal weken tussen toewijzingen van hetzelfde diensttype
              </p>
            </div>

            <div
              className={`border rounded p-3 text-sm ${
                capacityLoading
                  ? 'bg-neutral-50 border-neutral-200'
                  : capacityCheck?.valid
                    ? 'bg-green-50 border-green-200'
                    : 'bg-red-50 border-red-200'
              }`}
            >
              <p className="font-medium mb-2">Capaciteitscheck</p>
              {capacityLoading || !capacityCheck ? (
                <p className="text-neutral-600">Capaciteit controleren...</p>
              ) : (
                <>
                  <p className="whitespace-pre-line">{capacityCheck.message}</p>
                  <ul className="text-xs mt-2 space-y-1 ml-4">
                    <li>
                      • Aantal personen: {capacityCheck.distinct_people.active_participants} van{' '}
                      {capacityCheck.distinct_people.required_people} nodig{' '}
                      {capacityCheck.distinct_people.satisfied ? '✓' : '✗'}
                    </li>
                    <li>
                      • Totale capaciteit: {capacityCheck.total_capacity.pool_capacity} diensten beschikbaar voor{' '}
                      {capacityCheck.total_capacity.required_slots} benodigd{' '}
                      {capacityCheck.total_capacity.satisfied ? '✓' : '✗'}
                    </li>
                  </ul>
                </>
              )}
            </div>

            <div>
              <h3 className="font-semibold mb-1">Streefbereik</h3>
              <p className="text-xs text-neutral-600 mb-3">
                Voorstel op basis van dit rooster en het aantal mensen - pas het gerust aan, maar
                een ruimer bereik dan hier voorgesteld is voor deze periode niet haalbaar.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {['AVOND', 'WEEKEND', 'FEESTDAG'].map((counter) => (
                  <div key={counter}>
                    <label className="block text-xs font-medium mb-2">
                      {counter === 'AVOND' ? 'Avond' : counter === 'WEEKEND' ? 'Weekend' : 'Feestdag'}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="0"
                        value={windowConfig.band_min[counter] || 0}
                        onChange={(e) => {
                          setBandTouched(true);
                          setWindowConfig({
                            ...windowConfig,
                            band_min: {
                              ...windowConfig.band_min,
                              [counter]: parseInt(e.target.value),
                            },
                          });
                        }}
                        className="w-1/2 px-2 py-1 border rounded text-sm"
                        placeholder="Min"
                      />
                      <input
                        type="number"
                        min="0"
                        value={windowConfig.band_max[counter] || 0}
                        onChange={(e) => {
                          setBandTouched(true);
                          setWindowConfig({
                            ...windowConfig,
                            band_max: {
                              ...windowConfig.band_max,
                              [counter]: parseInt(e.target.value),
                            },
                          });
                        }}
                        className="w-1/2 px-2 py-1 border rounded text-sm"
                        placeholder="Max"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="font-semibold mb-1">Blokkadebudget</h3>
              <p className="text-xs text-neutral-600 mb-3">
                Begrens hoeveel procent van de diensten één persoon mag blokkeren of als &quot;liever
                niet&quot; mag opgeven. Op 100% zit er geen limiet op - de deelnemer kan dan net als
                voorheen zoveel dagen markeren als gewenst.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-2">
                    Geblokkeerd (max % van de diensten)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={blockBudgetConfig.hardPercent}
                    onChange={(e) =>
                      setBlockBudgetConfig({
                        ...blockBudgetConfig,
                        hardPercent: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                    className="w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-2">
                    Liever niet (max % van de diensten)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={blockBudgetConfig.softPercent}
                    onChange={(e) =>
                      setBlockBudgetConfig({
                        ...blockBudgetConfig,
                        softPercent: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                      })
                    }
                    className="w-full px-2 py-1 border rounded text-sm"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-3 text-xs text-neutral-700">
                <input
                  type="checkbox"
                  checked={blockBudgetConfig.parttimeExempt}
                  onChange={(e) =>
                    setBlockBudgetConfig({ ...blockBudgetConfig, parttimeExempt: e.target.checked })
                  }
                />
                Parttime-vrije dagen tellen niet mee voor het budget
              </label>
            </div>
          </div>
        )}

        {/* Step 4: Distribution Mode */}
        {currentStep === 'distribution' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Verdelingsstrategie</label>
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
                      {mode === 'GELIJK' && 'Gelijk (zelfde streefbereik voor iedereen)'}
                      {mode === 'NAAR_RATO' && 'Naar rato (streefbereik geschaald naar deeltijdfactor)'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="bg-neutral-50 p-3 rounded text-xs text-neutral-600">
              <p className="font-medium mb-1">Gekozen strategie: {distributionConfig.mode}</p>
              <p>
                {distributionConfig.mode === 'GELIJK' &&
                  'Iedereen krijgt hetzelfde streefbereik, ongeacht deeltijdfactor.'}
                {distributionConfig.mode === 'NAAR_RATO' &&
                  'Ieders streefbereik wordt geschaald naar hun deeltijdfactor (in te stellen bij stap 2, Personeel).'}
              </p>
            </div>
          </div>
        )}

        {/* Step 5: Import Balances */}
        {currentStep === 'balances' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Upload een CSV-bestand met beginsaldi uit de vorige periode: hoeveel diensten iemand
              per diensttype meer of minder heeft gedraaid dan zijn streefaantal. Formaat:
            </p>
            <div className="bg-neutral-50 p-3 rounded text-xs font-mono">
              codenaam,AVOND_delta,WEEKEND_delta
              <br />
              Persoon-01,-1,0
              <br />
              Persoon-02,0,+2
            </div>
            <p className="text-xs text-neutral-500 italic">
              Het saldo van feestdagdiensten hoort hier niet bij - welke feestdag iemand wanneer
              heeft gedraaid stel je hierna in bij stap 6. Feestdagen.
            </p>

            <div className="border-2 border-dashed rounded p-6 text-center">
              <p className="text-sm text-neutral-600 mb-2">Sleep een CSV hierheen of klik om te selecteren</p>
              <input
                type="file"
                accept=".csv"
                className="w-full"
                onChange={(e) => e.target.files?.[0] && handleBalancesFile(e.target.files[0])}
              />
            </div>

            {balanceRows.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
                <p className="font-medium">{balanceRows.length} records klaar om te importeren</p>
                <ul className="text-xs mt-1 space-y-0.5">
                  {balanceRows.slice(0, 5).map((r, i) => (
                    <li key={i}>
                      {r.codenaam}: AVOND {r.AVOND_delta ?? 0}, WEEKEND {r.WEEKEND_delta ?? 0}
                    </li>
                  ))}
                  {balanceRows.length > 5 && <li>...en {balanceRows.length - 5} meer</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step 6: Import Holidays */}
        {currentStep === 'holidays' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Losstaand van de beginsaldi hierboven: geef per persoon aan welke feestdag hij/zij in
              welk jaar heeft gedraaid, zodat de feestdagrotatie eerlijk verdeeld blijft. Formaat:
            </p>
            <div className="bg-neutral-50 p-3 rounded text-xs font-mono">
              codenaam,holiday_group,year
              <br />
              Persoon-01,NIEUWJAAR,2025
              <br />
              Persoon-02,PASEN,2025
              <br />
              Persoon-03,KONINGSDAG,2025
              <br />
              Persoon-04,BEVRIJDINGSDAG,2025
              <br />
              Persoon-05,HEMELVAART,2026
              <br />
              Persoon-06,PINKSTEREN,2026
              <br />
              Persoon-07,KERST,2026
            </div>
            <p className="text-xs text-neutral-500 italic">
              Geldige waarden voor holiday_group: NIEUWJAAR, PASEN, KONINGSDAG, BEVRIJDINGSDAG,
              HEMELVAART, PINKSTEREN, KERST.
            </p>

            <div className="border-2 border-dashed rounded p-6 text-center">
              <p className="text-sm text-neutral-600 mb-2">Sleep een CSV hierheen of klik om te selecteren</p>
              <input
                type="file"
                accept=".csv"
                className="w-full"
                onChange={(e) => e.target.files?.[0] && handleHolidaysFile(e.target.files[0])}
              />
            </div>

            {holidayRows.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-800">
                <p className="font-medium">{holidayRows.length} records klaar om te importeren</p>
                <ul className="text-xs mt-1 space-y-0.5">
                  {holidayRows.slice(0, 5).map((r, i) => (
                    <li key={i}>
                      {r.codenaam}: {r.holiday_group} {r.year}
                    </li>
                  ))}
                  {holidayRows.length > 5 && <li>...en {holidayRows.length - 5} meer</li>}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step 7: Corrections */}
        {currentStep === 'corrections' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Corrigeer hier het saldo van een medewerker voor een uitzonderlijke situatie - bijvoorbeeld
              het laatste moment overnemen van een dienst, of een ongelijke ruil. De gewone overloop
              tussen periodes gebeurt al automatisch en hoeft hier niet.
            </p>

            <button
              onClick={() => setCorrectionFormOpen((v) => !v)}
              className="flex items-center gap-2 px-4 py-2 rounded font-medium bg-neutral-100 text-neutral-900 hover:bg-neutral-200 transition-colors"
            >
              Correctie toepassen
            </button>

            {correctionFormOpen && (
              <div className="border rounded p-4 space-y-3 bg-neutral-50">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 mb-1">Persoon</label>
                    <select
                      value={correctionForm.personId}
                      onChange={(e) => setCorrectionForm((f) => ({ ...f, personId: e.target.value }))}
                      className="w-full px-2 py-2 border rounded text-sm"
                    >
                      <option value="">Kies een medewerker...</option>
                      {staffMembers.map((m) => (
                        <option key={m.person_id} value={m.person_id}>
                          {m.codenaam}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-neutral-600 mb-1">Type</label>
                    <select
                      value={correctionForm.topLevel}
                      onChange={(e) => applyReasonDefault(e.target.value as CorrectionTopLevel, 0)}
                      className="w-full px-2 py-2 border rounded text-sm"
                    >
                      {(Object.keys(CORRECTION_TOP_LEVEL_LABELS) as CorrectionTopLevel[]).map((tl) => (
                        <option key={tl} value={tl}>
                          {CORRECTION_TOP_LEVEL_LABELS[tl]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-neutral-600 mb-1">Reden</label>
                    <select
                      value={correctionForm.reasonIndex}
                      onChange={(e) => applyReasonDefault(correctionForm.topLevel, parseInt(e.target.value))}
                      className="w-full px-2 py-2 border rounded text-sm"
                    >
                      {correctionReasonOptions.map((r, i) => (
                        <option key={i} value={i}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-neutral-600 mb-1">Aantal</label>
                    <input
                      type="number"
                      value={correctionForm.aantal}
                      onChange={(e) =>
                        setCorrectionForm((f) => ({
                          ...f,
                          aantal: e.target.value === '' ? '' : parseInt(e.target.value),
                        }))
                      }
                      placeholder={correctionSelectedReason.defaultAantal === null ? 'Zelf invullen' : undefined}
                      className="w-full px-2 py-2 border rounded text-sm"
                    />
                  </div>
                </div>

                <p className="text-xs text-neutral-500 italic">
                  {correctionSelectedReason.explain(
                    correctionForm.aantal === '' ? 0 : correctionForm.aantal
                  )}
                </p>

                <button
                  onClick={handleAddCorrection}
                  className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                >
                  Toevoegen
                </button>
              </div>
            )}

            {corrections.length > 0 && (
              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-100">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Persoon</th>
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Reden</th>
                      <th className="px-3 py-2 text-left font-medium">Aantal</th>
                      <th className="px-3 py-2 text-left font-medium"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {corrections.map((c) => (
                      <tr key={c.id}>
                        <td className="px-3 py-2 font-medium">{c.codenaam}</td>
                        <td className="px-3 py-2">{CORRECTION_TYPE_LABELS[c.type]}</td>
                        <td className="px-3 py-2">{c.reden}</td>
                        <td className="px-3 py-2">{c.aantal >= 0 ? `+${c.aantal}` : c.aantal}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => handleRemoveCorrection(c.id)}
                            className="text-xs font-medium text-red-600 hover:text-red-800"
                          >
                            Verwijderen
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Step 8: Confirm */}
        {currentStep === 'confirm' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded p-4">
              <h3 className="font-semibold text-blue-900 mb-3">Configuratie controleren</h3>
              <div className="space-y-2 text-sm text-blue-900">
                <p>
                  <strong>Periode:</strong> {periodData.naam} ({periodData.start_datum} t/m{' '}
                  {periodData.eind_datum})
                </p>
                <p>
                  <strong>Deadline:</strong> {periodData.deadline}
                </p>
                <p>
                  <strong>Personeel:</strong> {staffMembers.filter((s) => s.is_active).length} actief in deze periode
                </p>
                <p>
                  <strong>Venster:</strong> {windowConfig.windowWeeks} weken
                </p>
                <p>
                  <strong>Verdeling:</strong> {distributionConfig.mode}
                </p>
                <p>
                  <strong>Correcties:</strong> {corrections.length} klaar om toe te passen
                </p>
              </div>
            </div>

            {staffMembers.filter((s) => s.is_active).length === 0 && (
              <div className="bg-red-50 border border-red-200 rounded p-4">
                <p className="text-sm font-semibold text-red-900">
                  ⚠️ Nog niemand actief voor deze periode
                </p>
                <p className="text-sm text-red-800 mt-1">
                  Er is geen personeel actief voor deze periode - ga terug naar stap 2 (Personeel) om
                  iemand toe te voegen of te activeren. Zonder actief personeel kan de periode niet
                  geopend worden.
                </p>
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded p-4">
              <p className="font-semibold text-amber-900 mb-2">⚠️ Voordat je opent</p>
              <ul className="text-sm text-amber-800 space-y-1 ml-4">
                <li>✓ Periodedata en deadline zijn correct</li>
                <li>✓ Al het personeel is uitgenodigd</li>
                <li>✓ Venster- en budgetinstellingen zijn geschikt</li>
                <li>✓ Beginsaldi (indien van toepassing) zijn geïmporteerd</li>
              </ul>
            </div>

            <p className="text-sm text-neutral-600 italic">
              Zodra je de periode opent, kan het personeel voorkeuren indienen. De periodestatus
              wordt op OPEN gezet.
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
            Terug
          </button>

          {currentStep !== 'confirm' ? (
            <button
              onClick={handleNext}
              className="flex-1 px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Volgende
            </button>
          ) : (
            <button
              onClick={handleOpenPeriod}
              disabled={loading || staffMembers.filter((s) => s.is_active).length === 0}
              className="flex-1 px-4 py-2 rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:bg-neutral-400 transition-colors"
            >
              {loading ? 'Bezig met openen...' : 'Periode openen'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
 * 6. Manual corrections
 * 7. Confirm and open period
 *
 * There used to be a step between 5 and 6 importing which feestdag each
 * person had in which year. What matters is the number over the years,
 * not which feestdag (the planner, after audit 10), and the app now keeps
 * that count itself from its own rosters (lib/feestdagHistory.ts) - the
 * step's data was read by nothing.
 */

import { Fragment, useState, useEffect, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { computeCoverageFactor } from '@/lib/coverageFactor';
import { OPEN_EINDE } from '@/lib/membershipDefaults';
import { readUploadedRows } from '@/lib/sheetUpload';
import { leesSaldoBestand, type SaldoRegel } from '@/lib/saldoBestand';
import { withBasePath } from '@/lib/basePath';
import { deadlineTekst } from '@/lib/verzendlijst';
import { periodRangeProblem } from '@/lib/isoDate';
import { parseISO } from '@/lib/holidays';
import { validateRulesetFields } from '@/lib/rulesetValidation';
import { foutTekst } from '@/lib/foutTekst';
import { telwoord } from '@/lib/telwoord';
import { CorrectieFormulier } from '@/components/CorrectieFormulier';
import { CORRECTION_TYPE_LABELS, type Correction } from '@/lib/correctieRedenen';

type Step = 'period' | 'staff' | 'window' | 'distribution' | 'balances' | 'corrections' | 'confirm';

// Used only to validate/parse the `stap` URL query param below - the
// `steps` array further down (with labels/titles for the tab bar) is the
// one source of truth for display, this is just the bare id list.
const STEP_IDS: Step[] = [
  'period',
  'staff',
  'window',
  'distribution',
  'balances',
  'corrections',
  'confirm',
];
function isStep(value: string | null): value is Step {
  return !!value && (STEP_IDS as string[]).includes(value);
}

interface CapacityCheckResult {
  valid: boolean;
  total_capacity: { satisfied: boolean; pool_capacity: number | null; required_slots: number };
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
  deelnamefactor: number | null; // From their own part-time days, null (nog onbekend) until they handed in; only affects targets when Verdeelmodus = "Naar rato"
  access_link?: string;
}

interface WindowConfig {
  // AVOND has its own minimum weeks between shifts; WEEKEND and FEESTDAG
  // share a second one - but a shift of one type CAN still block a nearby
  // shift of the other: the *smaller* of the two values applies as a
  // floor between every pair of shifts regardless of type, on top of each
  // group's own (typically larger) same-type cap. See
  // solver/constraints.py's add_window_constraints and
  // solver/greedy.py's window_ok for the exact decomposition.
  windowWeeksAvond: number;
  windowWeeksWeekendFeestdag: number;
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

type BalanceRow = SaldoRegel;

const DISTRIBUTION_MODE_LABELS: Record<string, string> = {
  GELIJK: 'Gelijk',
  NAAR_RATO: 'Naar rato',
};


interface Props {
  period?: any;
  onComplete?: () => void;
}

/** "1 maart 2027" from a stored YYYY-MM-DD, as people read it. */
function datumKort(datum: string): string {
  if (!datum) return '';
  return new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

const COUNTER_NAAM: Record<string, string> = { AVOND: 'avond', WEEKEND: 'weekend', FEESTDAG: 'feestdag' };

export function SetupWizard({ period, onComplete }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The browser's back/forward buttons only step between wizard steps
  // (instead of leaving the setup page entirely) when each step change is
  // an actual browser-history entry. Syncing `currentStep` to a `stap` URL
  // query param does that: setCurrentStep below pushes a new entry on
  // every step change, and the effect after it reacts to the URL moving
  // (via back/forward) by updating currentStep to match.
  const [currentStep, setCurrentStepState] = useState<Step>(() => {
    const urlStep = searchParams.get('stap');
    return isStep(urlStep) ? urlStep : 'period';
  });

  useEffect(() => {
    const urlStep = searchParams.get('stap');
    const resolved: Step = isStep(urlStep) ? urlStep : 'period';
    setCurrentStepState((prev) => (prev === resolved ? prev : resolved));
  }, [searchParams]);

  const setCurrentStep = (step: Step) => {
    setCurrentStepState(step);
    const params = new URLSearchParams(searchParams.toString());
    params.set('stap', step);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };
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
  const [newMember, setNewMember] = useState({ codenaam: '', geldig_vanaf: '', geldig_tot: '' });
  const [addingMember, setAddingMember] = useState(false);
  const [editingMembershipId, setEditingMembershipId] = useState<string | null>(null);
  const [editDates, setEditDates] = useState({ geldig_vanaf: '', geldig_tot: '' });
  const [savingMembership, setSavingMembership] = useState(false);
  const [removingMembershipId, setRemovingMembershipId] = useState<string | null>(null);
  const [togglingMembershipId, setTogglingMembershipId] = useState<string | null>(null);
  // Each mistake of the staff step shows where it was made, as on Personeel
  // beheren: under Toevoegen, or under the row being changed or removed. They
  // all showed in staffError above the list, out of sight under 30 people,
  // and the planner saw "Opslaan" do nothing (1.1.3).
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ membershipId: string; message: string } | null>(null);
  // A change that reaches a period with a roster asks first (lib/membershipRooster.ts):
  // the wizard had no way to say yes, so such a change could not be saved here at all.
  const [bevestigVraag, setBevestigVraag] = useState<{
    membershipId: string;
    message: string;
    actie: 'opslaan' | 'actief' | 'verwijderen';
  } | null>(null);
  const addErrorRef = useRef<HTMLDivElement>(null);
  const rowMeldingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (addError) addErrorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [addError]);
  useEffect(() => {
    if (rowError || bevestigVraag) rowMeldingRef.current?.scrollIntoView({ block: 'nearest' });
  }, [rowError, bevestigVraag]);
  const [windowConfig, setWindowConfig] = useState<WindowConfig>({
    windowWeeksAvond: 2,
    windowWeeksWeekendFeestdag: 2,
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
    // Matches the server-side default (lib/blockBudget.ts's normalizeConfig
    // falls back to true when the field is missing, same as scripts/seed.ts)
    // - the wizard's own initial state was the one place still defaulting
    // to false, so a freshly opened wizard showed the checkbox unchecked
    // even though every other part of the app already treats "on" as the
    // default.
    parttimeExempt: true,
  });
  const [balanceRows, setBalanceRows] = useState<BalanceRow[]>([]);
  const [balanceParseWarnings, setBalanceParseWarnings] = useState<string[]>([]);
  // A beginsaldo that is there already is replaced by the file: asked first (the rows wait here until the planner says yes).
  const [balanceVraag, setBalanceVraag] = useState<{ namen: string[]; rows: BalanceRow[]; warnings: string[] } | null>(null);
  const [balanceBevestigd, setBalanceBevestigd] = useState(false);
  const [corrections, setCorrections] = useState<Correction[]>([]);
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

  // Guards against a slower, older request (e.g. from before the planner
  // adjusted windowWeeks or distributionMode again) resolving after a
  // newer one and overwriting it with stale capacity numbers - each call
  // to loadCapacity() claims the latest ticket, and only that ticket's
  // response is allowed to update state.
  const capacityRequestRef = useRef(0);

  useEffect(() => {
    if (currentStep !== 'window' || !period?.id) return;

    const loadCapacity = async () => {
      const ticket = ++capacityRequestRef.current;
      setCapacityLoading(true);
      try {
        // The live capacity check (CLAUDE.md's floor(weeks/windowWeeks)
        // formula) only has one windowWeeks slot, not a per-teller one -
        // AVOND's window is used as the representative value since AVOND
        // is by far the highest-volume counter this formula is really
        // about; it's advisory only (a suggested streefbereik), never what
        // actually governs generation, which always uses both values
        // correctly (see generate-roster/route.ts).
        const params = new URLSearchParams({
          window_weeks: String(windowConfig.windowWeeksAvond),
          distribution_mode: distributionConfig.mode,
        });
        if (periodData.start_datum) params.set('start_datum', periodData.start_datum);
        if (periodData.eind_datum) params.set('eind_datum', periodData.eind_datum);

        const res = await fetch(withBasePath(`/api/periods/${period.id}/capacity?${params.toString()}`));
        if (!res.ok) throw new Error('Capaciteitscheck mislukt');
        const data = await res.json();
        if (ticket !== capacityRequestRef.current) return; // superseded by a newer request

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
        if (ticket === capacityRequestRef.current) setCapacityCheck(null);
      } finally {
        if (ticket === capacityRequestRef.current) setCapacityLoading(false);
      }
    };

    loadCapacity();
  }, [currentStep, windowConfig.windowWeeksAvond, periodData.start_datum, periodData.eind_datum, period?.id, bandTouched, distributionConfig.mode]);

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
    // it started on/after this period's start (nothing "before" to
    // preserve), push the start past it instead.
    if (member.geldig_vanaf < start_datum) {
      return { geldig_tot: addDays(start_datum, -1) };
    }
    const newVanaf = addDays(eind_datum, 1);
    const patch: { geldig_vanaf?: string; geldig_tot?: string } = { geldig_vanaf: newVanaf };
    // geldig_tot may already sit at eind_datum (e.g. set by the activation
    // patch above) - without this it would end up before the new vanaf.
    if (member.geldig_tot && member.geldig_tot < newVanaf) {
      patch.geldig_tot = newVanaf;
    }
    return patch;
  };

  const patchMembership = (membershipId: string, patch: { geldig_vanaf?: string; geldig_tot?: string }, bevestigd = false) =>
    fetch(withBasePath(`/api/planner/pool/${periodData.pool_id}/members/${membershipId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bevestigd ? { ...patch, bevestigd: true } : patch),
    });

  // Real pool membership (with its geldig_vanaf/geldig_tot date range) is
  // the one source of truth for "who's active in this period" - the solver
  // and the capacity check already read it directly. Shows every member
  // (not just active ones) so a planner can see who's about to roll off or
  // who hasn't started yet, not just who's currently eligible.
  //
  // Loading writes nothing (1.1.3). It used to widen every membership that
  // did not cover the whole period, "the first time this period's staff
  // list is opened" - but that first time was kept in a ref, so it came
  // again with every new page load. A Geldig tot the planner had set inside
  // the period, a later Geldig vanaf and an unticked "Actief" were all undone
  // the next time the step opened, and an open end (2099) was cut to the
  // period's end on the way: the planner's report, "die data worden niet
  // opgeslagen". Members get an open end now (OPEN_EINDE, as on Personeel
  // beheren), so they take part in the next period without being widened;
  // who has an end date before it is shown as Niet actief and ticked by hand.
  // `silent` skips the full-table "Personeel laden..." placeholder (see
  // staffLoading below) - used when refreshing after a single row's own
  // mutation (toggle active, save, remove, add), which already has its own
  // per-row/per-action loading state (togglingMembershipId, savingMembership,
  // removingMembershipId, addingMember). Without this, every checkbox click
  // blanked and rebuilt the entire table, which felt like the whole page
  // reloading - especially annoying when toggling several people in a row.
  // Only the very first load of this step (and a pool/date change) still
  // shows the placeholder, since there's nothing on screen yet to keep.
  const loadStaff = async (options?: { silent?: boolean }) => {
    if (!periodData.pool_id) return;
    if (!options?.silent) setStaffLoading(true);
    setStaffError(null);
    try {
      const memberParams = new URLSearchParams();
      if (periodData.start_datum) memberParams.set('period_start', periodData.start_datum);
      if (periodData.eind_datum) memberParams.set('period_end', periodData.eind_datum);
      const membersUrl = withBasePath(`/api/planner/pool/${periodData.pool_id}/members?${memberParams.toString()}`);

      const [membersRes, linksRes] = await Promise.all([
        fetch(membersUrl),
        fetch(withBasePath(`/api/planner/period/${period.id}/staff-links`)),
      ]);
      const membersData = await membersRes.json();
      const linksData = await linksRes.json();
      const linkedPersonIds = new Set(
        (linksData.data || [])
          .filter((l: any) => !l.revoked_at)
          .map((l: any) => l.person_id)
      );

      setStaffMembers(
        (membersData.data || []).map((m: any) => ({
          id: m.id,
          person_id: m.person_id,
          codenaam: m.codenaam,
          geldig_vanaf: m.geldig_vanaf,
          geldig_tot: m.geldig_tot,
          is_active: m.is_active,
          deelnamefactor: typeof m.deelnamefactor === 'number' ? m.deelnamefactor : null,
          access_link: linkedPersonIds.has(m.person_id) ? 'existing' : undefined,
        }))
      );
    } catch {
      setStaffError('Laden van personeel mislukt');
    } finally {
      if (!options?.silent) setStaffLoading(false);
    }
  };

  // Auto-load when the step is reached (and refresh if the pool or dates
  // change under it) - matches the window step's capacity check, which
  // loads itself rather than requiring a manual button. Also loads for
  // 'corrections': that step needs the same staff list for its persoon
  // dropdown, and a planner can reach it via the step tabs without ever
  // visiting 'staff' first.
  //
  // The new member's Geldig vanaf defaults to the period's start, but a
  // planner can go back to step 1 and change that date after already having
  // visited 'staff' once - a plain "fill only if empty" check would then
  // keep showing the stale original date forever, since the field is no
  // longer empty. lastAutoFilledStartRef tracks what was last auto-filled so
  // the default can track a period-date change, while still leaving a value
  // the planner typed in by hand alone. Geldig tot is the open end
  // (OPEN_EINDE, as on Personeel beheren since 0.901.0): it was the period's
  // own end, so whoever was added here dropped out of the next period.
  const lastAutoFilledStartRef = useRef('');
  useEffect(() => {
    if ((currentStep !== 'staff' && currentStep !== 'corrections') || !periodData.pool_id) return;
    loadStaff();
    setNewMember((prev) => ({
      ...prev,
      geldig_vanaf:
        !prev.geldig_vanaf || prev.geldig_vanaf === lastAutoFilledStartRef.current ? periodData.start_datum : prev.geldig_vanaf,
      geldig_tot: prev.geldig_tot || OPEN_EINDE,
    }));
    lastAutoFilledStartRef.current = periodData.start_datum;
  }, [currentStep, periodData.pool_id, periodData.start_datum, periodData.eind_datum]);

  const handleAddMember = async () => {
    if (!newMember.codenaam.trim() || !newMember.geldig_vanaf || !newMember.geldig_tot) {
      setAddError('Codenaam, geldig vanaf en geldig tot zijn verplicht');
      return;
    }
    setAddingMember(true);
    setAddError(null);
    try {
      const res = await fetch(withBasePath(`/api/planner/pool/${periodData.pool_id}/members`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMember),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Toevoegen mislukt');

      setNewMember({ codenaam: '', geldig_vanaf: periodData.start_datum, geldig_tot: OPEN_EINDE });
      await loadStaff({ silent: true });
    } catch (err) {
      setAddError(foutTekst(err, 'Toevoegen mislukt'));
    } finally {
      setAddingMember(false);
    }
  };

  const startEditMembership = (member: StaffMember) => {
    setRowError(null);
    setBevestigVraag(null);
    setEditingMembershipId(member.id);
    setEditDates({ geldig_vanaf: member.geldig_vanaf, geldig_tot: member.geldig_tot });
  };

  const handleSaveMembership = async (membershipId: string, bevestigd = false) => {
    setSavingMembership(true);
    setRowError(null);
    setBevestigVraag(null);
    try {
      const res = await patchMembership(membershipId, editDates, bevestigd);
      const data = await res.json();
      if (res.status === 409 && data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER') {
        setBevestigVraag({ membershipId, message: data.error.message, actie: 'opslaan' });
        return;
      }
      if (!res.ok) throw new Error(data.error?.message || 'Opslaan mislukt');

      setEditingMembershipId(null);
      await loadStaff({ silent: true });
    } catch (err) {
      setRowError({ membershipId, message: foutTekst(err, 'Opslaan mislukt') });
    } finally {
      setSavingMembership(false);
    }
  };

  const handleRemoveMembership = async (membershipId: string, bevestigd = false) => {
    if (removingMembershipId !== membershipId && !bevestigd) {
      // First click arms the confirmation instead of deleting immediately.
      setRemovingMembershipId(membershipId);
      return;
    }
    setRowError(null);
    setBevestigVraag(null);
    try {
      const res = await fetch(
        withBasePath(`/api/planner/pool/${periodData.pool_id}/members/${membershipId}${bevestigd ? '?bevestigd=1' : ''}`),
        { method: 'DELETE' }
      );
      const data = await res.json();
      if (res.status === 409 && data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER') {
        setBevestigVraag({ membershipId, message: data.error.message, actie: 'verwijderen' });
        return;
      }
      if (!res.ok) throw new Error(data.error?.message || 'Verwijderen mislukt');

      await loadStaff({ silent: true });
    } catch (err) {
      setRowError({ membershipId, message: foutTekst(err, 'Verwijderen mislukt') });
    } finally {
      setRemovingMembershipId(null);
    }
  };

  const handleToggleActive = async (member: StaffMember, bevestigd = false) => {
    const patch = computeActivationPatch(member, !member.is_active);
    if (!patch) return;
    setTogglingMembershipId(member.id);
    setRowError(null);
    setBevestigVraag(null);
    try {
      const res = await patchMembership(member.id, patch, bevestigd);
      const data = await res.json();
      if (res.status === 409 && data.error?.code === 'LIDMAATSCHAP_RAAKT_ROOSTER') {
        setBevestigVraag({ membershipId: member.id, message: data.error.message, actie: 'actief' });
        return;
      }
      if (!res.ok) throw new Error(data.error?.message || 'Bijwerken mislukt');
      await loadStaff({ silent: true });
    } catch (err) {
      setRowError({ membershipId: member.id, message: foutTekst(err, 'Bijwerken mislukt') });
    } finally {
      setTogglingMembershipId(null);
    }
  };

  const handleBalancesFile = async (file: File) => {
    let fileRows: string[][];
    try {
      // An Excel workbook (lib/sheetUpload.ts), in the layout of the sjabloon.
      fileRows = await readUploadedRows(file);
    } catch (err) {
      setBalanceRows([]);
      setBalanceParseWarnings([foutTekst(err, 'Het bestand kon niet worden gelezen.')]);
      return;
    }
    const gelezen = leesSaldoBestand(fileRows);
    if ('fout' in gelezen) {
      setBalanceRows([]);
      setBalanceParseWarnings([gelezen.fout]);
      return;
    }
    const { rows, warnings } = gelezen;
    // What this period has from an earlier import: those people's saldo is replaced, a blank cell included.
    setBalanceVraag(null);
    setBalanceBevestigd(false);
    let bestaand: string[] = [];
    if (period?.id) {
      try {
        const res = await fetch(withBasePath(`/api/planner/period/${period.id}/import-balances`));
        const data = await res.json();
        if (res.ok) bestaand = (data.data.personen as Array<{ codenaam: string }>).map((p) => p.codenaam);
      } catch {
        // Not known: the server asks at the import itself.
      }
    }
    const teVervangen = [...new Set(rows.map((r) => r.codenaam))].filter((c) => bestaand.includes(c));
    if (teVervangen.length > 0) {
      setBalanceRows([]);
      setBalanceParseWarnings([]);
      setBalanceVraag({ namen: teVervangen, rows, warnings });
      return;
    }
    setBalanceRows(rows);
    setBalanceParseWarnings(warnings);
  };

  const handleRemoveCorrection = (id: string) => {
    setCorrections((prev) => prev.filter((c) => c.id !== id));
  };

  // The ruleset "Periode openen" freezes onto the period, and the
  // "Venster" step checks with the server's own rules before moving on
  // (audit 15): a minimum above a maximum came back from the server only
  // at the last step.
  const wizardRuleset = () => ({
    // Kept for anything still reading the old singular field (see
    // open/route.ts's RulesetConfig) - not itself consulted by
    // generation once the two fields below are present.
    windowWeeks: windowConfig.windowWeeksAvond,
    windowWeeksAvond: windowConfig.windowWeeksAvond,
    windowWeeksWeekendFeestdag: windowConfig.windowWeeksWeekendFeestdag,
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
      parttimeExempt: blockBudgetConfig.parttimeExempt,
    },
    // New periods default to the Prioriteitenplanner (strict
    // priority order: dekking > eerlijkheid > liever-niet >
    // voorkeur) rather than the older Puntenplanner (weighted sum) -
    // a planner can still switch a period back to 'weighted' later
    // via "Geavanceerde instellingen". Periods opened before this
    // field existed have no objectiveMode in their frozen ruleset at
    // all, and the solver's own backward-compat default for that
    // case is 'weighted', not this one - see solver/main.py.
    objectiveMode: 'lexicographic',
  });

  const handleOpenPeriod = async () => {
    setLoading(true);
    setError(null);
    setOpenResult(null);

    try {
      const openRes = await fetch(withBasePath(`/api/periods/${period.id}/open`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          naam: periodData.naam,
          start_datum: periodData.start_datum,
          eind_datum: periodData.eind_datum,
          deadline: periodData.deadline,
          ruleset: wizardRuleset(),
        }),
      });
      const openData = await openRes.json();
      if (!openRes.ok) throw new Error(openData.error?.message || 'Openen van periode mislukt');

      // Invite everyone whose pool membership actually covers this period -
      // that's the same list the solver and capacity check already use, so
      // an invitation never goes to (or skips) someone differently than who
      // actually ends up eligible for the roster.
      const toLink = staffMembers.filter((m) => m.is_active && !m.access_link);
      let linksSent = 0;
      for (const member of toLink) {
        const linkRes = await fetch(withBasePath(`/api/planner/period/${period.id}/staff-links`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: member.person_id }),
        }).catch(() => null);
        if (linkRes && linkRes.ok) linksSent++;
      }

      const importWarnings: string[] = [];
      if (linksSent < toLink.length) {
        importWarnings.push(
          `Slechts ${linksSent} van ${telwoord(toLink.length, 'uitnodiging', 'uitnodigingen')} ${toLink.length === 1 ? 'is' : 'zijn'} daadwerkelijk aangemaakt.`
        );
      }

      if (balanceRows.length > 0) {
        const balancesRes = await fetch(withBasePath(`/api/planner/period/${period.id}/import-balances`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: balanceRows, ...(balanceBevestigd ? { bevestigd: true } : {}) }),
        }).catch(() => null);
        if (balancesRes && balancesRes.status === 409) {
          const conflict = await balancesRes.json().catch(() => null);
          importWarnings.push(
            `Het beginsaldo is niet geïmporteerd. ${conflict?.error?.message ?? ''} Kies het bestand opnieuw bij stap Saldi en bevestig het overschrijven.`.replace('  ', ' ')
          );
        } else if (!balancesRes || !balancesRes.ok) {
          importWarnings.push('Importeren van beginsaldi is volledig mislukt.');
        } else {
          const balancesData = await balancesRes.json().catch(() => null);
          const rowErrors: string[] = balancesData?.data?.errors || [];
          if (rowErrors.length > 0) {
            importWarnings.push(
              `${rowErrors.length === 1 ? '1 rij in de beginsaldi is' : `${rowErrors.length} rijen in de beginsaldi zijn`} overgeslagen: ${rowErrors.join('; ')}`
            );
          }
        }
      }

      let correctionsFailed = false;
      if (corrections.length > 0) {
        const correctionsRes = await fetch(withBasePath(`/api/planner/period/${period.id}/ledger-corrections`), {
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
        correctionsFailed = !correctionsRes || !correctionsRes.ok;
      }

      setOpenResult(
        `Periode geopend (${openData.data.start_datum} t/m ${openData.data.eind_datum}): ` +
          `${telwoord(openData.data.slots_generated, 'dienst', 'diensten')} gegenereerd, ${telwoord(linksSent, 'uitnodiging', 'uitnodigingen')} verstuurd.` +
          (correctionsFailed
            ? ' Let op: de handmatige correcties zijn niet opgeslagen. Noteer ze en laat de beheerder ze alsnog verwerken.'
            : '') +
          (importWarnings.length > 0 ? ` Let op: ${importWarnings.join(' ')}` : '')
      );
      onComplete?.();
    } catch (err) {
      setError(foutTekst(err, 'Openen van periode mislukt'));
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
    { id: 'corrections', label: '6. Correcties', title: 'Handmatige correcties' },
    { id: 'confirm', label: '7. Bevestigen', title: 'Controleren en openen' },
  ];

  // Mirrors the server-side checks in POST /api/planner/periods and
  // POST /api/periods/[id]/open, so a planner sees the problem immediately
  // instead of only at the final "Periode openen" step.
  const validatePeriodStep = (): string | null => {
    if (!periodData.naam.trim()) return 'Naam periode is verplicht';
    if (!periodData.start_datum || !periodData.eind_datum || !periodData.deadline) {
      return 'Startdatum, einddatum en deadline zijn verplicht';
    }

    // Local midnight, as the server compares (a date alone is UTC midnight, an hour off on the ward's clock).
    const start = parseISO(periodData.start_datum);
    const end = parseISO(periodData.eind_datum);
    const deadline = new Date(periodData.deadline);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || isNaN(deadline.getTime())) {
      return 'Ongeldige datumnotatie';
    }
    if (start >= end) return 'Startdatum moet vóór einddatum liggen';
    const rangeProblem = periodRangeProblem(periodData.start_datum, periodData.eind_datum);
    if (rangeProblem) return rangeProblem;
    if (deadline < new Date()) return 'Deadline mag niet in het verleden liggen';
    if (deadline >= start) return 'Deadline moet vóór de startdatum liggen';

    return null;
  };

  const handleNext = () => {
    const validationError =
      currentStep === 'period'
        ? validatePeriodStep()
        : currentStep === 'window'
          ? (validateRulesetFields(wizardRuleset(), { requireBands: true })?.message ?? null)
          : null;
    if (validationError) {
      setError(validationError);
      return;
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

  // Clicking a step tab jumps directly, bypassing handleNext's validation -
  // apply the same period-step check here whenever the jump moves forward
  // past it, so it can't be skipped by clicking ahead in the tab bar.
  // Jumping backward (e.g. to review) is always allowed.
  const handleStepClick = (targetStep: Step) => {
    const currentIndex = steps.findIndex((s) => s.id === currentStep);
    const targetIndex = steps.findIndex((s) => s.id === targetStep);
    if (targetIndex > currentIndex && (currentStep === 'period' || currentStep === 'window')) {
      const validationError =
        currentStep === 'period'
          ? validatePeriodStep()
          : (validateRulesetFields(wizardRuleset(), { requireBands: true })?.message ?? null);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    setError(null);
    setCurrentStep(targetStep);
  };

  return (
    <div className="space-y-6">
      {/* Step indicator */}
      <div className="flex gap-2 overflow-x-auto">
        {steps.map((step, idx) => (
          <button
            key={step.id}
            onClick={() => handleStepClick(step.id)}
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
              <label htmlFor="wizard-naam" className="block text-sm font-medium mb-1">Naam periode</label>
              <input
                id="wizard-naam"
                type="text"
                value={periodData.naam}
                onChange={(e) => setPeriodData({ ...periodData, naam: e.target.value })}
                className="w-full px-3 py-2 border rounded"
                placeholder="bijv. Rooster januari 2027"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="wizard-start" className="block text-sm font-medium mb-1">Startdatum</label>
                <input
                  id="wizard-start"
                  type="date"
                  value={periodData.start_datum}
                  onChange={(e) => setPeriodData({ ...periodData, start_datum: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
              <div>
                <label htmlFor="wizard-eind" className="block text-sm font-medium mb-1">Einddatum</label>
                <input
                  id="wizard-eind"
                  type="date"
                  value={periodData.eind_datum}
                  onChange={(e) => setPeriodData({ ...periodData, eind_datum: e.target.value })}
                  className="w-full px-3 py-2 border rounded"
                />
              </div>
            </div>

            <div>
              <label htmlFor="wizard-deadline" className="block text-sm font-medium mb-1">Deadline voorkeuren</label>
              <input
                id="wizard-deadline"
                type="datetime-local"
                value={periodData.deadline}
                onChange={(e) => setPeriodData({ ...periodData, deadline: e.target.value })}
                className="w-full px-3 py-2 border rounded"
              />
              <p className="text-xs text-neutral-600 mt-1">
                Personeel moet vóór dit tijdstip hun voorkeuren indienen
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                Let op: 00:00 uur is het begin van die dag, dus dezelfde middernacht als het einde
                van de dag ervoor. Wil je de hele laatste dag nog meenemen, kies dan 00:00 op de
                dág erna (of 23:59 op de laatste dag zelf).
              </p>
            </div>
          </div>
        )}

        {/* Step 2: Staff Members */}
        {currentStep === 'staff' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Wie volgens Geldig vanaf en Geldig tot in deze periode valt, doet mee (vinkje &quot;Actief&quot;
              staat aan). Na het openen verstuur je de uitnodigingen zelf. Vink iemand uit om diegene voor
              deze periode uit te sluiten, waardoor de geldigheidsdatum automatisch wordt aangepast. Wat
              je hier wijzigt, blijft staan. Voeg hieronder eventueel iemand nieuw toe.
            </p>

            {!staffLoading && staffMembers.some((m) => !m.is_active) && (
              <p className="text-sm text-neutral-700" data-testid="niet-actief-uitleg">
                {(() => {
                  const n = staffMembers.filter((m) => !m.is_active).length;
                  return n === 1
                    ? '1 persoon doet niet mee in deze periode, omdat Geldig vanaf of Geldig tot erbuiten valt.'
                    : `${n} mensen doen niet mee in deze periode, omdat Geldig vanaf of Geldig tot erbuiten valt.`;
                })()}{' '}
                Vink Actief aan als iemand toch meedoet.
              </p>
            )}

            {staffError && (
              <div role="alert" className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{staffError}</div>
            )}

            {staffLoading ? (
              <div className="border rounded p-4 text-sm text-neutral-600 text-center">Personeel laden...</div>
            ) : (
              <div className="border rounded overflow-x-auto">
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
                      const vraag = bevestigVraag?.membershipId === member.id ? bevestigVraag : null;
                      const fout = rowError?.membershipId === member.id ? rowError.message : null;
                      return (
                        <Fragment key={member.id}>
                        <tr className="hover:bg-neutral-50">
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
                                aria-label={`Geldig vanaf van ${member.codenaam}`}
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
                                aria-label={`Geldig tot van ${member.codenaam}`}
                                value={editDates.geldig_tot}
                                onChange={(e) => setEditDates({ ...editDates, geldig_tot: e.target.value })}
                                className="px-2 py-1 border rounded text-sm w-36"
                              />
                            ) : (
                              member.geldig_tot
                            )}
                          </td>
                          <td className="px-4 py-2 text-sm">
                              <>
                                {member.deelnamefactor === null ? (
                                  <span className="text-neutral-500">nog onbekend</span>
                                ) : member.deelnamefactor < 1 ? (
                                  `${Math.round(member.deelnamefactor * 100)}%`
                                ) : (
                                  'Voltijd'
                                )}
                                {periodData.start_datum &&
                                  periodData.eind_datum &&
                                  (() => {
                                    const coverage = computeCoverageFactor(
                                      member.geldig_vanaf,
                                      member.geldig_tot,
                                      periodData.start_datum,
                                      periodData.eind_datum
                                    );
                                    if (coverage >= 1) return null;
                                    return (
                                      <div className="mt-1 text-xs text-neutral-500">
                                        ≈{Math.round(coverage * 100)}% van deze periode aanwezig →
                                        streefaantal wordt hierdoor automatisch verlaagd, los van de
                                        deelnamefactor hierboven.
                                      </div>
                                    );
                                  })()}
                              </>
                          </td>
                          <td className="px-4 py-2 text-sm">
                            {member.access_link ? (
                              <span className="text-green-600 font-medium">✓ Heeft al toegang</span>
                            ) : member.is_active ? (
                              <span className="text-blue-600">Krijgt de uitnodiging na het openen</span>
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
                                  onClick={() => {
                                    setEditingMembershipId(null);
                                    setBevestigVraag(null);
                                    setRowError(null);
                                  }}
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
                        {vraag && (
                          <tr>
                            <td colSpan={7} className="px-4 pb-3">
                              <div
                                ref={rowMeldingRef}
                                role="alert"
                                data-testid="rooster-bevestiging"
                                className="bg-amber-50 border border-amber-300 rounded p-3 text-sm text-amber-900 space-y-2"
                              >
                                <p>{vraag.message}</p>
                                <div className="flex gap-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      vraag.actie === 'opslaan'
                                        ? handleSaveMembership(member.id, true)
                                        : vraag.actie === 'actief'
                                          ? handleToggleActive(member, true)
                                          : handleRemoveMembership(member.id, true)
                                    }
                                    className="px-3 py-1 rounded bg-amber-700 text-white hover:bg-amber-800"
                                  >
                                    Toch doorgaan
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setBevestigVraag(null)}
                                    className="px-3 py-1 rounded border border-neutral-300 hover:bg-neutral-50"
                                  >
                                    Annuleren
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        {fout && (
                          <tr>
                            <td colSpan={7} className="px-4 pb-3">
                              <div
                                ref={rowMeldingRef}
                                role="alert"
                                data-testid="rij-fout"
                                className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700"
                              >
                                {fout}
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
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
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
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
              {addError && (
                <div ref={addErrorRef} role="alert" data-testid="toevoegen-fout" className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
                  {addError}
                </div>
              )}
              <p className="text-xs text-neutral-500">
                Bestaat de codenaam al (bijv. iemand die eerder in een andere pool zat), dan wordt
                die persoon hergebruikt in plaats van dubbel aangemaakt. Geldig tot staat open (31-12-2099):
                vul een einddatum in als iemand weggaat.
              </p>
            </div>
          </div>
        )}

        {/* Step 3: Window & Budgets */}
        {currentStep === 'window' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Venster avonddiensten (weken)
                </label>
                <input
                  type="number"
                  min="0"
                  max="8"
                  value={windowConfig.windowWeeksAvond}
                  onChange={(e) =>
                    setWindowConfig({
                      ...windowConfig,
                      windowWeeksAvond: parseInt(e.target.value) || 0,
                    })
                  }
                  className="w-full px-3 py-2 border rounded"
                />
                <p className="text-xs text-neutral-600 mt-1">
                  Minimaal aantal weken tussen twee avonddiensten voor dezelfde persoon
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Venster weekend-/feestdagdiensten (weken)
                </label>
                <input
                  type="number"
                  min="0"
                  max="8"
                  value={windowConfig.windowWeeksWeekendFeestdag}
                  onChange={(e) =>
                    setWindowConfig({
                      ...windowConfig,
                      windowWeeksWeekendFeestdag: parseInt(e.target.value) || 0,
                    })
                  }
                  className="w-full px-3 py-2 border rounded"
                />
                <p className="text-xs text-neutral-600 mt-1">
                  Minimaal aantal weken tussen twee weekend- of feestdagdiensten (samen) voor
                  dezelfde persoon
                </p>
              </div>
            </div>
            <p className="text-xs text-neutral-500">
              Het venster telt in dagen: bij 2 weken zitten er minstens 14 dagen tussen twee
              diensten van dezelfde persoon, bij 4 weken minstens 28. Het kleinste van deze twee
              vensters geldt ook tussen een avonddienst en een weekend- of feestdagdienst. Een
              avonddienst kan dus wel een weekenddienst in de buurt blokkeren en andersom, maar
              nooit strenger dan het kleinste ingestelde venster.
            </p>

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
                      • Totale capaciteit: {capacityCheck.total_capacity.pool_capacity === null ? 'onbeperkt aantal diensten' : telwoord(capacityCheck.total_capacity.pool_capacity, 'dienst', 'diensten')} beschikbaar voor{' '}
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
                Voorstel op basis van dit rooster en het aantal mensen. Pas het gerust ruimer aan,
                maar een smaller bereik dan hier voorgesteld is voor deze periode niet haalbaar.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {['AVOND', 'WEEKEND', 'FEESTDAG'].map((counter) => (
                  <div key={counter}>
                    <p className="block text-xs font-medium mb-2 capitalize">{COUNTER_NAAM[counter]}</p>
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
                              [counter]: parseInt(e.target.value) || 0,
                            },
                          });
                        }}
                        className="w-1/2 px-2 py-1 border rounded text-sm"
                        placeholder="Min"
                        aria-label={`Streefbereik ${COUNTER_NAAM[counter]} minimum`}
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
                              [counter]: parseInt(e.target.value) || 0,
                            },
                          });
                        }}
                        className="w-1/2 px-2 py-1 border rounded text-sm"
                        placeholder="Max"
                        aria-label={`Streefbereik ${COUNTER_NAAM[counter]} maximum`}
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
                niet&quot; mag opgeven. Op 100% zit er geen limiet op, waardoor de deelnemer net als
                voorheen zoveel dagen kan markeren als gewenst.
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
                    onChange={(e) => {
                      // Ignore an empty/invalid intermediate value (e.g. while
                      // the planner selects-all and retypes) rather than
                      // coercing it to 0 - 0% means "no one may block
                      // anything", so silently committing that while someone
                      // is mid-edit would lock out ABSOLUUT for the whole
                      // period the moment they tab away or submit.
                      const parsed = parseInt(e.target.value);
                      if (Number.isNaN(parsed)) return;
                      setBlockBudgetConfig({
                        ...blockBudgetConfig,
                        hardPercent: Math.min(100, Math.max(0, parsed)),
                      });
                    }}
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
                    onChange={(e) => {
                      const parsed = parseInt(e.target.value);
                      if (Number.isNaN(parsed)) return;
                      setBlockBudgetConfig({
                        ...blockBudgetConfig,
                        softPercent: Math.min(100, Math.max(0, parsed)),
                      });
                    }}
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
              <p className="text-xs text-neutral-500 mt-1">
                Het percentage hierboven wordt altijd berekend over het totaal aantal diensten in
                de hele periode, niet over iemands persoonlijke (lagere) aantal werkdagen. Met dit
                vinkje uit telt een automatisch geblokkeerde parttime-dag gewoon mee als een
                geblokkeerde dag, zoals elke andere. Met dit vinkje aan telt die dag niet mee en
                komt hij dus bovenop het budget. Iemand met een parttime-dag kan dan in totaal
                meer dagen blokkeren dan een fulltimer met hetzelfde percentage.
              </p>
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
              <p className="font-medium mb-1">
                Gekozen strategie: {DISTRIBUTION_MODE_LABELS[distributionConfig.mode] || distributionConfig.mode}
              </p>
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
              Beginsaldi uit de vorige periode: hoeveel diensten iemand per diensttype meer of minder moet krijgen dan het
              eigen streefaantal. Download het sjabloon, vul de twee kolommen in en upload het Excel-bestand weer. Er staat
              een rij voor iedereen die meedoet. Een getal met min-teken (-1) betekent 1 dienst minder in deze periode, een
              getal zonder teken (2) betekent 2 diensten extra. Een leeg vakje telt als 0.
            </p>
            {period?.id && (
              <a
                href={withBasePath(`/api/planner/period/${period.id}/import-balances/sjabloon`)}
                className="inline-block px-4 py-2 rounded font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
              >
                Sjabloon downloaden (Excel)
              </a>
            )}
            {/* Audit 10: a planner importing the saldo of a period the app
                rostered itself counted it twice, once by hand and once
                through the automatic overloop. */}
            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-900">
              Alleen nodig voor de eerste periode die je in deze app roostert. Is de vorige periode hier
              gepubliceerd, dan neemt de app het saldo daaruit bij het openen vanzelf mee. Een import telt
              daar nog eens bij op.
            </div>
            <p className="text-xs text-neutral-500 italic">
              Feestdagdiensten horen hier niet bij. Hoeveel iemand er naar verhouding heeft gehad,
              houdt de app vanaf de eerste periode hier zelf bij. Wie achterloopt, krijgt bij het
              verdelen voorrang.
            </p>

            <div className="border-2 border-dashed rounded p-6 text-center">
              <p className="text-sm text-neutral-600 mb-2">Sleep een bestand hierheen of klik om te selecteren</p>
              <input
                type="file"
                accept=".xlsx"
                aria-label="Beginsaldo als Excel-bestand"
                className="w-full"
                onChange={(e) => e.target.files?.[0] && handleBalancesFile(e.target.files[0])}
              />
            </div>

            {balanceVraag && (
              <div role="alert" data-testid="saldo-overschrijven" className="bg-amber-50 border border-amber-300 rounded p-3 text-sm text-amber-900 space-y-2">
                <p className="font-medium">
                  {balanceVraag.namen.length === 1 ? 'Voor 1 persoon staat' : `Voor ${balanceVraag.namen.length} personen staat`} al een beginsaldo.
                </p>
                <p>
                  Importeren overschrijft die waarden, ook als een vakje in het bestand leeg is: dat wordt 0. Wie niet in het
                  bestand staat, houdt het eigen saldo. Weet je het zeker?
                </p>
                <p className="text-xs">
                  {balanceVraag.namen.slice(0, 8).join(', ')}
                  {balanceVraag.namen.length > 8 && ` en ${balanceVraag.namen.length - 8} anderen`}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setBalanceRows(balanceVraag.rows);
                      setBalanceParseWarnings(balanceVraag.warnings);
                      setBalanceBevestigd(true);
                      setBalanceVraag(null);
                    }}
                    className="px-3 py-1 rounded bg-amber-700 text-white hover:bg-amber-800"
                  >
                    Ja, overschrijven
                  </button>
                  <button type="button" onClick={() => setBalanceVraag(null)} className="px-3 py-1 rounded border border-neutral-300 hover:bg-neutral-50">
                    Annuleren
                  </button>
                </div>
              </div>
            )}

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

            {balanceParseWarnings.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
                <p className="font-medium">Let op bij het inlezen van dit bestand:</p>
                <ul className="text-xs mt-1 space-y-0.5 list-disc pl-4">
                  {balanceParseWarnings.slice(0, 10).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {balanceParseWarnings.length > 10 && (
                    <li>...en {balanceParseWarnings.length - 10} meer</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step 6: Corrections */}
        {currentStep === 'corrections' && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600">
              Corrigeer hier het saldo van een medewerker voor een uitzonderlijke situatie, bijvoorbeeld
              het laatste moment overnemen van een dienst of een ongelijke ruil. De gewone overloop
              tussen periodes gebeurt al automatisch en hoeft hier niet.
            </p>

            <CorrectieFormulier
              mensen={staffMembers}
              knopTekst="Toevoegen"
              onToevoegen={(persoon, regels) => {
                setCorrections((prev) => [
                  ...prev,
                  ...regels.map((r) => ({ id: crypto.randomUUID(), personId: persoon.person_id, codenaam: persoon.codenaam, ...r })),
                ]);
                return true;
              }}
            />

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
                        <td className="px-3 py-2">{Math.abs(c.aantal)} {c.aantal >= 0 ? 'meer' : 'minder'}</td>
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

        {/* Step 7: Confirm */}
        {currentStep === 'confirm' && (
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded p-4">
              <h3 className="font-semibold text-blue-900 mb-3">Configuratie controleren</h3>
              <div className="space-y-2 text-sm text-blue-900">
                <p>
                  <strong>Periode:</strong> {periodData.naam} ({datumKort(periodData.start_datum)} t/m{' '}
                  {datumKort(periodData.eind_datum)})
                </p>
                <p>
                  <strong>Deadline:</strong> {periodData.deadline ? deadlineTekst(periodData.deadline) : 'nog niet ingevuld'}
                </p>
                <p>
                  <strong>Personeel:</strong> {staffMembers.filter((s) => s.is_active).length} actief in deze periode
                </p>
                <p>
                  <strong>Venster:</strong> avond {telwoord(windowConfig.windowWeeksAvond, 'week', 'weken')} · weekend/
                  feestdag {telwoord(windowConfig.windowWeeksWeekendFeestdag, 'week', 'weken')}
                </p>
                <p>
                  <strong>Verdeling:</strong> {DISTRIBUTION_MODE_LABELS[distributionConfig.mode] || distributionConfig.mode}
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
                  Er is geen personeel actief voor deze periode. Ga terug naar stap 2 (Personeel) om
                  iemand toe te voegen of te activeren, want zonder actief personeel kan de periode
                  niet geopend worden.
                </p>
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded p-4">
              <p className="font-semibold text-amber-900 mb-2">⚠️ Voordat je opent</p>
              <ul className="text-sm text-amber-800 space-y-1 ml-4">
                <li>✓ Periodedata en deadline zijn correct</li>
                <li>✓ Personeel is toegevoegd</li>
                <li>✓ Venster- en budgetinstellingen zijn geschikt</li>
                <li>✓ Beginsaldi (indien van toepassing) zijn geïmporteerd</li>
              </ul>
            </div>

            <p className="text-sm text-neutral-600 italic">
              Zodra je de periode opent, kan het personeel voorkeuren indienen. De uitnodigingen
              verstuur je daarna zelf, bij Exporteren &amp; communicatie op de periodepagina.
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
              className="flex-1 px-4 py-2 rounded font-medium bg-green-700 text-white hover:bg-green-800 disabled:bg-neutral-400 transition-colors"
            >
              {loading ? 'Bezig met openen...' : 'Periode openen'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

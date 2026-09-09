'use client';

/**
 * Preferences Calendar Component
 *
 * Interactive calendar grid for blocking preferences.
 * - Real <table> so week numbers and weekdays line up in columns, instead
 *   of a repeated block-per-week layout - that misalignment was the main
 *   source of "onoverzichtelijk" (unclear) feedback on the previous version.
 * - ISO week numbers always visible, in their own column
 * - Saturday/Sunday separate cells
 * - Five states per day: neutral, voorkeur, prefer-not, blocked, part-time -
 *   distinguished by color, pattern, and glyph together, never color alone
 * - Click cycles through the states; right-click (or long-press on touch,
 *   which fires the same 'contextmenu' event) opens a menu to jump to one
 *   directly
 * - "Block whole weekend" quick action, absolutely positioned so it can't
 *   stretch Saturday's row taller than the rest (the old layout bug)
 * - Live per-day coverage bar + count, and a running blocked-days summary
 *   per shift type at the top
 * - A social-pressure notice that reacts to whichever day was last
 *   touched (or, before any click, to the tightest day in the period)
 * - Auto-save with debounce
 * - Mobile-first, 375px min width
 */

import { useState, useCallback, useEffect } from 'react';
import { dateToISO, parseISO, getHolidayInfo, addDays } from '@/lib/holidays';
import { buildMonthGroups } from '@/lib/calendarMonths';

type BlockLevel = 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null;

interface SlotPreference {
  slot_id: string;
  level: BlockLevel;
  source: string | null; // MANUAL, PARTTIME, ABSENCE, or null when level is null
}

interface DayPreference {
  datum: string;
  slots: Map<string, SlotPreference>; // teller -> {slot_id, level}
}

interface CoverageInfo {
  datum: string;
  total_in_pool: number;
  absoluut_blocked: number;
  liever_niet: number;
  voorkeur: number;
  available: number;
  message: string;
}

interface Props {
  personId: string;
  periodId: string;
  shiftCounters?: string[]; // Default: ['AVOND', 'WEEKEND', 'FEESTDAG']
  readOnly?: boolean; // True once the period's deadline has passed - view only
  onPreferencesChange?: (changed: boolean) => void;
  onCoverageUpdate?: (coverage: Map<string, CoverageInfo>) => void;
}

interface ContextMenuState {
  datum: string;
  teller: string;
  x: number;
  y: number;
}

// Order matches the click-to-cycle order, so the menu reads as "the same
// options, just pick one directly instead of cycling to it".
const MENU_LEVELS: BlockLevel[] = [null, 'VOORKEUR', 'LIEVER_NIET', 'ABSOLUUT'];

const LEVEL_LABEL: Record<Exclude<BlockLevel, null>, string> = {
  VOORKEUR: 'Voorkeur',
  LIEVER_NIET: 'Liever niet',
  ABSOLUUT: 'Geblokkeerd',
};

const COUNTER_LABEL: Record<string, string> = {
  AVOND: 'Avonddiensten',
  WEEKEND: 'Weekenddiensten',
  FEESTDAG: 'Feestdagdiensten',
};

const GLYPH: Record<Exclude<BlockLevel, null>, string> = {
  VOORKEUR: '+',
  LIEVER_NIET: '~',
  ABSOLUUT: '✕',
};

// Shown on a slot with no preference set yet - makes "beschikbaar" its own
// visible state instead of a blank cell that looks the same whether it was
// checked and left available, or never looked at at all.
const AVAILABLE_GLYPH = '✓';

const WEEKDAY_TAG = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']; // index 0-6 = Monday..Sunday

function coverageBarClass(ratio: number): string {
  if (ratio < 0.3) return 'coverage-critical';
  if (ratio < 0.6) return 'coverage-warning';
  return 'coverage-good';
}

function formatDayLong(datum: string): string {
  return parseISO(datum).toLocaleDateString('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

function coverageNoteText(cov: CoverageInfo): string {
  const day = formatDayLong(cov.datum);
  if (cov.absoluut_blocked === 0) {
    return `Op ${day} heeft nog niemand geblokkeerd. Alle ${cov.total_in_pool} collega's zijn beschikbaar.`;
  }
  return (
    `Op ${day} hebben ${cov.absoluut_blocked} van de ${cov.total_in_pool} collega's al geblokkeerd. ` +
    `Er blijven ${cov.available} mensen over voor die dag.`
  );
}

export function PreferencesCalendar({
  personId,
  periodId,
  shiftCounters = ['AVOND', 'WEEKEND', 'FEESTDAG'],
  readOnly = false,
  onPreferencesChange,
  onCoverageUpdate,
}: Props) {
  const [preferences, setPreferences] = useState<Map<string, DayPreference>>(new Map());
  const [coverage, setCoverage] = useState<Map<string, CoverageInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hasChanged, setHasChanged] = useState(false);
  const [highlightDatum, setHighlightDatum] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Fetch initial preferences
  useEffect(() => {
    const fetchPreferences = async () => {
      try {
        const res = await fetch(`/api/person/${personId}/preferences/${periodId}`);
        if (!res.ok) throw new Error('Failed to fetch preferences');

        const data = await res.json();
        const prefs = new Map<string, DayPreference>();

        for (const slot of data.data.preferences) {
          const key = slot.datum;
          if (!prefs.has(key)) {
            prefs.set(key, {
              datum: key,
              slots: new Map(),
            });
          }
          prefs.get(key)!.slots.set(slot.teller, {
            slot_id: slot.slot_id,
            level: slot.blocking_level,
            source: slot.source,
          });
        }

        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load preferences:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchPreferences();
  }, [personId, periodId]);

  // Fetch coverage. Also called again after every save (see savePreference)
  // - without that, the bars, day cells, and the notice below the calendar
  // would keep showing pool-wide numbers from before the participant's own
  // just-saved change, which is exactly the kind of stale "live" number
  // CLAUDE.md's balance-messaging rule warns against.
  const fetchCoverage = useCallback(async () => {
    try {
      const res = await fetch(`/api/person/${personId}/preferences/${periodId}/coverage`);
      if (!res.ok) throw new Error('Failed to fetch coverage');

      const data = await res.json();
      const cov = new Map<string, CoverageInfo>(
        data.data.coverage_by_day.map((c: CoverageInfo) => [c.datum, c])
      );

      setCoverage(cov);
      onCoverageUpdate?.(cov);
    } catch (error) {
      console.error('Failed to load coverage:', error);
    }
  }, [personId, periodId, onCoverageUpdate]);

  useEffect(() => {
    fetchCoverage();
  }, [fetchCoverage]);

  // Before the participant has clicked anything, point the notice at the
  // tightest day in the period rather than leaving it empty - that's the
  // day most worth their attention first.
  useEffect(() => {
    if (highlightDatum || coverage.size === 0) return;
    let tightest: CoverageInfo | null = null;
    for (const c of coverage.values()) {
      if (!tightest || c.available < tightest.available) tightest = c;
    }
    if (tightest) setHighlightDatum(tightest.datum);
  }, [coverage, highlightDatum]);

  // Debounced save. The calendar already applied this change optimistically
  // (see applyPreferenceLevel) before this runs - on failure `rollback`
  // puts that one slot back to what it was, since otherwise a rejected
  // change (e.g. BLOCK_BUDGET_EXCEEDED) left the calendar showing a state
  // that was never actually saved, with no indication anything went wrong
  // until the next full reload silently reverted it.
  const savePreference = useCallback(
    async (slotId: string, level: BlockLevel, rollback: () => void) => {
      setIsSaving(true);
      setSaveError(null);
      try {
        const res = await fetch(`/api/person/${personId}/preferences/slot/${slotId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ level }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error?.message || 'Opslaan van voorkeur mislukt');
        }
        await fetchCoverage();
      } catch (error) {
        rollback();
        // The optimistic change was just reverted, so there's nothing left
        // unsaved - without this, the red "niet opgeslagen" banner below
        // and the green "opgeslagen" banner would both want to render at
        // once (hasChanged was set to true optimistically before this call
        // even started).
        setHasChanged(false);
        onPreferencesChange?.(false);
        setSaveError(error instanceof Error ? error.message : 'Opslaan van voorkeur mislukt');
      } finally {
        setIsSaving(false);
      }
    },
    [personId, fetchCoverage, onPreferencesChange]
  );

  // Set a slot to a specific level - shared by the click-to-cycle handler
  // and the right-click menu, which picks a level directly instead of
  // cycling through them. Slots generated from a part-time pattern or a
  // registered absence (source === 'PARTTIME' / 'ABSENCE') are locked - see
  // the day-cell rendering below, which never wires either of those to
  // their button in the first place, so this is only ever called for slots
  // the participant can actually edit.
  const applyPreferenceLevel = useCallback(
    (datum: string, teller: string, next: BlockLevel) => {
      // The slot_id for a given (datum, teller) is static lookup data, not
      // something this update mutates, so it's safe to read from the
      // outer `preferences` state here rather than from inside the
      // updater below. Keeping the network call and other side effects
      // out of the setPreferences updater matters because React can (and
      // in Strict Mode dev does) invoke an updater function more than
      // once per update to check for impurities - a side effect inside it
      // would fire that many times.
      const slot = preferences.get(datum)?.slots.get(teller);
      if (!slot) {
        console.error('Slot not found for', datum, teller);
        return;
      }
      const previousLevel = slot.level;
      const previousSource = slot.source;

      const setSlotTo = (level: BlockLevel, source: string | null) => {
        setPreferences((prev) => {
          const dayPref = prev.get(datum);
          const prevSlot = dayPref?.slots.get(teller);
          if (!prevSlot) return prev;

          const updated = new Map(prev);
          const updatedSlots = new Map(dayPref!.slots);
          updatedSlots.set(teller, { slot_id: prevSlot.slot_id, level, source });
          updated.set(datum, { datum, slots: updatedSlots });
          return updated;
        });
      };

      setHighlightDatum(datum);
      setSlotTo(next, next ? 'MANUAL' : null);

      setHasChanged(true);
      onPreferencesChange?.(true);
      savePreference(slot.slot_id, next, () => setSlotTo(previousLevel, previousSource));
    },
    [preferences, savePreference, onPreferencesChange]
  );

  // Left click: cycle null → VOORKEUR → LIEVER_NIET → ABSOLUUT → null
  const handleTogglePreference = useCallback(
    (datum: string, teller: string) => {
      if (readOnly) return;
      const slot = preferences.get(datum)?.slots.get(teller);
      if (!slot) {
        console.error('Slot not found for', datum, teller);
        return;
      }

      let next: BlockLevel;
      if (slot.level === null) next = 'VOORKEUR';
      else if (slot.level === 'VOORKEUR') next = 'LIEVER_NIET';
      else if (slot.level === 'LIEVER_NIET') next = 'ABSOLUUT';
      else next = null;

      applyPreferenceLevel(datum, teller, next);
    },
    [preferences, applyPreferenceLevel, readOnly]
  );

  // Right click (or long-press on touch devices, which fires the same
  // 'contextmenu' event): jump straight to a chosen level instead of
  // cycling through the others to get there.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, datum: string, teller: string) => {
      e.preventDefault();
      // Stop this event from reaching the window-level listener below,
      // which closes any already-open menu on the next 'contextmenu' event
      // it sees - without this, right-clicking a second cell would open a
      // menu for it and then immediately close it again as the same event
      // keeps bubbling.
      e.stopPropagation();
      if (isSaving || readOnly) return;
      setContextMenu({ datum, teller, x: e.clientX, y: e.clientY });
    },
    [isSaving, readOnly]
  );

  const selectContextMenuLevel = useCallback(
    (level: BlockLevel) => {
      if (!contextMenu) return;
      applyPreferenceLevel(contextMenu.datum, contextMenu.teller, level);
      setContextMenu(null);
    },
    [contextMenu, applyPreferenceLevel]
  );

  // Dismiss the menu on an outside click, a right-click elsewhere (see the
  // stopPropagation note above), Escape, or scrolling the page out from
  // under a menu positioned at a fixed pixel coordinate.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  // Block whole weekend - sets both days directly to ABSOLUUT rather than
  // cycling them, so the result never depends on whatever state a day
  // already happened to be in (cycling a day already at ABSOLUUT would
  // unblock it instead of blocking it, and cycling one at VOORKEUR would
  // only step it to LIEVER_NIET, not all the way to blocked).
  const handleBlockWeekend = useCallback(
    (satDate: string) => {
      const satParsed = parseISO(satDate);
      const sunParsed = new Date(satParsed);
      sunParsed.setDate(sunParsed.getDate() + 1);
      const sunDate = dateToISO(sunParsed);

      for (const counter of shiftCounters) {
        applyPreferenceLevel(satDate, counter, 'ABSOLUUT');
        applyPreferenceLevel(sunDate, counter, 'ABSOLUUT');
      }
    },
    [shiftCounters, applyPreferenceLevel]
  );

  if (loading) {
    return <div className="p-4 text-center">Voorkeuren laden...</div>;
  }

  // Generate calendar grid, one true calendar month per group - a month
  // always starts on its actual 1st (or the period's start date) and ends
  // on its actual last day (or the period's end date), never bleeding into
  // a neighboring month's days. See lib/calendarMonths.ts.
  const allDates = Array.from(preferences.values()).map((p) => p.datum).sort();

  if (allDates.length === 0) {
    return <div className="p-4 text-center">Geen datums beschikbaar</div>;
  }

  const startDate = parseISO(allDates[0]);
  const endDate = parseISO(allDates[allDates.length - 1]);
  const monthGroups = buildMonthGroups(startDate, endDate);

  // Blocked-days summary per shift type, computed live from what's on
  // screen - no extra request needed, updates the moment a cell is clicked.
  const counterTotals = new Map<string, { blocked: number; total: number }>();
  for (const counter of shiftCounters) counterTotals.set(counter, { blocked: 0, total: 0 });
  for (const dayPref of preferences.values()) {
    for (const counter of shiftCounters) {
      const slot = dayPref.slots.get(counter);
      if (!slot) continue;
      const totals = counterTotals.get(counter)!;
      totals.total++;
      if (slot.level === 'ABSOLUUT') totals.blocked++;
    }
  }

  const highlightCov = highlightDatum ? coverage.get(highlightDatum) : undefined;

  return (
    <div className="space-y-4">
      {/* Blocked-days counters */}
      <p className="text-xs text-neutral-500">
        Hoeveel diensten je per type al geblokkeerd hebt, van het maximum dat voor jou geldt (je
        blokkadebudget) - kom je hier tegen een grens aan, dan kun je voor dat diensttype geen dag
        meer als &quot;geblokkeerd&quot; markeren.
      </p>
      <div className="flex gap-3 flex-wrap">
        {shiftCounters.map((counter) => {
          const totals = counterTotals.get(counter)!;
          const pct = totals.total > 0 ? Math.round((totals.blocked / totals.total) * 100) : 0;
          return (
            <div key={counter} className="flex-1 min-w-[180px] border border-neutral-200 rounded-lg p-3 bg-white">
              {/* Stacked (not side-by-side) so a long label like
                  "Feestdagdiensten geblokkeerd" always has room to wrap
                  instead of pushing the count past the box's right edge. */}
              <div className="text-xs text-neutral-600">
                <div>{COUNTER_LABEL[counter] || counter} geblokkeerd</div>
                <div className="font-mono">{totals.blocked} van {totals.total}</div>
              </div>
              <div className="text-lg font-semibold tracking-tight mt-0.5 mb-1.5">{pct}%</div>
              <div className="coverage-bar">
                <div className="coverage-bar-fill bg-blue-600" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-neutral-600">
        <span className="flex items-center gap-1.5">
          <i className="inline-flex items-center justify-center w-5 h-4 rounded border border-neutral-300 bg-white text-[9px] font-bold">
            {AVAILABLE_GLYPH}
          </i>
          Beschikbaar
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-voorkeur inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">+</i>
          Voorkeur
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-prefer-not inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">~</i>
          Liever niet
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-blocked inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">✕</i>
          Geblokkeerd
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-parttime inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">PT</i>
          Parttime dag
        </span>
        <span className="flex items-center gap-1.5">
          <i className="calendar-cell-absence inline-flex items-center justify-center w-5 h-4 rounded text-[9px] font-bold">AF</i>
          Afwezigheid
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-flex items-center justify-center w-5 h-4 rounded border border-neutral-300 bg-white text-[9px] font-bold">A</i>
          Avonddienst
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-flex items-center justify-center w-5 h-4 rounded border border-neutral-300 bg-white text-[9px] font-bold">W</i>
          Weekenddienst
        </span>
        <span className="flex items-center gap-1.5">
          <i className="weekend-slot inline-block w-5 h-4 rounded" />
          Weekend
        </span>
        <span className="flex items-center gap-1.5">
          <i className="holiday-slot inline-block w-5 h-4 rounded" />
          Feestdag (naam in het vakje)
        </span>
      </div>

      {/* Calendar, one card per calendar month */}
      {monthGroups.map((group) => (
        <div key={group.label} className="border border-neutral-200 rounded-lg p-3 bg-neutral-50/50">
          <h3 className="text-sm font-bold text-neutral-800 mb-2 capitalize">{group.label}</h3>
          <div className="w-full overflow-x-auto">
            <table className="w-full table-fixed border-separate" style={{ borderSpacing: '3px' }}>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-neutral-500">
                  <th className="w-9 text-center font-semibold pb-1">wk</th>
                  {['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((d) => (
                    <th key={d} className="font-semibold pb-1">{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.weeks.map((week, weekIdx) => {
                  return (
                    <tr key={`week-${weekIdx}`}>
                      <td className="week-number text-center align-top pt-2">{week.isoWeek}</td>
                      {week.days.map((datum, dayIdx) => {
                        if (datum === null) {
                          return <td key={`blank-${weekIdx}-${dayIdx}`} className="p-0" />;
                        }
                        const dayPref = preferences.get(datum);
                        const isSaturday = dayIdx === 5;
                        const isSunday = dayIdx === 6;
                        const isWeekendDay = isSaturday || isSunday;
                        const cov = coverage.get(datum);
                        const holiday = getHolidayInfo(datum);
                        // Feestdag wins over weekend when a date is both
                        // (e.g. a Sunday that's also Eerste Paasdag) - same
                        // priority the server already assigns a slot's
                        // teller by (lib/slotPersistence.ts).
                        const tag = holiday ? holiday.name : WEEKDAY_TAG[dayIdx];
                        const ratio = cov && cov.total_in_pool > 0 ? cov.available / cov.total_in_pool : 1;

                        // The counter this day's cell should act on when the
                        // click/right-click lands somewhere other than the
                        // counter button itself (day number, tag, coverage
                        // bar, padding) - only when exactly one editable
                        // (non-locked) counter is showing, matching the
                        // "most days show only one counter row" assumption
                        // already relied on elsewhere in this file. With two
                        // or more, which one a stray click "means" is
                        // genuinely ambiguous, so only the counters' own
                        // buttons stay clickable in that case.
                        const editableCounters = shiftCounters.filter((c) => {
                          const s = dayPref?.slots.get(c);
                          return s && s.source !== 'PARTTIME' && s.source !== 'ABSENCE';
                        });
                        const soleEditableCounter =
                          editableCounters.length === 1 ? editableCounters[0] : null;

                        const handleCellClick = (e: React.MouseEvent) => {
                          // A click on a button (the counter toggle, or the
                          // "heel weekend blokkeren" shortcut) already ran
                          // that button's own onClick - without this guard
                          // it would bubble here and fire a second,
                          // conflicting action on every click.
                          if ((e.target as HTMLElement).closest('button')) return;
                          if (!soleEditableCounter) return;
                          handleTogglePreference(datum, soleEditableCounter);
                        };
                        const handleCellContextMenu = (e: React.MouseEvent) => {
                          if ((e.target as HTMLElement).closest('button')) return;
                          if (!soleEditableCounter) return;
                          handleContextMenu(e, datum, soleEditableCounter);
                        };

                        return (
                          <td key={datum} className="align-top p-0">
                            <div
                              onClick={handleCellClick}
                              onContextMenu={handleCellContextMenu}
                              className={`relative min-h-[92px] rounded-lg border p-1.5 pt-1
                                ${soleEditableCounter && !isSaving && !readOnly ? 'cursor-pointer' : ''}
                                ${holiday ? 'holiday-slot' : isWeekendDay ? 'weekend-slot' : 'border-neutral-200 bg-white'}`}
                            >
                              {/* Day number and tag (holiday name, or "za"/"zo")
                                  stacked - not side by side - so a holiday name
                                  (much longer than "za"/"zo") isn't squeezed
                                  right-aligned into a 46px sliver next to the
                                  day number and cut off; left-aligned on its
                                  own line it gets the cell's full width. */}
                              <div className="flex flex-col items-start gap-0.5">
                                <span className="text-xs font-semibold tabular-nums">
                                  {parseISO(datum).getDate()}
                                </span>
                                {tag && (
                                  <span className="text-[9px] font-bold uppercase tracking-wide text-neutral-500 truncate w-full text-left" title={tag}>
                                    {tag}
                                  </span>
                                )}
                              </div>

                              <div className="flex flex-col gap-0.5 mt-1">
                                {shiftCounters.map((counter) => {
                                  const slot = dayPref?.slots.get(counter);
                                  if (!slot) return null;

                                  const level = slot.level;
                                  // Both sources are auto-generated blocks the person didn't set
                                  // by clicking this calendar - a part-time pattern or a
                                  // registered absence - so they share the same locked,
                                  // visually-distinct treatment rather than looking like (and
                                  // being editable as) a plain manual "geblokkeerd" cell.
                                  const autoSource = slot.source === 'PARTTIME' || slot.source === 'ABSENCE' ? slot.source : null;

                                  if (autoSource) {
                                    // Kept to 2 characters, same as the manual toggle's
                                    // counter-letter + glyph pattern below - at the enlarged
                                    // 20px font a longer label (e.g. the old "A·AFW") overflows
                                    // this narrow day-column cell into the next day.
                                    const label = autoSource === 'PARTTIME' ? 'PT' : 'AF';
                                    const explanation =
                                      autoSource === 'PARTTIME'
                                        ? 'parttime dag (automatisch geblokkeerd)'
                                        : 'afwezigheid (automatisch geblokkeerd)';
                                    const cellClass =
                                      autoSource === 'PARTTIME' ? 'calendar-cell-parttime' : 'calendar-cell-absence';
                                    return (
                                      <div
                                        key={`${datum}-${counter}`}
                                        className={`${cellClass} w-full h-8 rounded text-[20px] leading-none font-semibold
                                          flex items-center justify-center cursor-not-allowed`}
                                        title={`${COUNTER_LABEL[counter] || counter}: ${explanation}`}
                                      >
                                        {label}
                                      </div>
                                    );
                                  }

                                  const stateClass = level
                                    ? level === 'ABSOLUUT'
                                      ? 'calendar-cell-blocked'
                                      : level === 'VOORKEUR'
                                        ? 'calendar-cell-voorkeur'
                                        : 'calendar-cell-prefer-not'
                                    : 'calendar-cell-neutral';

                                  return (
                                    <button
                                      key={`${datum}-${counter}`}
                                      onClick={() => handleTogglePreference(datum, counter)}
                                      onContextMenu={(e) => handleContextMenu(e, datum, counter)}
                                      disabled={isSaving || readOnly}
                                      className={`w-full h-8 rounded text-[20px] leading-none font-semibold transition-all
                                        ${stateClass} hover:shadow-sm active:scale-95 disabled:opacity-50`}
                                      title={`${COUNTER_LABEL[counter] || counter}: ${level || 'beschikbaar'} (rechtsklik voor opties)`}
                                    >
                                      {counter[0]}{level ? GLYPH[level] : AVAILABLE_GLYPH}
                                    </button>
                                  );
                                })}
                              </div>

                              {isWeekendDay && (
                                <button
                                  onClick={() => handleBlockWeekend(isSaturday ? datum : addDays(datum, -1))}
                                  disabled={isSaving || readOnly}
                                  className="absolute top-0.5 right-0.5 text-[8px] font-bold px-1 py-0.5 rounded
                                    bg-neutral-200 hover:bg-neutral-300 text-neutral-700 transition-colors
                                    disabled:opacity-50"
                                  title="Heel weekend blokkeren"
                                >
                                  WE
                                </button>
                              )}

                              {cov && (
                                <div className="mt-1">
                                  <div className="coverage-bar">
                                    <div
                                      className={`coverage-bar-fill ${coverageBarClass(ratio)}`}
                                      style={{ width: `${Math.round(ratio * 100)}%` }}
                                    />
                                  </div>
                                  <div className="text-[9px] text-neutral-500 text-center mt-0.5 tabular-nums">
                                    {cov.available}/{cov.total_in_pool}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Coverage notice + save status - grouped into one sticky footer so
          both stay visible while scrolled up editing earlier in the
          calendar, instead of the coverage notice scrolling out of view
          the moment you're no longer at the bottom of the page. Stacked in
          one sticky container (rather than each having its own
          `sticky bottom-0`) so they don't render on top of each other when
          both are showing at once. */}
      {(highlightCov || isSaving || saveError || hasChanged) && (
        <div className="sticky bottom-0 z-10 flex flex-col">
          {highlightCov && (
            <div className="text-sm p-3 bg-neutral-50 border-t border-neutral-200 text-neutral-700">
              {coverageNoteText(highlightCov)}
            </div>
          )}
          {isSaving && (
            <div className="p-2 bg-blue-50 border-t border-blue-200 text-sm text-blue-700">
              Voorkeuren opslaan...
            </div>
          )}
          {saveError && !isSaving && (
            <div className="p-2 bg-red-50 border-t border-red-200 text-sm text-red-700">
              {saveError} - de laatste wijziging is niet opgeslagen en teruggezet.
            </div>
          )}
          {hasChanged && !isSaving && (
            <div className="p-2 bg-green-50 border-t border-green-200 text-sm text-green-700">
              Voorkeuren opgeslagen
            </div>
          )}
        </div>
      )}

      {/* Right-click / long-press menu: pick a level directly instead of
          clicking through the cycle. Position clamped to the viewport so it
          never overflows off a narrow (375px) screen. */}
      {contextMenu && (() => {
        const menuWidth = 176;
        const currentLevel = preferences.get(contextMenu.datum)?.slots.get(contextMenu.teller)?.level ?? null;
        const left = Math.min(contextMenu.x, window.innerWidth - menuWidth - 8);
        const top = Math.min(contextMenu.y, window.innerHeight - 172);

        return (
          <div
            role="menu"
            className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white shadow-lg py-1"
            style={{ left, top }}
          >
            <div className="px-3 py-1.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-wide">
              {COUNTER_LABEL[contextMenu.teller] || contextMenu.teller}
            </div>
            {MENU_LEVELS.map((level) => (
              <button
                key={level ?? 'NEUTRAL'}
                role="menuitem"
                onClick={() => selectContextMenuLevel(level)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-neutral-100
                  ${currentLevel === level ? 'font-semibold text-blue-700' : 'text-neutral-800'}`}
              >
                <span className="w-4 text-center">{currentLevel === level ? '✓' : ''}</span>
                {level ? GLYPH[level] : ''} {level ? LEVEL_LABEL[level] : 'Beschikbaar'}
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

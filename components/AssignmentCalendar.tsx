'use client';

/**
 * Assignment Calendar Component
 *
 * Calendar view of a period's roster - the same month-card/week-grid
 * layout as PreferencesCalendar, showing who's on duty per day. Unlike
 * before, this now shows the FULL slot grid (empty days included, not
 * just ones already assigned) and lets a planner right-click any day to
 * assign/reassign/unassign it directly - the same actions AssignmentGrid's
 * table offers, just from the calendar. This works at any period status
 * from OPEN onward (not just after the solver has run): a planner can
 * lock in a strong preference (e.g. a holiday) by hand before generating -
 * see generate-roster/route.ts's manual_assignments handling for why the
 * solver then respects it for the window rule and the streefbereik.
 */

import { useEffect, useState, useCallback } from 'react';
import { parseISO, getHolidayInfo } from '@/lib/holidays';
import { buildMonthGroups } from '@/lib/calendarMonths';

interface SlotAssignment {
  id: string;
  person_id: string;
  codenaam: string;
  bron: string;
}

interface Slot {
  slot_id: string;
  datum: string;
  iso_week: number;
  teller: string; // AVOND | WEEKEND | FEESTDAG
  is_feestdag: boolean;
  feestdag_naam: string | null;
  assignment: SlotAssignment | null;
}

// Mirrors lib/rosterGaps.ts's EligibilityCategory - see AssignmentGrid.tsx/
// FillGapsPanel.tsx, which each keep their own copy of this same constant
// rather than a shared module (matches the existing convention here).
type EligibilityCategory = 'BESCHIKBAAR' | 'VOORKEUR' | 'LIEVER_NIET' | 'VENSTERBLOK' | 'PARTTIME' | 'GEBLOKKEERD';

interface EligiblePerson {
  id: string;
  codenaam: string;
  category: EligibilityCategory;
}

interface Props {
  periodId: string;
  periodStatus?: string;
  onChanged?: () => void;
}

interface ContextMenuState {
  slotId: string;
  datum: string;
  teller: string;
  currentAssignment: SlotAssignment | null;
  x: number;
  y: number;
}

const WEEKDAY_TAG = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']; // index 0-6 = Monday..Sunday
const SHIFT_COUNTERS = ['AVOND', 'WEEKEND', 'FEESTDAG'];

const COUNTER_LABEL: Record<string, string> = {
  AVOND: 'Avonddienst',
  WEEKEND: 'Weekenddienst',
  FEESTDAG: 'Feestdagdienst',
};

// One fixed letter per counter, same convention as PreferencesCalendar's
// button glyphs, so the two calendars read consistently.
const COUNTER_TAG: Record<string, string> = {
  AVOND: 'A',
  WEEKEND: 'W',
  FEESTDAG: 'F',
};

const CATEGORY_ORDER: EligibilityCategory[] = [
  'VOORKEUR',
  'BESCHIKBAAR',
  'LIEVER_NIET',
  'VENSTERBLOK',
  'PARTTIME',
  'GEBLOKKEERD',
];

const CATEGORY_GROUP_LABELS: Record<EligibilityCategory, string> = {
  VOORKEUR: 'Heeft voorkeur voor deze dag',
  BESCHIKBAAR: 'Beschikbaar',
  LIEVER_NIET: 'Liever niet op deze dag',
  VENSTERBLOK: 'Dienst valt in vensterblok',
  PARTTIME: 'Part-time dag',
  GEBLOKKEERD: 'Geblokkeerd',
};

function groupByCategory(people: EligiblePerson[]): Array<[EligibilityCategory, EligiblePerson[]]> {
  const groups = new Map<EligibilityCategory, EligiblePerson[]>();
  for (const person of people) {
    if (!groups.has(person.category)) groups.set(person.category, []);
    groups.get(person.category)!.push(person);
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => [c, groups.get(c)!]);
}

export function AssignmentCalendar({ periodId, periodStatus, onChanged }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [periodRange, setPeriodRange] = useState<{ start: string; end: string } | null>(null);
  // datum -> teller -> slot (each day has exactly one slot, categorized
  // into whichever counter applies - see lib/slotPersistence.ts - but
  // this stays keyed by both in case that ever changes).
  const [byDay, setByDay] = useState<Map<string, Map<string, Slot>>>(new Map());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [eligiblePeople, setEligiblePeople] = useState<EligiblePerson[] | null>(null);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [eligibleError, setEligibleError] = useState<string | null>(null);
  // Set only when periodStatus === 'GEPUBLICEERD': the action a click
  // would take, held back until a reason is typed and confirmed.
  const [pendingAction, setPendingAction] = useState<
    { type: 'assign' | 'reassign'; personId: string; codenaam: string } | { type: 'remove' } | null
  >(null);
  const [pendingReason, setPendingReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isPublished = periodStatus === 'GEPUBLICEERD';

  const loadSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [periodRes, slotsRes] = await Promise.all([
        fetch(`/api/periods/${periodId}`),
        fetch(`/api/planner/period/${periodId}/slots`),
      ]);
      const periodData = await periodRes.json();
      const slotsData = await slotsRes.json();

      const start = periodData?.data?.start_datum;
      const end = periodData?.data?.eind_datum;
      if (!start || !end) {
        setError('Periodegegevens konden niet geladen worden');
        return;
      }
      setPeriodRange({ start, end });

      if (!slotsRes.ok || !slotsData?.success) {
        throw new Error('Laden van rooster mislukt');
      }

      const map = new Map<string, Map<string, Slot>>();
      for (const slot of (slotsData.data || []) as Slot[]) {
        if (!map.has(slot.datum)) map.set(slot.datum, new Map());
        map.get(slot.datum)!.set(slot.teller, slot);
      }
      setByDay(map);
    } catch {
      setError('Laden van rooster mislukt');
    } finally {
      setLoading(false);
    }
  }, [periodId]);

  useEffect(() => {
    loadSlots();
  }, [loadSlots]);

  const openContextMenu = useCallback(
    (e: React.MouseEvent, slot: Slot) => {
      e.preventDefault();
      e.stopPropagation();
      setEligiblePeople(null);
      setEligibleError(null);
      setPendingAction(null);
      setPendingReason('');
      setActionError(null);
      setContextMenu({
        slotId: slot.slot_id,
        datum: slot.datum,
        teller: slot.teller,
        currentAssignment: slot.assignment,
        x: e.clientX,
        y: e.clientY,
      });
    },
    []
  );

  // Dismiss on an outside click, a right-click elsewhere, Escape, or
  // scrolling the page out from under a menu positioned at a fixed pixel
  // coordinate - same mechanics as PreferencesCalendar's own context menu.
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

  // Fetch who's eligible for this slot as soon as the menu opens.
  useEffect(() => {
    if (!contextMenu) return;
    let cancelled = false;
    setEligibleLoading(true);
    fetch(`/api/planner/period/${periodId}/slots/${contextMenu.slotId}/eligible-people`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data?.success) throw new Error();
        setEligiblePeople(data.data || []);
      })
      .catch(() => {
        if (!cancelled) setEligibleError('Laden van beschikbare medewerkers mislukt');
      })
      .finally(() => {
        if (!cancelled) setEligibleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contextMenu, periodId]);

  const runAction = useCallback(
    async (action: { type: 'assign' | 'reassign'; personId: string } | { type: 'remove' }, reason: string) => {
      if (!contextMenu) return;
      setActionBusy(true);
      setActionError(null);
      try {
        let res: Response;
        if (action.type === 'remove') {
          const assignmentId = contextMenu.currentAssignment!.id;
          res = await fetch(`/api/planner/period/${periodId}/assignments/${assignmentId}/delete`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason.trim() || null }),
          });
        } else if (action.type === 'reassign') {
          const assignmentId = contextMenu.currentAssignment!.id;
          res = await fetch(`/api/planner/period/${periodId}/assignments/${assignmentId}/reassign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: action.personId, reason: reason.trim() || null }),
          });
        } else {
          res = await fetch(`/api/planner/period/${periodId}/assignments/manual-assign`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_id: action.personId, slot_id: contextMenu.slotId, reason: reason.trim() || null }),
          });
        }

        const data = await res.json();
        if (!res.ok || !data?.success) {
          throw new Error((typeof data?.error === 'string' ? data.error : data?.error?.message) || 'Bijwerken van toewijzing mislukt');
        }

        setContextMenu(null);
        setPendingAction(null);
        setPendingReason('');
        await loadSlots();
        onChanged?.();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Bijwerken van toewijzing mislukt');
      } finally {
        setActionBusy(false);
      }
    },
    [contextMenu, periodId, loadSlots, onChanged]
  );

  const handlePick = useCallback(
    (personId: string, codenaam: string) => {
      const type: 'assign' | 'reassign' = contextMenu?.currentAssignment ? 'reassign' : 'assign';
      if (isPublished) {
        setPendingAction({ type, personId, codenaam });
        return;
      }
      runAction({ type, personId }, '');
    },
    [contextMenu, isPublished, runAction]
  );

  const handleRemove = useCallback(() => {
    if (isPublished) {
      setPendingAction({ type: 'remove' });
      return;
    }
    runAction({ type: 'remove' }, '');
  }, [isPublished, runAction]);

  if (loading) {
    return <div className="p-4 text-center text-neutral-600">Rooster laden...</div>;
  }

  if (error) {
    return <div className="p-4 text-center text-red-600">{error}</div>;
  }

  if (!periodRange) {
    return <div className="p-4 text-center text-neutral-500">Geen periode gevonden</div>;
  }

  const monthGroups = buildMonthGroups(parseISO(periodRange.start), parseISO(periodRange.end));

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-neutral-600">
        {SHIFT_COUNTERS.map((counter) => (
          <span key={counter} className="flex items-center gap-1.5">
            <i className="inline-flex items-center justify-center w-5 h-4 rounded border border-neutral-300 bg-white text-[9px] font-bold">
              {COUNTER_TAG[counter]}
            </i>
            {COUNTER_LABEL[counter]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <i className="weekend-slot inline-block w-5 h-4 rounded" />
          Weekend
        </span>
        <span className="flex items-center gap-1.5">
          <i className="holiday-slot inline-block w-5 h-4 rounded" />
          Feestdag (naam in het vakje)
        </span>
      </div>
      <p className="text-xs text-neutral-500">
        Klik met de rechtermuisknop op een dienst om deze handmatig toe te wijzen, te wisselen of
        te verwijderen.
      </p>

      {/* Calendar, one card per calendar month */}
      {monthGroups.map((group) => (
        <div key={group.label} className="border border-neutral-200 rounded-lg p-3 bg-neutral-50/50">
          <h3 className="text-sm font-bold text-neutral-800 mb-2 capitalize">{group.label}</h3>
          <div className="w-full overflow-x-auto">
            <table className="w-full table-fixed border-separate" style={{ borderSpacing: '3px' }}>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-neutral-500">
                  <th className="w-9 text-center font-semibold pb-1">wk</th>
                  {WEEKDAY_TAG.map((d) => (
                    <th key={d} className="font-semibold pb-1">{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.weeks.map((week, weekIdx) => (
                  <tr key={`week-${weekIdx}`}>
                    <td className="week-number text-center align-top pt-2">{week.isoWeek}</td>
                    {week.days.map((datum, dayIdx) => {
                      if (datum === null) {
                        return <td key={`blank-${weekIdx}-${dayIdx}`} className="p-0" />;
                      }

                      const isWeekendDay = dayIdx === 5 || dayIdx === 6;
                      const holiday = getHolidayInfo(datum);
                      const tag = holiday ? holiday.name : WEEKDAY_TAG[dayIdx];
                      const daySlots = byDay.get(datum);

                      return (
                        <td key={datum} className="align-top p-0">
                          <div
                            className={`relative min-h-[92px] rounded-lg border p-1.5 pt-1
                              ${holiday ? 'holiday-slot' : isWeekendDay ? 'weekend-slot' : 'border-neutral-200 bg-white'}`}
                          >
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
                              {SHIFT_COUNTERS.map((counter) => {
                                const slot = daySlots?.get(counter);
                                if (!slot) return null;
                                const assignment = slot.assignment;

                                return (
                                  <div
                                    key={`${datum}-${counter}`}
                                    onContextMenu={(e) => openContextMenu(e, slot)}
                                    role="button"
                                    tabIndex={-1}
                                    title={
                                      assignment
                                        ? `${COUNTER_LABEL[counter] || counter}: ${assignment.codenaam} (rechtsklik om te wijzigen)`
                                        : `${COUNTER_LABEL[counter] || counter}: nog niemand toegewezen (rechtsklik om in te vullen)`
                                    }
                                    className={`w-full rounded border px-1 py-0.5 cursor-context-menu select-none
                                      ${assignment ? 'bg-blue-50 border-blue-100' : 'bg-neutral-50 border-dashed border-neutral-300'}`}
                                  >
                                    <span className={`text-[8px] font-bold uppercase ${assignment ? 'text-blue-600' : 'text-neutral-400'}`}>
                                      {COUNTER_TAG[counter]}
                                    </span>
                                    <div className={`text-[10px] leading-tight truncate ${assignment ? 'font-semibold text-neutral-900' : 'italic text-neutral-400'}`}>
                                      {assignment ? assignment.codenaam : 'leeg'}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Right-click menu */}
      {contextMenu && (() => {
        const menuWidth = 240;
        const left = Math.min(contextMenu.x, window.innerWidth - menuWidth - 8);
        const top = Math.min(contextMenu.y, window.innerHeight - 320);

        return (
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
            className="fixed z-50 w-60 max-h-80 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg py-1"
            style={{ left, top }}
          >
            <div className="px-3 py-1.5 border-b border-neutral-100">
              <div className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wide">
                {parseISO(contextMenu.datum).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })}
                {' · '}
                {COUNTER_LABEL[contextMenu.teller] || contextMenu.teller}
              </div>
              <div className="text-xs text-neutral-700 mt-0.5">
                {contextMenu.currentAssignment
                  ? `Nu: ${contextMenu.currentAssignment.codenaam}`
                  : 'Nog niemand toegewezen'}
              </div>
            </div>

            {actionError && (
              <div className="px-3 py-1.5 text-xs text-red-700 bg-red-50 border-b border-red-100">
                {actionError}
              </div>
            )}

            {pendingAction ? (
              <div className="px-3 py-2 space-y-2">
                <p className="text-xs text-neutral-700">
                  {pendingAction.type === 'remove'
                    ? 'Weet je zeker dat je deze toewijzing wilt verwijderen?'
                    : `Wijs toe aan ${pendingAction.codenaam}?`}
                </p>
                <input
                  type="text"
                  value={pendingReason}
                  onChange={(e) => setPendingReason(e.target.value)}
                  placeholder="Reden (verplicht bij gepubliceerd rooster)"
                  className="w-full px-2 py-1 border rounded text-xs"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    disabled={actionBusy || !pendingReason.trim()}
                    onClick={() =>
                      runAction(
                        pendingAction.type === 'remove'
                          ? { type: 'remove' }
                          : { type: pendingAction.type, personId: pendingAction.personId },
                        pendingReason
                      )
                    }
                    className="flex-1 px-2 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300"
                  >
                    {actionBusy ? 'Bezig…' : 'Bevestigen'}
                  </button>
                  <button
                    onClick={() => {
                      setPendingAction(null);
                      setPendingReason('');
                    }}
                    className="flex-1 px-2 py-1 rounded text-xs font-medium bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
                  >
                    Annuleren
                  </button>
                </div>
              </div>
            ) : (
              <>
                {contextMenu.currentAssignment && (
                  <button
                    role="menuitem"
                    disabled={actionBusy}
                    onClick={handleRemove}
                    className="w-full text-left px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    ✕ Niemand toewijzen
                  </button>
                )}

                {eligibleLoading && (
                  <div className="px-3 py-2 text-xs text-neutral-500">Laden…</div>
                )}
                {eligibleError && (
                  <div className="px-3 py-2 text-xs text-red-600">{eligibleError}</div>
                )}
                {eligiblePeople &&
                  groupByCategory(eligiblePeople).map(([category, people]) => (
                    <div key={category}>
                      <div className="px-3 pt-2 pb-0.5 text-[10px] font-semibold text-neutral-500 uppercase tracking-wide">
                        {CATEGORY_GROUP_LABELS[category]}
                      </div>
                      {people.map((person) => (
                        <button
                          key={person.id}
                          role="menuitem"
                          disabled={actionBusy}
                          onClick={() => handlePick(person.id, person.codenaam)}
                          className="w-full text-left px-3 py-1 text-sm text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
                        >
                          {person.codenaam}
                        </button>
                      ))}
                    </div>
                  ))}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}

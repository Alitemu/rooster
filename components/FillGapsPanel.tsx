'use client';

/**
 * Fill Gaps Panel
 *
 * Shows shift slots nobody is assigned to yet - either because the solver
 * hasn't run for this period at all (a planner can pre-fill strong
 * preferences, e.g. a holiday, before generating - see
 * generate-roster/route.ts's manual_assignments handling for why the
 * solver then respects them), or because it ran but couldn't fully cover
 * them (capacity/band limits are soft constraints - see
 * solver/constraints.py). Either way lets the planner stage someone for
 * each one, in consultation with the person on duty,
 * before committing anything. Picking someone in the dropdown only stages
 * a draft choice (kept in this browser's localStorage so it survives a
 * reload or coming back later) - the day stays listed as unfilled, and
 * nothing is actually assigned until "Alle toewijzingen toepassen" is
 * clicked. That matters here specifically because filling a gap by hand
 * often means waiting on a colleague's answer ("would you take this
 * blocked day after all?") before it's final - an immediate per-row
 * commit made a wrong click impossible to casually reconsider, and made
 * the day vanish from the list the moment you picked someone, which is
 * the opposite of what a planner reviewing several gaps at once wants.
 *
 * Calls the same manual-assign endpoint used for any manual override -
 * everyone in the pool is offered, grouped by category so a blocked,
 * window-conflicted, or preference-marked person is never hidden, just
 * clearly marked before the planner picks them.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// Mirrors lib/rosterGaps.ts's EligibilityCategory - see the priority-order
// comment there for why a person can only ever be in one of these.
type EligibilityCategory = 'BESCHIKBAAR' | 'VOORKEUR' | 'LIEVER_NIET' | 'VENSTERBLOK' | 'PARTTIME' | 'GEBLOKKEERD';

interface EligiblePerson {
  id: string;
  codenaam: string;
  category: EligibilityCategory;
}

interface UnfilledSlot {
  slot_id: string;
  datum: string;
  iso_week: number;
  teller: string;
  benodigd_aantal_personen: number;
  assigned_count: number;
  shortfall: number;
  eligible_people: EligiblePerson[];
}

interface Props {
  periodId: string;
  onAllFilled?: () => void;
  /**
   * Called after handleApplyAll successfully applies at least one staged
   * pick - even a partial apply (some slots still open afterward, so
   * onAllFilled doesn't fire) changes what's actually assigned. The
   * assignments list/calendar living in PlannerDashboard have no other way
   * to notice, since they only ever see the same unchanging periodId.
   */
  onAssignmentsChanged?: () => void;
}

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'Avond',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Feestdag',
};

// Display order for the grouped menu, and the group headings - best
// candidates first (VOORKEUR), most cautionary last (GEBLOKKEERD).
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

// Short note shown next to a selected non-available person.
const CATEGORY_NOTES: Record<EligibilityCategory, string> = {
  VOORKEUR: 'heeft aangegeven deze dag te willen werken',
  BESCHIKBAAR: '',
  LIEVER_NIET: 'heeft aangegeven liever niet op deze dag te werken',
  VENSTERBLOK: 'heeft al een dienst binnen het venster',
  PARTTIME: 'heeft parttime-vrij op deze dag',
  GEBLOKKEERD: 'heeft deze dag geblokkeerd',
};

function groupByCategory(people: EligiblePerson[]): Array<[EligibilityCategory, EligiblePerson[]]> {
  return CATEGORY_ORDER.map(
    (cat): [EligibilityCategory, EligiblePerson[]] => [cat, people.filter((p) => p.category === cat)]
  ).filter(([, group]) => group.length > 0);
}

function draftStorageKey(periodId: string): string {
  return `dienstrooster-fillgaps-draft-${periodId}`;
}

export function FillGapsPanel({ periodId, onAllFilled, onAssignmentsChanged }: Props) {
  const [slots, setSlots] = useState<UnfilledSlot[] | null>(null);
  // slot_id -> staged (not yet applied) person_id.
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Restore any draft left over from a previous visit - before the first
  // load() below runs, so its "drop selections for slots no longer open"
  // pruning (see load()) still applies to whatever gets restored here.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftStorageKey(periodId));
      if (raw) setSelection(JSON.parse(raw));
    } catch {
      // Corrupt or unavailable storage - start with an empty draft rather
      // than fail the whole panel over it.
    }
  }, [periodId]);

  // Keep the draft in localStorage in sync - a planner closing the tab
  // mid-review (e.g. to go check with someone) must not lose their
  // in-progress picks.
  //
  // The restore effect above runs first on mount, but the setSelection it
  // calls doesn't take effect until the next render - this effect's own
  // closure still sees the pre-restore (empty) `selection` on that very
  // first run. Writing then would immediately clobber the draft this same
  // mount is in the middle of restoring, before it's even rendered once.
  // Skipping exactly the first run avoids that; the second run (triggered
  // once the restored `selection` actually lands) persists the real value.
  const skippedFirstPersist = useRef(false);
  useEffect(() => {
    if (!skippedFirstPersist.current) {
      skippedFirstPersist.current = true;
      return;
    }
    try {
      localStorage.setItem(draftStorageKey(periodId), JSON.stringify(selection));
    } catch {
      // Unavailable (private browsing, quota) - selections still work for
      // this page load, they just won't survive a reload.
    }
  }, [periodId, selection]);

  // A failed load used to leave `slots` at null forever, and the render
  // below returns null for that case - the whole panel (including any
  // "N diensten nog niet ingevuld" warning) would silently vanish, so a
  // planner could publish an actually-incomplete roster without ever
  // seeing that. loadError is tracked separately so a failure always
  // renders something.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/planner/period/${periodId}/unfilled-slots`);
      const data = await res.json();
      if (!res.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Laden van openstaande diensten mislukt');
      setLoadError(null);
      setSlots(data.data);

      // Drop staged picks for slots that are no longer open - filled by
      // someone else meanwhile, or just applied - so the draft never
      // offers to (re-)apply a slot that doesn't need it anymore.
      const stillOpen = new Set((data.data as UnfilledSlot[]).map((s) => s.slot_id));
      setSelection((prev) => {
        const next: Record<string, string> = {};
        for (const [slotId, personId] of Object.entries(prev)) {
          if (stillOpen.has(slotId)) next[slotId] = personId;
        }
        return next;
      });

      if (data.data.length === 0 && onAllFilled) onAllFilled();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Laden van openstaande diensten mislukt');
    }
  }, [periodId, onAllFilled]);

  useEffect(() => {
    load();
  }, [load]);

  const stagedCount = Object.keys(selection).length;

  const handleApplyAll = async () => {
    const entries = Object.entries(selection);
    if (entries.length === 0) return;

    setApplying(true);
    setError(null);
    setWarning(null);

    const failures: string[] = [];
    const warnings: string[] = [];

    for (const [slotId, personId] of entries) {
      try {
        const res = await fetch(`/api/planner/period/${periodId}/assignments/manual-assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ person_id: personId, slot_id: slotId, reason: 'Handmatig aangevuld' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || 'Toewijzen mislukt');
        if (data.data?.warning) warnings.push(data.data.warning.message);
      } catch (err) {
        const slot = slots?.find((s) => s.slot_id === slotId);
        const label = slot
          ? `${new Date(slot.datum).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' })} (${TELLER_LABELS[slot.teller] || slot.teller})`
          : slotId;
        failures.push(`${label}: ${err instanceof Error ? err.message : 'Toewijzen mislukt'}`);
      }
    }

    if (warnings.length > 0) setWarning(warnings.join(' · '));
    if (failures.length > 0) {
      setError(
        `${failures.length} van de ${entries.length} toewijzingen zijn niet gelukt - de rest is toegepast. ${failures.join('; ')}`
      );
    }

    // At least one of the staged picks actually landed - the planner
    // dashboard's assignments list/calendar (and its imbalance numbers)
    // are now stale and have no other way to find out (see
    // onAssignmentsChanged's own docstring). Skipped when every single one
    // failed, since nothing actually changed in that case.
    if (failures.length < entries.length) {
      onAssignmentsChanged?.();
    }

    // Reloading re-derives `slots` from the database and (via load()'s own
    // pruning) drops every staged pick that got applied successfully -
    // only picks for slots still open (including any that just failed)
    // survive, so a retry doesn't need to be redone from scratch.
    await load();
    setApplying(false);
  };

  if (loadError) {
    return (
      <div className="card p-4 bg-red-50 border border-red-200 flex items-center justify-between gap-3">
        <p className="text-sm text-red-800">⚠️ {loadError}</p>
        <button
          onClick={() => load()}
          className="shrink-0 px-3 py-1.5 rounded text-sm font-medium bg-red-600 text-white hover:bg-red-700"
        >
          Opnieuw proberen
        </button>
      </div>
    );
  }

  if (slots === null) {
    return null;
  }

  if (slots.length === 0) {
    return (
      <div className="card p-4 bg-green-50 border border-green-200">
        <p className="text-sm text-green-900 font-medium">
          ✓ Elke dienst in dit rooster is ingevuld.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-6 bg-amber-50 border border-amber-200">
      <h3 className="font-semibold text-amber-900 mb-1">
        ⚠️ {slots.length} dienst{slots.length === 1 ? '' : 'en'} nog niet ingevuld
      </h3>
      <p className="text-sm text-amber-800 mb-4">
        Deze diensten hebben nog niemand toegewezen - bijvoorbeeld omdat de solver nog niet is
        gedraaid, of omdat er binnen de ingestelde grenzen niemand beschikbaar was. Kies hieronder
        rustig iemand per dienst - dit wordt pas echt toegewezen zodra je op &quot;Alle
        toewijzingen toepassen&quot; klikt, dus je kunt gerust wachten op een reactie voordat je
        doorgaat.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-sm text-red-800">
          {error}
        </div>
      )}

      {warning && (
        <div className="mb-4 p-3 rounded bg-orange-50 border border-orange-300 text-sm text-orange-900">
          ⚠️ {warning}
        </div>
      )}

      <div className="space-y-2">
        {slots.map((slot) => {
          const selectedPerson = slot.eligible_people.find((p) => p.id === selection[slot.slot_id]);
          const groups = groupByCategory(slot.eligible_people);
          return (
            <div
              key={slot.slot_id}
              className={`flex items-center justify-between gap-3 p-3 rounded bg-white border ${
                selectedPerson ? 'border-green-300' : 'border-amber-200'
              }`}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-neutral-900">
                  {new Date(slot.datum).toLocaleDateString('nl-NL', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                  })}{' '}
                  · {TELLER_LABELS[slot.teller] || slot.teller}
                </p>
                <p className="text-xs text-neutral-500">
                  Week {slot.iso_week} · {slot.assigned_count}/{slot.benodigd_aantal_personen} ingevuld
                </p>
                {selectedPerson && selectedPerson.category !== 'BESCHIKBAAR' && (
                  <p className="text-xs text-orange-700 mt-1">
                    ⚠️ {selectedPerson.codenaam} {CATEGORY_NOTES[selectedPerson.category]}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {slot.eligible_people.length === 0 ? (
                  <span className="text-xs text-red-600">Niemand in de pool beschikbaar</span>
                ) : (
                  <>
                    {selectedPerson && (
                      <span className="text-xs text-green-700 font-medium" title="Klaar om toe te passen">
                        ✓ Klaar
                      </span>
                    )}
                    <select
                      className="text-sm border border-neutral-300 rounded px-2 py-1"
                      value={selection[slot.slot_id] || ''}
                      disabled={applying}
                      onChange={(e) =>
                        setSelection((prev) => {
                          if (!e.target.value) {
                            const next = { ...prev };
                            delete next[slot.slot_id];
                            return next;
                          }
                          return { ...prev, [slot.slot_id]: e.target.value };
                        })
                      }
                    >
                      <option value="">Kies iemand…</option>
                      {groups.map(([category, people]) => (
                        <optgroup
                          key={category}
                          label={`${CATEGORY_GROUP_LABELS[category]} (${people.length})`}
                        >
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.codenaam}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 pt-4 border-t border-amber-200 flex items-center justify-between gap-3">
        <p className="text-xs text-amber-800">
          {stagedCount === 0
            ? 'Nog geen keuzes gemaakt.'
            : `${stagedCount} van de ${slots.length} klaar om toe te passen.`}
        </p>
        <button
          onClick={handleApplyAll}
          disabled={stagedCount === 0 || applying}
          className="px-4 py-2 rounded font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:bg-neutral-300 transition-colors"
        >
          {applying ? 'Bezig…' : `Alle toewijzingen toepassen${stagedCount > 0 ? ` (${stagedCount})` : ''}`}
        </button>
      </div>
    </div>
  );
}

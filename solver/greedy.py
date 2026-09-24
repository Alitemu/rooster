"""
Greedy randomized construction ("Gerandomiseerde planner")

A fundamentally different approach from solver.py's CP-SAT models: instead
of one joint model searched as a whole, this walks slots one at a time and
assigns the first eligible candidate from a randomized people list - no
backtracking. Two variants (RuleSet-equivalent `variant` argument):

- 'medewerker': days in chronological order, employee list freshly
  randomized for each slot.
- 'dagen': days ALSO in randomized order (employee list randomization is
  the same as 'medewerker' - only the day order differs).

Deliberately kept in its own module, never imported by solver.py/
constraints.py/objective.py and never touching a cp_model.CpModel - a bug
here can't affect the CP-SAT paths (Puntenplanner/Prioriteitenplanner) at
all, by construction.

No backtracking means this can leave slots unfilled, or leave someone
under their band minimum, in cases the CP-SAT solvers would have found a
feasible full assignment for - an accepted, known trade-off of this
approach (see the "denkfout" discussion this was shelved from earlier),
not a bug to fix here. What it must never do is violate a hard rule
(ABSOLUUT, window, holiday spread) or push someone over their band
maximum - see _eligible_candidates below for exactly how those are
enforced by construction, the same way CP-SAT's hard model.Add()s do.

One call here = one construction attempt. Repeating this multiple times
with a different random_seed and keeping the best (same "Herhaalplanner"
idea, same isBetterRoster ranking) is orchestrated by Next.js
(generate-roster/route.ts's runMultiStart), calling POST /solve-greedy
once per attempt - not looped in here, so the exact same progress/cancel
machinery already built for the CP-SAT multi-start ("Herhaalplanner") is
reused as-is instead of needing a second, parallel implementation of that
loop in Python.
"""

import logging
import math
import random
import time
from typing import Literal, Optional

from constraints import _week_ordinal

logger = logging.getLogger(__name__)

Variant = Literal['medewerker', 'dagen']


def _compute_actual_band(
    base_min: int,
    base_max: int,
    delta: int,
    already: int,
    coverage_factor: float,
    participation_factor: float,
    distribution_mode: str,
) -> tuple[int, int]:
    """
    Mirrors constraints.add_band_constraints' scaling exactly (coverage
    factor always applied, NAAR_RATO factor only when distribution_mode
    asks for it, floor/ceil to keep width >= 1, then the ledger delta and
    already_assigned offset) - this app already carries the identical
    calculation a second time in objective.py's add_band_imbalance_objective
    ("must stay in lockstep" comment there), so a third copy here follows
    that same established pattern rather than refactoring two working,
    tested CP-SAT files to share it.
    """
    base_min = math.floor(base_min * coverage_factor)
    base_max = max(base_min, math.ceil(base_max * coverage_factor))

    if distribution_mode == 'NAAR_RATO':
        base_min = math.floor(base_min * participation_factor)
        base_max = max(base_min, math.ceil(base_max * participation_factor))

    actual_min = base_min + delta - already
    actual_max = base_max + delta - already
    return actual_min, actual_max


def run_greedy_construction(
    people: list[str],
    slots: list[dict],
    blocked_slots: set[tuple[str, str]],
    soft_slots: dict[tuple[str, str], float],
    band_ranges: dict[str, tuple[int, int]],
    balances: dict[str, dict[str, int]],
    window_weeks: int = 2,
    preferred_slots: Optional[dict[tuple[str, str], float]] = None,
    prior_assignments: Optional[list[dict]] = None,
    manual_assignments: Optional[list[dict]] = None,
    distribution_mode: str = 'GELIJK',
    participation_factors: Optional[dict[str, float]] = None,
    coverage_factors: Optional[dict[str, float]] = None,
    band_overrides: Optional[dict[str, dict[str, tuple[int, int]]]] = None,
    holiday_spread_weeks: int = 0,
    variant: Variant = 'medewerker',
    random_seed: Optional[int] = None,
    window_weeks_avond: Optional[int] = None,
    window_weeks_weekend_feestdag: Optional[int] = None,
) -> dict:
    """
    One construction attempt. Returns the same result shape
    solver.py's generate_roster does (see that function's diagnostics dict)
    so Next.js can compare a greedy attempt against another, or (in
    principle) against a lexicographic one, with the exact same
    isBetterRoster/isPerfectRoster logic.

    window_weeks_avond/window_weeks_weekend_feestdag: same meaning and
    same backward-compat default as solver.py's build_model - both None
    (the only state a period frozen before this existed can ever be in)
    keeps the single pooled window_weeks exactly as it always worked (one
    shared window across every teller, a shift of any type excluding a
    nearby shift of any type).

    Either one set instead applies the planner's own explicit rule: "een
    weekenddienst kan wel een avonddienst blokkeren en andersom... het
    minimum geldt dan voor alle diensten" - AVOND and WEEKEND+FEESTDAG each
    keep their own (typically larger) same-type cap, but the *smaller* of
    the two windows still applies as a floor between every pair of shifts
    regardless of type - see _window_group/window_ok below, mirroring
    solver.py's build_model's three-constraint decomposition (a pooled
    call at the floor, plus one call per group at its own value) in
    imperative form.
    """
    start = time.time()
    rng = random.Random(random_seed)

    preferred_slots = preferred_slots or {}
    prior_assignments = prior_assignments or []
    manual_assignments = manual_assignments or []
    participation_factors = participation_factors or {}
    coverage_factors = coverage_factors or {}
    band_overrides = band_overrides or {}
    counters = ['AVOND', 'WEEKEND', 'FEESTDAG']

    per_teller_windows = window_weeks_avond is not None or window_weeks_weekend_feestdag is not None
    cross_type_floor = min(window_weeks_avond or 0, window_weeks_weekend_feestdag or 0) if per_teller_windows else 0

    def _window_group(counter: str) -> str:
        return 'avond' if counter == 'AVOND' else 'weekend_feestdag'

    def _own_window_weeks_for(counter: str) -> int:
        return (window_weeks_avond or 0) if counter == 'AVOND' else (window_weeks_weekend_feestdag or 0)

    # already_assigned: manual pre-fills count toward this period's band
    # target (mirrors solver.py's build_model) - prior_assignments do not,
    # they're from a previous period.
    already_assigned: dict[str, dict[str, int]] = {}
    for fact in manual_assignments:
        counts = already_assigned.setdefault(fact['person_id'], {})
        counts[fact['teller']] = counts.get(fact['teller'], 0) + 1

    # Running per-person assignment counts, seeded from already_assigned -
    # incremented as this attempt assigns slots, so band eligibility below
    # always reflects "how many of this counter does this person have so
    # far, this period" (manual pre-fills + everything assigned up to now).
    assigned_count: dict[str, dict[str, int]] = {
        p: dict(already_assigned.get(p, {})) for p in people
    }

    # Per-person set(s) of assigned week-ordinals, seeded from prior +
    # manual assignments (the same "immovable facts" solver.py folds in).
    # Every fact populates BOTH a 'pooled' set (all tellers together, used
    # for the cross-type floor / legacy pooled check) AND its own group's
    # set (used for that group's own, typically stricter, same-type cap) -
    # window_ok below decides which of these actually get consulted.
    assigned_weeks: dict[str, dict[str, set[int]]] = {p: {} for p in people}
    assigned_feestdag_weeks: dict[str, set[int]] = {p: set() for p in people}
    for fact in prior_assignments + manual_assignments:
        pid = fact['person_id']
        if pid not in assigned_weeks:
            continue
        week = _week_ordinal(fact['datum'])
        assigned_weeks[pid].setdefault('pooled', set()).add(week)
        assigned_weeks[pid].setdefault(_window_group(fact.get('teller', '')), set()).add(week)
        if fact.get('teller') == 'FEESTDAG':
            assigned_feestdag_weeks[pid].add(week)

    def actual_band(person_id: str, counter: str) -> tuple[int, int]:
        # A fixed band for this person and counter (a fellow's weekend):
        # replaces the scaled band and the ledger delta, like
        # constraints.add_band_constraints' band_overrides.
        override = band_overrides.get(person_id, {}).get(counter)
        if override is not None:
            already = already_assigned.get(person_id, {}).get(counter, 0)
            return override[0] - already, override[1] - already
        base_min, base_max = band_ranges.get(counter, (7, 8))
        return _compute_actual_band(
            base_min, base_max,
            delta=balances.get(person_id, {}).get(counter, 0),
            already=already_assigned.get(person_id, {}).get(counter, 0),
            coverage_factor=coverage_factors.get(person_id, 1.0),
            participation_factor=participation_factors.get(person_id, 1.0),
            distribution_mode=distribution_mode,
        )

    def window_ok(person_id: str, week: int, counter: str) -> bool:
        if not per_teller_windows:
            if window_weeks <= 1:
                return True
            return all(
                abs(week - w) >= window_weeks
                for w in assigned_weeks[person_id].get('pooled', set())
            )

        # Cross-type floor: the smaller of the two configured windows still
        # applies between every pair of shifts regardless of type.
        if cross_type_floor > 1 and any(
            abs(week - w) < cross_type_floor
            for w in assigned_weeks[person_id].get('pooled', set())
        ):
            return False

        # This teller's own (typically larger) same-type cap.
        own_weeks = _own_window_weeks_for(counter)
        if own_weeks > 1:
            group = _window_group(counter)
            if any(
                abs(week - w) < own_weeks
                for w in assigned_weeks[person_id].get(group, set())
            ):
                return False

        return True

    def holiday_spread_ok(person_id: str, week: int, is_feestdag: bool) -> bool:
        if not is_feestdag or holiday_spread_weeks <= 1:
            return True
        return all(abs(week - w) >= holiday_spread_weeks for w in assigned_feestdag_weeks[person_id])

    def is_hard_eligible(person_id: str, slot: dict, week: int) -> bool:
        if (person_id, slot['id']) in blocked_slots:
            return False
        if not window_ok(person_id, week, slot['shift_type_name']):
            return False
        if not holiday_spread_ok(person_id, week, slot.get('is_feestdag', False)):
            return False
        return True

    def has_room(person_id: str, counter: str) -> bool:
        current = assigned_count[person_id].get(counter, 0)
        _actual_min, actual_max = actual_band(person_id, counter)
        # No headroom to give ("actual_max <= 0" for someone already deep
        # in negative-balance territory) is a legitimate all-tiers-fail
        # outcome, same as it would be for anyone else at their ceiling.
        return current < actual_max

    def assign_for_slot(slot: dict) -> Optional[str]:
        """
        Picks one person for `slot` out of a freshly randomized order, in
        tiers - voorkeur-and-eligible first, then eligible-without-
        liever-niet, then eligible-with-liever-niet as a last resort.
        Returns None (slot stays short) when nobody in the entire people
        list is eligible without breaking a hard rule or their own band
        maximum - "eerlijk verdelen, koste wat kost": pushing someone over
        their streefwaarde is never done here to avoid a gap, mirroring
        the CP-SAT objective's asymmetric pricing (see objective.py's
        add_band_slack_objective) even though this algorithm has no
        objective/cost to price it with.
        """
        counter = slot['shift_type_name']
        week = _week_ordinal(slot['datum'])

        order = list(people)
        rng.shuffle(order)

        eligible = [
            p for p in order
            if is_hard_eligible(p, slot, week) and has_room(p, counter)
        ]
        if not eligible:
            return None

        preferred = [p for p in eligible if (p, slot['id']) in preferred_slots]
        if preferred:
            return preferred[0]

        not_liever_niet = [p for p in eligible if (p, slot['id']) not in soft_slots]
        if not_liever_niet:
            return not_liever_niet[0]

        return eligible[0]

    # Day ordering: 'medewerker' keeps chronological order; 'dagen'
    # shuffles the day order too (employee-list randomization per slot,
    # above, is identical in both variants).
    slots_by_day: dict[str, list[dict]] = {}
    for slot in slots:
        slots_by_day.setdefault(slot['datum'], []).append(slot)
    days = sorted(slots_by_day.keys())
    if variant == 'dagen':
        rng.shuffle(days)

    assignments: list[dict] = []
    unfilled_slots: list[dict] = []

    for day in days:
        for slot in slots_by_day[day]:
            required = slot.get('benodigd_aantal_personen', 1)
            filled = 0
            for _ in range(required):
                person_id = assign_for_slot(slot)
                if person_id is None:
                    break
                assignments.append({'person_id': person_id, 'slot_id': slot['id']})
                counter = slot['shift_type_name']
                assigned_count[person_id][counter] = assigned_count[person_id].get(counter, 0) + 1
                week = _week_ordinal(slot['datum'])
                assigned_weeks[person_id].setdefault('pooled', set()).add(week)
                assigned_weeks[person_id].setdefault(_window_group(counter), set()).add(week)
                if slot.get('is_feestdag'):
                    assigned_feestdag_weeks[person_id].add(week)
                filled += 1
            if filled < required:
                unfilled_slots.append({'slot_id': slot['id'], 'shortfall': required - filled})

    # Diagnostics - same fields solver.py's generate_roster reports, so
    # Next.js's isBetterRoster/isPerfectRoster (generate-roster/route.ts)
    # work identically regardless of which engine produced a given attempt.
    assigned_pairs = {(a['person_id'], a['slot_id']) for a in assignments}
    soft_block_violations = sum(1 for pair in soft_slots if pair in assigned_pairs)
    preference_matches = sum(1 for pair in preferred_slots if pair in assigned_pairs)

    slot_counters: dict[str, set[str]] = {}
    for slot in slots:
        slot_counters.setdefault(slot['shift_type_name'], set()).add(slot['id'])

    max_band_deviation = 0
    total_band_deviation = 0
    band_violations = 0
    for person_id in people:
        for counter in counters:
            if counter not in slot_counters:
                continue
            current = assigned_count[person_id].get(counter, 0)
            actual_min, actual_max = actual_band(person_id, counter)
            under = max(0, actual_min - current)
            over = max(0, current - actual_max)
            deviation = under + over
            if deviation > 0:
                band_violations += 1
            max_band_deviation = max(max_band_deviation, deviation)
            total_band_deviation += deviation

    elapsed = time.time() - start
    logger.info(
        f"Greedy construction ({variant}, seed={random_seed}) completed in {elapsed:.2f}s: "
        f"{len(assignments)} assignments, {len(unfilled_slots)} slots short"
    )

    return {
        'success': True,
        'assignments': assignments,
        'diagnostics': {
            'total_slots': len(slots),
            'total_assignments': len(assignments),
            'unfilled_slots': unfilled_slots,
            'total_cost': 0,
            'time_seconds': elapsed,
            'solver_status': 'GREEDY',
            'violations': {
                'window_rule': 0,
                'holiday_spread': 0,
                'blocking_absolute': 0,
                'capacity': len(unfilled_slots),
                'band_limit': band_violations,
            },
            'max_band_deviation': max_band_deviation,
            'total_band_deviation': total_band_deviation,
            'soft_block_violations': soft_block_violations,
            'preference_matches': preference_matches,
        },
    }

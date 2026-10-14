"""
CP-SAT Constraint Definitions

Implements hard constraints for roster generation:
1. Window rule (at least 7 * window_weeks days between two shifts)
2. Blocking absolute (ABSOLUUT preferences)
3. Part-time pattern (forced assignments)
4. Capacity (slots need required number of people)
5. Band limits (balance ranges per person per counter)
6. Holiday rotation (fair distribution across group)
"""

import math
from datetime import date, timedelta
from typing import Optional

from ortools.sat.python import cp_model


def _week_ordinal(datum: str) -> int:
    """
    Continuous, year-boundary-safe week index for a slot's date.

    Grouping by the raw iso_week field breaks at a year boundary: ISO week
    numbers reset to 1 at the start of each year, so week 52 (or 53) of one
    year and week 1 of the next look far apart under plain integer
    arithmetic even though they're a single calendar week apart. Anchoring
    on each date's Monday and dividing by 7 gives every week a number that
    increases by exactly 1 from one calendar week to the next, with no
    reset.
    """
    d = date.fromisoformat(datum)
    monday = d - timedelta(days=d.isoweekday() - 1)
    return monday.toordinal() // 7


def _day_ordinal(datum: str) -> int:
    """The date as a day number, so two dates subtract to the days between them."""
    return date.fromisoformat(datum).toordinal()


# Hard ceiling on how far add_band_constraints lets anyone's assignment
# count run past their (possibly ledger-adjusted) band maximum - see that
# function's docstring for why this must be a hard cap, not just a cost.
# 0: nobody is ever pushed past their streefbereik, period - a shift that
# would require it stays unfilled instead, for the planner to resolve by
# hand (see lib/rosterGaps.ts's gap-filling flow and
# lib/rebalanceSuggestions.ts). Kept as a named constant rather than a
# bare 0 at the call site, in case that trade-off is ever revisited.
MAX_BAND_OVERSHOOT = 0


class ConstraintBuilder:
    """Builds and manages CP-SAT constraints"""

    def __init__(self, model: cp_model.CpModel):
        self.model = model
        self.violations = {}

    # ========================================================================
    # Window Rule: at least 7 * window_weeks days between two shifts
    # ========================================================================

    def add_window_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        window_weeks: int,
        counters: Optional[list[str]] = None
    ):
        """
        Constraint: at least 7 * window_weeks days between two shifts of
        one person - at most one assignment in any run of that many
        consecutive days. With a window of 2, a shift on Monday 1 March
        rules out everything up to Sunday 14 March and allows Monday 15
        March again.

        It counted calendar weeks (Monday to Sunday): one shift in any
        `window_weeks` consecutive weeks. A Sunday and the Monday two weeks
        later were then allowed, 8 days apart under a window of 2 and 22
        under a window of 4, where the planner read the setting as days -
        "bij een venster van 2 weken geldt 14 dagen of meer tussen 2
        diensten" (0.22.0).

        Deliberately a forward-only window [d, d + span - 1] applied at
        every day the person could work, rather than a symmetric one: any
        two shifts fewer than `span` days apart both fall inside the window
        starting at the first of them, and a symmetric window would demand
        twice the gap. Day numbers come from the date itself, so a year
        boundary (ISO week 53) is no different from any other day.

        counters: None (default) pools every slot together regardless of
        teller. When given, only slots whose shift_type_name is in this
        list count toward the window for THIS call. solver.py's build_model
        calls this three times for per-teller windows - once with
        counters=None at the smaller of the two configured windows (a
        cross-type floor that still applies between every pair of shifts
        regardless of type, per the planner's own explicit rule), plus once
        per group at that group's own, typically larger, same-type-only
        window - see that function's own comment for the full reasoning.
        """
        self.violations['window_rule'] = 0

        # 0 switches the rule off. 1 means at least 7 days between two
        # shifts; it used to switch the rule off too, and a person could get
        # three evenings in one week (audit 6).
        if window_weeks <= 0:
            return

        relevant_slots = slots if counters is None else [s for s in slots if s.get('shift_type_name') in counters]
        span = 7 * window_weeks

        # Day number -> the slots on that day.
        day_slots: dict[int, list[dict]] = {}
        for slot in relevant_slots:
            day_slots.setdefault(_day_ordinal(slot['datum']), []).append(slot)
        days = sorted(day_slots)

        for person_id in people:
            for i, day in enumerate(days):
                if not any((person_id, slot['id']) in assignment_vars for slot in day_slots[day]):
                    continue
                # Every slot in [day, day + span - 1]: at most one of them.
                window_vars = []
                j = i
                while j < len(days) and days[j] < day + span:
                    for slot in day_slots[days[j]]:
                        if (person_id, slot['id']) in assignment_vars:
                            window_vars.append(assignment_vars[(person_id, slot['id'])])
                    j += 1
                if window_vars:
                    self.model.Add(sum(window_vars) <= 1)

    # ========================================================================
    # Holiday spread: no two FEESTDAG shifts too close together for one
    # person, within this period
    # ========================================================================

    def add_holiday_spread_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        holiday_spread_weeks: int,
        prior_assignments: Optional[list[dict]] = None
    ):
        """
        Constraint: at most one FEESTDAG assignment in any run of
        `holiday_spread_weeks` consecutive weeks, for the same person.

        A hard, FEESTDAG-only counterpart to add_window_constraints, and
        deliberately independent of it - window_weeks is allowed to be 0
        (no minimum gap at all, a valid planner choice), and this still
        holds even then. In practice a well-staffed pool basically never
        needs this - fair distribution already spreads the (usually
        handful of) FEESTDAG slots across different people - but nothing
        upstream actually guarantees it for an edge case (a small pool, or
        two FEESTDAG slots close together in the calendar), so this exists
        as that guarantee rather than an assumption.

        holidaySpreadWithinPeriod (RulesetConfig) has no accompanying
        penalty field, unlike the soft band settings - it mirrors
        window_weeks in being a hard rule, not a cost to weigh against
        others.

        prior_assignments carries a FEESTDAG shift from just before this
        period started (dienstrooster_prior_assignment, confirmed via the
        Prior Assignments screen) as a fixed fact, the same way
        add_prior_assignment_constraints does for window_weeks - without
        this, someone who worked a FEESTDAG shift right at the end of the
        previous period could be handed another one at the very start of
        this one, since this constraint only ever saw this period's own
        slots otherwise.
        """
        self.violations.setdefault('holiday_spread', 0)

        if holiday_spread_weeks <= 1:
            return  # No minimum spread required

        feestdag_slots = [s for s in slots if s.get('shift_type_name') == 'FEESTDAG']

        week_slots: dict[int, list[dict]] = {}
        for slot in feestdag_slots:
            week = _week_ordinal(slot['datum'])
            week_slots.setdefault(week, []).append(slot)

        for person_id in people:
            for week in sorted(week_slots.keys()):
                week_vars = [
                    assignment_vars.get((person_id, slot['id']))
                    for slot in week_slots[week]
                    if (person_id, slot['id']) in assignment_vars
                ]
                if not week_vars:
                    continue

                window_vars = []
                for check_week in range(week, week + holiday_spread_weeks):
                    if check_week in week_slots:
                        for slot in week_slots[check_week]:
                            if (person_id, slot['id']) in assignment_vars:
                                window_vars.append(assignment_vars[(person_id, slot['id'])])

                if window_vars:
                    self.model.Add(sum(window_vars) <= 1)

        for prior in (prior_assignments or []):
            if prior.get('teller') != 'FEESTDAG':
                continue
            person_id = prior['person_id']
            prior_week = _week_ordinal(prior['datum'])

            for slot in feestdag_slots:
                key = (person_id, slot['id'])
                if key not in assignment_vars:
                    continue
                if abs(_week_ordinal(slot['datum']) - prior_week) < holiday_spread_weeks:
                    self.model.Add(assignment_vars[key] == 0)

    # ========================================================================
    # Window Rule carry-over: respect shifts from just before this period
    # ========================================================================

    def add_prior_assignment_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        slots: list[dict],
        prior_assignments: list[dict],  # [{'person_id': str, 'datum': str, 'teller': str}, ...]
        window_weeks: int,
        counters: Optional[list[str]] = None
    ):
        """
        Extends the window rule across a period boundary.

        add_window_constraints only sees this period's own slots, so on its
        own it has no memory that a person worked the last few days of the
        *previous* period - the same person could then be assigned again
        within the window of a shift that already happened, right at the
        start of the new period. This was a confirmed bug: rosters the
        solver itself produced could show someone with two shifts a few
        days apart, straddling a period boundary.

        prior_assignments carries exactly the tail needed to close that gap
        - the last window_weeks weeks of the previous period, which
        the planner reviews and confirms via the Prior Assignments screen
        before generation is allowed to run (see
        dienstrooster_prior_assignment). Each entry is a shift that has
        already happened, so it isn't a variable to optimise around like
        this period's own slots - it's a fixed fact that rules out any of
        this period's slots landing too close to it, the same way
        add_window_constraints rules out two of the period's own slots
        landing too close to each other.

        counters: same meaning and same caller pattern as
        add_window_constraints' own (see its docstring for the full
        cross-type-floor-plus-per-group reasoning) - None pools everything
        (a prior fact of any teller blocks any nearby slot, the only
        behaviour periods frozen before per-teller windows existed have
        ever seen); given a list, only prior facts whose own teller is in
        it, and only slots whose shift_type_name is in it, participate in
        THIS call.
        """
        if window_weeks <= 0 or not prior_assignments:
            return

        relevant_slots = slots if counters is None else [s for s in slots if s.get('shift_type_name') in counters]

        for prior in prior_assignments:
            if counters is not None and prior.get('teller') not in counters:
                continue
            person_id = prior['person_id']
            prior_day = _day_ordinal(prior['datum'])

            for slot in relevant_slots:
                key = (person_id, slot['id'])
                if key not in assignment_vars:
                    continue
                # Fewer than 7 * window_weeks days from a shift already
                # worked, the same gap add_window_constraints keeps.
                if abs(_day_ordinal(slot['datum']) - prior_day) < 7 * window_weeks:
                    self.model.Add(assignment_vars[key] == 0)

    # ========================================================================
    # Blocking Absolute: Cannot assign to ABSOLUUT (blocked) slots
    # ========================================================================

    def add_blocking_absolute_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        blocked_slots: set[tuple[str, str]]  # (person_id, slot_id)
    ):
        """
        Constraint: If person has ABSOLUUT (blocked) preference for slot,
        cannot be assigned to that slot.
        """
        self.violations['blocking_absolute'] = 0

        for person_id, slot_id in blocked_slots:
            if (person_id, slot_id) in assignment_vars:
                self.model.Add(assignment_vars[(person_id, slot_id)] == 0)

    # ========================================================================
    # Capacity: Each slot must have required number of assignments
    # ========================================================================

    def add_capacity_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        slots: list[dict],
        people: list[str]
    ) -> dict[str, cp_model.IntVar]:
        """
        Constraint: Each slot needs benodigd_aantal_personen assignments.

        Soft via a per-slot shortfall variable rather than a hard equality:
        real staffing math doesn't always add up (too few active people for
        the window/band settings), and a planner would rather get a
        best-effort roster with a handful of gaps to fill in manually than
        no roster at all. The shortfall is penalized heavily in the
        objective (see objective.py) so the solver only leaves a slot open
        when there is genuinely no one left who could be assigned there
        without violating a hard rule (ABSOLUUT block, window rule).

        Returns: dict[slot_id, shortfall IntVar] - 0 when the slot ended up
        fully staffed, >0 for however many people short it is.
        """
        self.violations['capacity'] = 0
        shortfall_vars: dict[str, cp_model.IntVar] = {}

        for slot in slots:
            slot_id = slot['id']
            required = slot.get('benodigd_aantal_personen', 1)

            # Sum all people assigned to this slot
            slot_vars = [
                assignment_vars.get((person_id, slot_id))
                for person_id in people
                if (person_id, slot_id) in assignment_vars
            ]

            if slot_vars:
                shortfall = self.model.NewIntVar(0, required, f'shortfall_{slot_id}')
                self.model.Add(sum(slot_vars) + shortfall == required)
                shortfall_vars[slot_id] = shortfall

        return shortfall_vars

    # ========================================================================
    # Band Limits: Per-person assignment count in range
    # ========================================================================

    def add_band_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        band_ranges: dict[str, tuple[int, int]],  # counter -> [min, max]
        balances: dict[str, dict[str, int]],  # person -> { counter: delta }
        counters: list[str] = ['AVOND', 'WEEKEND', 'FEESTDAG'],
        distribution_mode: str = 'GELIJK',
        participation_factors: Optional[dict[str, float]] = None,
        coverage_factors: Optional[dict[str, float]] = None,
        already_assigned: Optional[dict[str, dict[str, int]]] = None,
        band_overrides: Optional[dict[str, dict[str, tuple[int, int]]]] = None
    ) -> dict[tuple[str, str], tuple[cp_model.IntVar, cp_model.IntVar]]:
        """
        Constraint: Each person must have assignments in band range per counter.

        Band is adjusted by ledger balance:
        actual_band = [base_min + delta, base_max + delta]

        already_assigned (person -> {counter: count}) further reduces both
        ends by however many of that counter the person already has within
        THIS period from a manual pre-fill before the solver ran (see
        main.py's manual_assignments) - those slots are never in `slots`
        here (the caller excludes them from the solve entirely), so without
        this the solver would independently chase the *full* band on top of
        a shift the person already has, blowing right past the target
        instead of completing it.

        With distribution_mode='NAAR_RATO', base_min/base_max are first
        scaled by the person's participation_factors entry (their
        pool_membership.deelnamefactor, e.g. 0.5 for a half-time
        participant) before the balance delta is applied - so a part-timer
        is held to a proportionally smaller target instead of the same
        band as everyone else. 'GELIJK' (the default) ignores the factor
        entirely, on purpose: everyone gets the same target regardless of
        participation.

        coverage_factors is unconditional and always applied first,
        regardless of distribution_mode: it's the fraction of *this
        period* actually covered by the person's pool membership window
        (geldig_vanaf/geldig_tot), for someone who joined or left
        mid-period. That's a structural fact, not a fairness policy choice
        like participation_factors/NAAR_RATO - a full-time GELIJK
        participant present the whole period is unaffected (factor 1.0),
        but a mid-period joiner gets a proportionally smaller target even
        under 'GELIJK'.

        `under` stays fully soft (unbounded slack, up to actual_min) for the
        same reason as ever - a hard minimum could make the whole model
        infeasible outright when demand and supply don't line up exactly,
        and falling short of a target is the lesser evil next to an empty
        shift.

        `over` is hard-capped at MAX_BAND_OVERSHOOT units past actual_max
        (currently 0 - nobody is ever pushed past their streefbereik, full
        stop): a planner-promised korting (a negative ledger delta
        lowering someone's target for taking on an extra shift earlier)
        is otherwise just another soft target like any other, and on a
        tight enough period the solver could still push that same person
        over their already-lowered band to cover a shift - exactly
        defeating the point of promising them fewer diensten. A shift
        that would require going over stays unfilled instead, for the
        planner to resolve by hand (or accept the overshoot themselves,
        deliberately, the way a manual reassign already allows) - see
        this function's own tests for the concrete unfilled-slots cost of
        a 0 vs. 1-unit headroom. Both directions are still weighed
        against each other in the objective (see
        objective.py's add_band_slack_objective) for 'weighted' mode; this
        cap applies unconditionally, in every objective_mode, since it's a
        hard rule now rather than a cost to trade off.

        band_overrides (person -> {counter: (min, max)}) replaces that
        person's band for that counter outright: no coverage or NAAR_RATO
        scaling and no ledger delta, only the already_assigned offset. Used
        for a fellow's weekend (lib/fellows.ts on the Next.js side): 0 up
        to the weekend days they left unblocked themselves.

        Returns: dict[(person_id, counter), (under IntVar, over IntVar)]
        """
        self.violations['band_limit'] = 0
        overrides = band_overrides or {}
        band_slack_vars: dict[tuple[str, str], tuple[cp_model.IntVar, cp_model.IntVar]] = {}
        factors = participation_factors or {}
        coverage = coverage_factors or {}

        for person_id in people:
            for counter in counters:
                base_min, base_max = band_ranges.get(counter, [7, 8])

                # Always applied, regardless of distribution_mode - see
                # coverage_factors in the docstring above. Same floor/ceil
                # min-width-1 protection as the NAAR_RATO scaling below.
                coverage_factor = coverage.get(person_id, 1.0)
                base_min = math.floor(base_min * coverage_factor)
                base_max = max(base_min, math.ceil(base_max * coverage_factor))

                if distribution_mode == 'NAAR_RATO':
                    # floor/ceil, not round for both: rounding both the
                    # same way can collapse the scaled band to width 0
                    # (e.g. factor=0.5 on [7,8] -> round(3.5)=4,
                    # round(4.0)=4 -> [4,4]) while a full-time person keeps
                    # width >=1 - a systematic, non-proportional penalty
                    # against part-timers, who'd then pay band-slack cost
                    # for the ordinary variation a full-timer gets for
                    # free. floor(min)/ceil(max) keeps width >=1 whenever
                    # the un-scaled band already had one.
                    factor = factors.get(person_id, 1.0)
                    base_min = math.floor(base_min * factor)
                    base_max = max(base_min, math.ceil(base_max * factor))

                # Get person's balance for this counter
                delta = balances.get(person_id, {}).get(counter, 0)
                already = already_assigned.get(person_id, {}).get(counter, 0) if already_assigned else 0
                actual_min = base_min + delta - already
                actual_max = base_max + delta - already
                override = overrides.get(person_id, {}).get(counter)
                if override is not None:
                    actual_min = override[0] - already
                    actual_max = override[1] - already

                # Slots matching this counter
                counter_vars = [
                    assignment_vars.get((person_id, slot['id']))
                    for slot in slots
                    if slot.get('shift_type_name') == counter
                    and (person_id, slot['id']) in assignment_vars
                ]

                if counter_vars:
                    assignment_count = sum(counter_vars)

                    under = self.model.NewIntVar(
                        0, max(0, actual_min), f'band_under_{person_id}_{counter}'
                    )
                    # Capped at MAX_BAND_OVERSHOOT past actual_max, not left
                    # unbounded - see this function's docstring. When
                    # actual_max is itself pulled negative by a large enough
                    # ledger delta, max(0, -actual_max) adds back exactly
                    # the headroom needed to keep assignment_count=0
                    # satisfiable, so the model never goes infeasible over a
                    # correction this large - the effective ceiling in that
                    # case is just 0 + MAX_BAND_OVERSHOOT, not the
                    # unbounded gap the old formula allowed.
                    over = self.model.NewIntVar(
                        0,
                        MAX_BAND_OVERSHOOT + max(0, -actual_max),
                        f'band_over_{person_id}_{counter}',
                    )

                    self.model.Add(assignment_count + under >= actual_min)
                    self.model.Add(assignment_count - over <= actual_max)

                    band_slack_vars[(person_id, counter)] = (under, over)

        return band_slack_vars

    # ========================================================================
    # Part-time patterns: enforced upstream, not here
    # ========================================================================
    #
    # There is deliberately no part-time constraint in this model. Patterns
    # are expanded into concrete ABSOLUUT availability rows by
    # lib/parttimeSync.ts when a pattern is saved or a period is opened, and
    # those arrive here as `blocked_slots` - so the rule is already enforced
    # by add_blocking_absolute_constraints above.
    #
    # An add_parttime_constraints() stub used to live here that re-derived
    # weekday/even-odd-week matching in Python. It was never called by
    # solver.py, its body trailed off in a comment before adding any
    # constraint, and its week-parity maths duplicated logic that
    # parttimeSync.ts already does against the persisted iso_week column.

    # ========================================================================
    # Reporting
    # ========================================================================

    def get_violations_summary(self) -> dict:
        """Return current violation counts"""
        return self.violations.copy()

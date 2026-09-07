"""
CP-SAT Constraint Definitions

Implements hard constraints for roster generation:
1. Window rule (no consecutive shifts within window_weeks)
2. Blocking absolute (ABSOLUUT preferences)
3. Part-time pattern (forced assignments)
4. Capacity (slots need required number of people)
5. Band limits (balance ranges per person per counter)
6. Holiday rotation (fair distribution across group)
"""

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


class ConstraintBuilder:
    """Builds and manages CP-SAT constraints"""

    def __init__(self, model: cp_model.CpModel):
        self.model = model
        self.violations = {}

    # ========================================================================
    # Window Rule: No consecutive assignments within window_weeks
    # ========================================================================

    def add_window_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        window_weeks: int
    ):
        """
        Constraint: at most one assignment in any run of `window_weeks`
        consecutive weeks, which is exactly "windowWeeks = number of weeks
        between shifts" as CLAUDE.md defines the setting.

        That makes the documented example hold literally: with
        window_weeks=2, a shift in week 12 rules out weeks 11 and 13 - and
        nothing further out.

        Deliberately a forward-only window [w, w + window_weeks - 1]
        applied at every start week, rather than a symmetric window around
        each week. A symmetric [w-k, w+k] spans 2k+1 weeks, so it enforces
        a gap of 2k+1 rather than window_weeks - far stricter than
        configured, and stricter than lib/capacity.ts promises the planner
        (it advertises floor(weeks / windowWeeks) shifts per person). That
        mismatch made rosters look staffable that the solver then could not
        actually fill.

        NOTE: this still permits at most one slot per person per week, so a
        Saturday+Sunday weekend pair is split across two people. The
        previous docstring claimed same-week pairs were allowed, but the
        code never implemented that (every slot in week w sits inside w's
        own window). Behaviour is left as-is here: allowing pairs changes
        how weekends are staffed and is a scheduling-policy decision, not
        part of fixing the gap arithmetic.

        Grouped by _week_ordinal(datum) rather than the raw iso_week field:
        a period that spans a year boundary would otherwise let week 52 (or
        53) of one year and week 1 of the next - one calendar week apart -
        sail through unchecked, since neither `range(52, 52+window_weeks)`
        nor `range(1, 1+window_weeks)` sees the other side of the boundary.
        """
        self.violations['window_rule'] = 0

        if window_weeks <= 1:
            return  # No window constraint for 1-week

        # Build map: week -> list of slots
        week_slots = {}
        for slot in slots:
            week = _week_ordinal(slot['datum'])
            if week not in week_slots:
                week_slots[week] = []
            week_slots[week].append(slot)

        # For each person
        for person_id in people:
            # For each week
            for week in sorted(week_slots.keys()):
                # Slots in this week
                week_vars = [
                    assignment_vars.get((person_id, slot['id']))
                    for slot in week_slots[week]
                    if (person_id, slot['id']) in assignment_vars
                ]

                if not week_vars:
                    continue

                # Sum assignments in window [week, week + window_weeks - 1]
                window_vars = []

                for check_week in range(week, week + window_weeks):
                    if check_week in week_slots:
                        for slot in week_slots[check_week]:
                            if (person_id, slot['id']) in assignment_vars:
                                window_vars.append(
                                    assignment_vars[(person_id, slot['id'])]
                                )

                # At most 1 assignment in window
                if window_vars:
                    self.model.Add(sum(window_vars) <= 1)

    # ========================================================================
    # Window Rule carry-over: respect shifts from just before this period
    # ========================================================================

    def add_prior_assignment_constraints(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        slots: list[dict],
        prior_assignments: list[dict],  # [{'person_id': str, 'datum': str}, ...]
        window_weeks: int
    ):
        """
        Extends the window rule across a period boundary.

        add_window_constraints only sees this period's own slots, so on its
        own it has no memory that a person worked the last few days of the
        *previous* period - the same person could then be assigned again
        within window_weeks of a shift that already happened, right at the
        start of the new period. This was a confirmed bug: rosters the
        solver itself produced could show someone with two shifts a few
        days apart, straddling a period boundary.

        prior_assignments carries exactly the tail needed to close that gap
        - the last (window_weeks - 1) weeks of the previous period, which
        the planner reviews and confirms via the Prior Assignments screen
        before generation is allowed to run (see
        dienstrooster_prior_assignment). Each entry is a shift that has
        already happened, so it isn't a variable to optimise around like
        this period's own slots - it's a fixed fact that rules out any of
        this period's slots landing too close to it, the same way
        add_window_constraints rules out two of the period's own slots
        landing too close to each other.
        """
        if window_weeks <= 1 or not prior_assignments:
            return

        for prior in prior_assignments:
            person_id = prior['person_id']
            prior_week = _week_ordinal(prior['datum'])

            for slot in slots:
                key = (person_id, slot['id'])
                if key not in assignment_vars:
                    continue
                if abs(_week_ordinal(slot['datum']) - prior_week) < window_weeks:
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
        band_ranges: dict[str, list[int]],  # counter -> [min, max]
        balances: dict[str, dict[str, int]],  # person -> { counter: delta }
        counters: list[str] = ['AVOND', 'WEEKEND', 'FEESTDAG'],
        distribution_mode: str = 'GELIJK',
        participation_factors: Optional[dict[str, float]] = None
    ) -> dict[tuple[str, str], tuple[cp_model.IntVar, cp_model.IntVar]]:
        """
        Constraint: Each person must have assignments in band range per counter.

        Band is adjusted by ledger balance:
        actual_band = [base_min + delta, base_max + delta]

        With distribution_mode='NAAR_RATO', base_min/base_max are first
        scaled by the person's participation_factors entry (their
        pool_membership.deelnamefactor, e.g. 0.5 for a half-time
        participant) before the balance delta is applied - so a part-timer
        is held to a proportionally smaller target instead of the same
        band as everyone else. 'GELIJK' (the default) ignores the factor
        entirely, on purpose: everyone gets the same target regardless of
        participation.

        Soft via under/over slack rather than a hard range: when there
        genuinely aren't enough people to cover every slot within
        everyone's target band, the solver should prefer stretching
        someone slightly beyond their band over leaving a shift
        completely uncovered - that mirrors how a planner would actually
        resolve this by hand. Slack is penalized in the objective (see
        objective.py), moderately - more than ordinary preference costs,
        but far less than leaving a slot unfilled.

        Returns: dict[(person_id, counter), (under IntVar, over IntVar)]
        """
        self.violations['band_limit'] = 0
        band_slack_vars: dict[tuple[str, str], tuple[cp_model.IntVar, cp_model.IntVar]] = {}
        factors = participation_factors or {}

        for person_id in people:
            for counter in counters:
                base_min, base_max = band_ranges.get(counter, [7, 8])

                if distribution_mode == 'NAAR_RATO':
                    factor = factors.get(person_id, 1.0)
                    base_min = round(base_min * factor)
                    base_max = max(base_min, round(base_max * factor))

                # Get person's balance for this counter
                delta = balances.get(person_id, {}).get(counter, 0)
                actual_min = base_min + delta
                actual_max = base_max + delta

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
                    over = self.model.NewIntVar(
                        0, len(counter_vars), f'band_over_{person_id}_{counter}'
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

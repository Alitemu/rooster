"""
CP-SAT Objective Function

Minimizes:
1. LIEVER_NIET (soft blocking) violations
2. Band imbalance (assignment count vs target)
3. Holiday rotation inequality
"""

from ortools.sat.python import cp_model


class ObjectiveBuilder:
    """Builds and manages the solver objective function"""

    def __init__(self, model: cp_model.CpModel):
        self.model = model
        self.objective_terms = {}

    # ========================================================================
    # Term 1: LIEVER_NIET Soft Blocking Penalties
    # ========================================================================

    def add_soft_preference_objective(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        soft_slots: dict[tuple[str, str], float],  # (person, slot) -> penalty
        weight: float = 1.0
    ):
        """
        Objective: Minimize assignments to LIEVER_NIET (prefer not) slots.
        Each violation costs weight * penalty.
        """
        soft_cost = 0

        for (person_id, slot_id), penalty in soft_slots.items():
            if (person_id, slot_id) in assignment_vars:
                var = assignment_vars[(person_id, slot_id)]
                # Cost = 1 when assigned, 0 when not
                soft_cost += weight * penalty * var

        self.objective_terms['soft_blocking'] = soft_cost
        return soft_cost

    # ========================================================================
    # Term 2: Band Imbalance
    # ========================================================================

    def add_band_imbalance_objective(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        band_ranges: dict[str, list[int]],
        balances: dict[str, dict[str, int]],
        weight: float = 0.5,
        counters: list[str] = ['AVOND', 'WEEKEND', 'FEESTDAG']
    ):
        """
        Objective: Prefer assignments toward middle of band range.

        If band is [7,8] and actual_band is [6,7]:
        target = (6+7)//2 = 6
        cost = abs(actual_count - 6)

        The deviation is tied to the real assignment count with
        AddAbsEquality. That coupling is the whole point: an earlier
        version created the deviation variable and added it to the cost but
        never constrained it, so - because the objective minimises - the
        solver simply set every deviation to 0 and this entire term did
        nothing. Workload came out visibly lopsided (1/2/3 shifts across
        three interchangeable people) while the code claimed to balance it.
        """
        imbalance_cost = 0

        for person_id in people:
            for counter in counters:
                base_min, base_max = band_ranges.get(counter, [7, 8])
                delta = balances.get(person_id, {}).get(counter, 0)

                actual_min = base_min + delta
                actual_max = base_max + delta
                # Integer target - CP-SAT variable bounds must be integers
                target = (actual_min + actual_max) // 2

                # Count assignments for this person-counter
                counter_vars = [
                    assignment_vars.get((person_id, slot['id']))
                    for slot in slots
                    if slot.get('shift_type_name') == counter
                    and (person_id, slot['id']) in assignment_vars
                ]

                if counter_vars:
                    assignment_count = sum(counter_vars)

                    # Bound generously: the count can range over every slot
                    # of this counter, and target may sit outside that range
                    # once a ledger delta is applied.
                    bound = max(len(counter_vars), abs(target))

                    diff = self.model.NewIntVar(
                        -bound, bound, f'diff_{person_id}_{counter}'
                    )
                    self.model.Add(diff == assignment_count - target)

                    deviation = self.model.NewIntVar(
                        0, bound, f'dev_{person_id}_{counter}'
                    )
                    self.model.AddAbsEquality(deviation, diff)

                    imbalance_cost += weight * deviation

        self.objective_terms['band_imbalance'] = imbalance_cost
        return imbalance_cost

    # ========================================================================
    # Term 3: Slot Shortfall (unfilled capacity)
    # ========================================================================

    def add_shortfall_objective(
        self,
        shortfall_vars: dict[str, cp_model.IntVar],
        weight: float = 1000.0
    ):
        """
        Objective: Minimize unfilled slot capacity.

        Weighted far above every other term so the solver only leaves a
        slot short when no assignment exists that wouldn't break a hard
        rule (ABSOLUUT block, window rule) - preference/balance costs
        never win out over actually covering a shift.
        """
        shortfall_cost = weight * sum(shortfall_vars.values()) if shortfall_vars else 0

        self.objective_terms['shortfall'] = shortfall_cost
        return shortfall_cost

    # ========================================================================
    # Term 4: Band Slack (assignments outside a person's target range)
    # ========================================================================

    def add_band_slack_objective(
        self,
        band_slack_vars: dict[tuple[str, str], tuple[cp_model.IntVar, cp_model.IntVar]],
        weight: float = 5.0
    ):
        """
        Objective: Minimize how far anyone's assignment count strays
        outside their target band.

        Weighted above ordinary preference/imbalance costs (so the solver
        prefers a clean roster when one exists) but far below shortfall
        (so stretching someone's band is always preferred over leaving a
        shift uncovered).
        """
        slack_cost = (
            weight * sum(u + o for u, o in band_slack_vars.values())
            if band_slack_vars else 0
        )

        self.objective_terms['band_slack'] = slack_cost
        return slack_cost
    # ========================================================================
    # Holiday rotation equity: not modelled
    # ========================================================================
    #
    # An add_holiday_equity_objective() stub used to sit here. It was never
    # called by solver.py, and its inner loop ended in `pass` before adding
    # any cost - so it always returned 0 and contributed nothing.
    #
    # Fair holiday rotation is currently tracked outside the solver, in the
    # holiday_history table (see lib/holidays.ts and the import-holidays
    # route). Folding it into the objective is a real piece of work, not a
    # gap to paper over with an empty function.

    # ========================================================================
    # Combined Objective
    # ========================================================================

    def build_objective(
        self,
        shortfall_cost: float = 0,
        band_slack_cost: float = 0,
        soft_cost: float = 0,
        imbalance_cost: float = 0,
        holiday_cost: float = 0
    ) -> float:
        """
        Combine all objective terms and set on model.

        Each term's own weight (passed in when it was built - see
        add_shortfall_objective, add_band_slack_objective, etc.) already
        encodes its relative importance, from most to least critical:
        actually covering every shift, then staying within everyone's
        target band, then honoring soft (LIEVER_NIET) preferences and
        balance smoothing.
        """
        total = shortfall_cost + band_slack_cost + soft_cost + imbalance_cost + holiday_cost

        self.model.Minimize(total)
        self.objective_terms['total'] = total

        return total

    # ========================================================================
    # Reporting
    # ========================================================================

    def get_objective_summary(self) -> dict:
        """Return objective term breakdown"""
        return self.objective_terms.copy()

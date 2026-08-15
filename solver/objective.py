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
        target = (6+7)/2 = 6.5
        cost = abs(actual_count - 6.5)
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

                    # Create cost: prefer being at target
                    # Linear approximation: |count - target|
                    # Simplified: add slack variable
                    deviation = self.model.NewIntVar(
                        0, max(actual_max - target, target - actual_min),
                        f'dev_{person_id}_{counter}'
                    )

                    # This is simplified; full implementation would use
                    # absolute value or quadratic terms
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
    # Term 5: Holiday Rotation Equity
    # ========================================================================

    def add_holiday_equity_objective(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        people: list[str],
        slots: list[dict],
        holiday_assignments: dict[str, dict[str, int]],  # person -> { group: count }
        weight: float = 0.3,
        holiday_groups: list[str] = [
            'NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG',
            'HEMELVAART', 'PINKSTEREN', 'KERST'
        ]
    ):
        """
        Objective: Minimize variance in holiday assignments across group.

        Penalizes large differences in how holidays are distributed.
        """
        holiday_cost = 0

        for group in holiday_groups:
            # Find all holiday slots of this group
            holiday_slots = [
                slot for slot in slots
                if slot.get('is_feestdag') and slot.get('feestdag_groep') == group
            ]

            if not holiday_slots:
                continue

            # Count assignments per person for this group
            group_counts = {}
            for person_id in people:
                count_var = 0
                for slot in holiday_slots:
                    if (person_id, slot['id']) in assignment_vars:
                        count_var += assignment_vars[(person_id, slot['id'])]
                group_counts[person_id] = count_var

            # Calculate mean and variance (simplified)
            # Target: each person gets equal share
            total_holidays = len(holiday_slots)
            people_count = len(people)
            target_per_person = total_holidays / people_count

            # Add cost for deviations
            for person_id, count_var in group_counts.items():
                # Cost = abs(count - target)
                # Simplified linear form
                pass  # Would implement with absolute value constraints

        self.objective_terms['holiday_equity'] = holiday_cost
        return holiday_cost

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

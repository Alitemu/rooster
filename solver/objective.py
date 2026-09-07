"""
CP-SAT Objective Function

Minimizes:
1. LIEVER_NIET (soft blocking) violations
2. Band imbalance (assignment count vs target)
3. Holiday rotation inequality

Rewards (subtracts from the total):
4. VOORKEUR (preferred) assignments
"""

from typing import Optional

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
    # Term 1b: VOORKEUR Preference Reward
    # ========================================================================

    def add_preference_reward_objective(
        self,
        assignment_vars: dict[tuple[str, str], cp_model.IntVar],
        preferred_slots: dict[tuple[str, str], float],  # (person, slot) -> reward
        weight: float = 0.3
    ):
        """
        Objective: Reward assignments to VOORKEUR (preferred) slots.

        Mirror image of add_soft_preference_objective: instead of adding a
        cost when assigned, it subtracts one - the more a person's stated
        preferences are honoured, the lower the total objective.

        Weighted below band_imbalance (0.5) on purpose: when two people
        want the same day, fairness and coverage still decide first, and a
        preference only tips the balance between choices that were already
        equally good on every other term.
        """
        reward = 0

        for (person_id, slot_id), value in preferred_slots.items():
            if (person_id, slot_id) in assignment_vars:
                var = assignment_vars[(person_id, slot_id)]
                reward += weight * value * var

        preference_reward_cost = -reward
        self.objective_terms['preference_reward'] = preference_reward_cost
        return preference_reward_cost

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
        counters: list[str] = ['AVOND', 'WEEKEND', 'FEESTDAG'],
        distribution_mode: str = 'GELIJK',
        participation_factors: Optional[dict[str, float]] = None
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

        distribution_mode/participation_factors mirror
        constraints.add_band_constraints exactly - this term has to pull
        toward the *same* scaled middle that term constrains against, or a
        part-timer's target here would silently disagree with their actual
        band there, and this (much smaller) weight would just get
        overruled by the band-slack term picking whichever allocation this
        one didn't prefer.
        """
        imbalance_cost = 0
        factors = participation_factors or {}

        for person_id in people:
            for counter in counters:
                base_min, base_max = band_ranges.get(counter, [7, 8])

                if distribution_mode == 'NAAR_RATO':
                    factor = factors.get(person_id, 1.0)
                    base_min = round(base_min * factor)
                    base_max = max(base_min, round(base_max * factor))

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
        penalty_tiers: Optional[list[float]] = None,
        multiplier: float = 1.0,
        max_tiers: int = 8
    ):
        """
        Objective: Minimize how far anyone's assignment count strays
        outside their target band - at an escalating, cumulative price per
        extra unit of deviation (bandDeviationPenalty/bandDeviationMultiplier
        in RulesetConfig), so the solver spreads a shortage across several
        people (1 over each) rather than concentrating it on one (3+ over).

        The Nth unit of deviation (1-indexed) costs penalty_tiers[N-1] once
        N is within the configured tiers; beyond that it costs
        penalty_tiers[-1] * multiplier**(N - len(penalty_tiers)). Cost is
        cumulative - 3 units of deviation with tiers [10, 40, 160] costs
        10 + 40 + 160 = 210, not just 160 - so the first unit stays cheap
        and each further one gets markedly more expensive. The default
        (a flat [5.0] tier with multiplier 1.0) reproduces the old fixed
        weight=5.0-per-unit behaviour exactly, so a period whose ruleset
        never set bandDeviationPenalty behaves exactly as before this
        existed.

        CP-SAT's objective has to stay linear, so "cost grows with each
        unit" can't be a single multiply the way a flat weight can. Instead
        this reifies max_tiers boolean "deviation has reached at least N"
        indicators per person/counter (deviation being under+over from
        add_band_constraints) and prices each one at its own tier - capped
        at max_tiers deep, since a tier that far out (each 4x the last) is
        already so expensive it can never be the cheaper option; not
        instantiating it just keeps the model smaller.
        """
        if not band_slack_vars:
            self.objective_terms['band_slack'] = 0
            return 0

        penalty_tiers = penalty_tiers or [5.0]

        def tier_cost(level: int) -> float:
            if level <= len(penalty_tiers):
                return penalty_tiers[level - 1]
            return penalty_tiers[-1] * (multiplier ** (level - len(penalty_tiers)))

        slack_cost = 0
        for (person_id, counter), (under, over) in band_slack_vars.items():
            deviation = under + over
            for level in range(1, max_tiers + 1):
                at_least = self.model.NewBoolVar(f'band_dev_{person_id}_{counter}_ge_{level}')
                self.model.Add(deviation >= level).OnlyEnforceIf(at_least)
                self.model.Add(deviation < level).OnlyEnforceIf(at_least.Not())
                slack_cost += tier_cost(level) * at_least

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
        holiday_cost: float = 0,
        preference_reward_cost: float = 0
    ) -> float:
        """
        Combine all objective terms and set on model.

        Each term's own weight (passed in when it was built - see
        add_shortfall_objective, add_band_slack_objective, etc.) already
        encodes its relative importance, from most to least critical:
        actually covering every shift, then staying within everyone's
        target band, then honoring soft (LIEVER_NIET) preferences and
        balance smoothing, then rewarding VOORKEUR preferences.
        preference_reward_cost is already negative (see
        add_preference_reward_objective), so adding it here lowers the
        total when a preference is honoured.
        """
        total = (
            shortfall_cost + band_slack_cost + soft_cost + imbalance_cost
            + holiday_cost + preference_reward_cost
        )

        self.model.Minimize(total)
        self.objective_terms['total'] = total

        return total

    # ========================================================================
    # Reporting
    # ========================================================================

    def get_objective_summary(self) -> dict:
        """Return objective term breakdown"""
        return self.objective_terms.copy()

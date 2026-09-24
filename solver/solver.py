"""
CP-SAT Solver Execution

Orchestrates model building, constraint application, and solution extraction.

Two objective modes, selectable per period (RuleSet.objective_mode):

- 'weighted' ("Puntenplanner"): one combined weighted sum of every cost/
  reward term, minimized in a single solve - see objective.py. Simple and
  fast, but a weighted sum is structurally blind to *how* a total is
  reached: add_band_imbalance_objective sums each person's deviation from
  their target, so one person 4 shifts off costs exactly the same as four
  people 1 shift off each - the model has no preference between
  "concentrated on one person" and "spread across several" as long as the
  sum matches. That is precisely the failure mode that motivated
  'lexicographic' below: a planner-visible, reproducible case of one
  person absorbing far more than their share while others stayed
  comfortably inside their own band, because the *sum* looked no worse
  than spreading it would have.

- 'lexicographic' ("Prioriteitenplanner"): see _solve_lexicographic below.
  Solves several times in strict priority order, each phase locking its
  own optimum in as a hard constraint before the next phase's objective
  is even considered - so a lower-priority phase can never trade away a
  higher-priority one's optimum, the way one big weight can silently be
  outweighed by the sum of several smaller ones in the weighted model
  once enough of them stack up (band_deviation_penalty's tiers, soft_
  block_penalty, band_imbalance_weight and preference_reward_weight can
  all combine on one side of a decision - nothing structurally prevents
  their sum from approaching shortfall_weight/the over-band floor once a
  period has enough people and slots).
"""

import logging
import threading
import time
from ortools.sat.python import cp_model
from typing import Optional
from constraints import ConstraintBuilder
from objective import ObjectiveBuilder

logger = logging.getLogger(__name__)


class RosterSolver:
    """Main solver orchestrator"""

    # Matches SolverInput.time_limit_seconds' own default in main.py - the
    # only two real callers (main.py, test_solver.py) always pass this
    # explicitly, so this default is purely documentation for anyone
    # instantiating RosterSolver() bare, but it's worth keeping it truthful.
    def __init__(self, time_limit_seconds: int = 120):
        self.time_limit_seconds = time_limit_seconds
        self.model = None
        self.solver = None
        self.status = None
        # Set per generate_roster() call, applied to every CpSolver() this
        # instance creates (solve() and each _solve_lexicographic phase).
        # None (default) leaves OR-Tools' own default search in place -
        # only the "Herhaalplanner" multi-start loop (Next.js side, see
        # lib/rosterGenerationJobs.ts) sets this, to a different value per
        # attempt, so repeated solves of the same input can actually land
        # on different (equally or less optimal) solutions instead of
        # deterministically reproducing the same one every time.
        self.random_seed: Optional[int] = None
        # Set from another thread (main.py, when the caller hangs up) - see
        # request_stop().
        self._stop_event = threading.Event()

    def request_stop(self) -> None:
        """
        Ask a running solve to stop as soon as possible. Safe to call from
        another thread, and repeatedly: CpSolver.StopSearch() is itself
        thread-safe, and the flag makes any phase that has not started its
        own Solve() yet run with no time budget at all. main.py calls this
        in a loop for as long as the solve is still running after the
        client disconnected, which also covers the instant between a new
        phase creating its CpSolver and actually entering Solve(), where
        StopSearch() alone would be a no-op.
        """
        self._stop_event.set()
        current = self.solver
        if current is not None:
            current.StopSearch()

    def _apply_stop_request(self) -> None:
        if self._stop_event.is_set():
            self.solver.parameters.max_time_in_seconds = 0.0

    # ========================================================================
    # Model Building
    # ========================================================================

    def build_model(
        self,
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
        soft_block_penalty: float = 1.0,
        distribution_mode: str = 'GELIJK',
        participation_factors: Optional[dict[str, float]] = None,
        coverage_factors: Optional[dict[str, float]] = None,
        band_deviation_penalty: Optional[list[float]] = None,
        band_deviation_multiplier: float = 1.0,
        holiday_spread_weeks: int = 0,
        shortfall_weight: float = 1000.0,
        band_imbalance_weight: float = 0.5,
        preference_reward_weight: float = 0.3,
        objective_mode: str = 'weighted',
        window_weeks_avond: Optional[int] = None,
        window_weeks_weekend_feestdag: Optional[int] = None,
        band_overrides: Optional[dict[str, dict[str, tuple[int, int]]]] = None
    ) -> dict:
        """
        Build the CP-SAT model: every constraint always, the combined
        weighted objective only when objective_mode == 'weighted' -
        'lexicographic' builds and solves its own objectives phase by
        phase afterward (see _solve_lexicographic), directly on the
        constraints/variables this returns.

        Returns:
        {
            'model': cp_model.CpModel,
            'assignment_vars': dict[(person, slot) -> IntVar],
            'shortfall_vars': dict[slot_id -> IntVar],
            'band_slack_vars': dict[(person, counter) -> (under, over)],
            'constraints_builder': ConstraintBuilder,
            'objective_builder': ObjectiveBuilder | None
        }
        """
        logger.info("Building CP-SAT model")
        start = time.time()

        self.model = cp_model.CpModel()
        assignment_vars = {}

        # Create variables: x[person][slot] = 1 if assigned, 0 otherwise
        logger.info(f"Creating {len(people)} × {len(slots)} assignment variables")

        for person_id in people:
            for slot in slots:
                slot_id = slot['id']
                var_name = f"assign_{person_id}_{slot_id}"
                assignment_vars[(person_id, slot_id)] = self.model.NewBoolVar(var_name)

        logger.info(f"Created {len(assignment_vars)} variables in {time.time()-start:.2f}s")

        # Add constraints
        constraint_builder = ConstraintBuilder(self.model)

        # prior_assignments (before this period) and manual_assignments
        # (already fixed within this period, before this solve - see
        # main.py's SolverInput) are both "immovable facts the window rule
        # must respect", just with different sources - concatenating them
        # here has the same effect as calling either constraint function
        # once per list, since each fact is applied independently.
        fixed_assignments = (prior_assignments or []) + (manual_assignments or [])

        # Per-teller windows: None for both (the only state a period frozen
        # before this existed can ever be in) keeps the single pooled
        # window_weeks exactly as it always worked - one shared window
        # across every teller, a shift of any type blocking a nearby shift
        # of any type.
        #
        # Either one set instead applies THREE constraints together, per
        # the planner's own explicit rule: "een weekenddienst kan wel een
        # avonddienst blokkeren en andersom... het minimum geldt dan voor
        # alle diensten" - i.e. AVOND and WEEKEND+FEESTDAG each keep their
        # own (typically larger) same-type cap, but the *smaller* of the
        # two windows still applies as a floor between every pair of shifts
        # regardless of type:
        #   1. A pooled call at min(window_weeks_avond, window_weeks_weekend_feestdag)
        #      over ALL slots - the cross-type floor.
        #   2. An AVOND-only call at window_weeks_avond - only binding when
        #      that's larger than the floor above (otherwise redundant with
        #      it, which is harmless).
        #   3. A WEEKEND+FEESTDAG-only call at window_weeks_weekend_feestdag,
        #      same reasoning.
        # holiday_spread_weeks (below) is untouched by any of this - a
        # separate, already-existing, FEESTDAG-only extra rule layered on
        # top either way.
        per_teller_windows = window_weeks_avond is not None or window_weeks_weekend_feestdag is not None

        logger.info(f"Adding window constraints (per_teller_windows={per_teller_windows})")
        if per_teller_windows:
            avond_weeks = window_weeks_avond or 0
            weekend_feestdag_weeks = window_weeks_weekend_feestdag or 0
            cross_type_floor = min(avond_weeks, weekend_feestdag_weeks)

            constraint_builder.add_window_constraints(
                assignment_vars, people, slots, cross_type_floor
            )
            constraint_builder.add_window_constraints(
                assignment_vars, people, slots, avond_weeks, counters=['AVOND']
            )
            constraint_builder.add_window_constraints(
                assignment_vars, people, slots, weekend_feestdag_weeks,
                counters=['WEEKEND', 'FEESTDAG']
            )
            logger.info("Adding prior-period window carry-over constraints")
            constraint_builder.add_prior_assignment_constraints(
                assignment_vars, slots, fixed_assignments, cross_type_floor
            )
            constraint_builder.add_prior_assignment_constraints(
                assignment_vars, slots, fixed_assignments, avond_weeks, counters=['AVOND']
            )
            constraint_builder.add_prior_assignment_constraints(
                assignment_vars, slots, fixed_assignments, weekend_feestdag_weeks,
                counters=['WEEKEND', 'FEESTDAG']
            )
        else:
            constraint_builder.add_window_constraints(
                assignment_vars, people, slots, window_weeks
            )
            logger.info("Adding prior-period window carry-over constraints")
            constraint_builder.add_prior_assignment_constraints(
                assignment_vars, slots, fixed_assignments, window_weeks
            )

        logger.info("Adding holiday spread constraints")
        constraint_builder.add_holiday_spread_constraints(
            assignment_vars, people, slots, holiday_spread_weeks, fixed_assignments
        )

        # Per-person/counter counts of manual_assignments only (not
        # prior_assignments, which are from a previous period and don't
        # count toward *this* period's band target) - passed to the band
        # constraint/objective below so they target the remaining shots
        # only, not the full band on top of what's already assigned.
        already_assigned: dict[str, dict[str, int]] = {}
        for fact in (manual_assignments or []):
            person_counts = already_assigned.setdefault(fact['person_id'], {})
            person_counts[fact['teller']] = person_counts.get(fact['teller'], 0) + 1

        logger.info("Adding blocking absolute constraints")
        constraint_builder.add_blocking_absolute_constraints(
            assignment_vars, blocked_slots
        )

        logger.info("Adding capacity constraints")
        shortfall_vars = constraint_builder.add_capacity_constraints(
            assignment_vars, slots, people
        )

        logger.info("Adding band limit constraints")
        band_slack_vars = constraint_builder.add_band_constraints(
            assignment_vars, people, slots, band_ranges, balances,
            distribution_mode=distribution_mode, participation_factors=participation_factors,
            coverage_factors=coverage_factors, already_assigned=already_assigned,
            band_overrides=band_overrides
        )

        objective_builder = None
        if objective_mode == 'weighted':
            objective_builder = ObjectiveBuilder(self.model)

            # shortfall_weight is shared between these two calls on purpose:
            # add_band_slack_objective's `over` term prices every unit at
            # shortfall_weight + its own tier, specifically so exceeding
            # anyone's streefwaarde can never be cheaper than leaving a slot
            # unfilled instead - see that function's docstring. Whatever
            # value a planner configures, the same value must go to both
            # calls.
            logger.info("Adding shortfall objective")
            shortfall_cost = objective_builder.add_shortfall_objective(
                shortfall_vars, weight=shortfall_weight
            )

            logger.info("Adding band slack objective")
            band_slack_cost = objective_builder.add_band_slack_objective(
                band_slack_vars, penalty_tiers=band_deviation_penalty, multiplier=band_deviation_multiplier,
                shortfall_weight=shortfall_weight
            )

            logger.info("Adding soft preference objective")
            soft_cost = objective_builder.add_soft_preference_objective(
                assignment_vars, soft_slots, weight=soft_block_penalty
            )

            logger.info("Adding band imbalance objective")
            imbalance_cost = objective_builder.add_band_imbalance_objective(
                assignment_vars, people, slots, band_ranges, balances, weight=band_imbalance_weight,
                distribution_mode=distribution_mode, participation_factors=participation_factors,
                coverage_factors=coverage_factors, already_assigned=already_assigned,
                band_overrides=band_overrides
            )

            logger.info("Adding preference reward objective")
            preference_reward_cost = objective_builder.add_preference_reward_objective(
                assignment_vars, preferred_slots or {}, weight=preference_reward_weight
            )

            logger.info("Building combined objective")
            objective_builder.build_objective(
                shortfall_cost=shortfall_cost,
                band_slack_cost=band_slack_cost,
                soft_cost=soft_cost,
                imbalance_cost=imbalance_cost,
                preference_reward_cost=preference_reward_cost
            )
        else:
            logger.info(
                "objective_mode=lexicographic - skipping the combined weighted objective, "
                "phases are built and solved individually by _solve_lexicographic"
            )

        elapsed = time.time() - start
        logger.info(f"Model built in {elapsed:.2f}s")

        return {
            'model': self.model,
            'assignment_vars': assignment_vars,
            'shortfall_vars': shortfall_vars,
            'band_slack_vars': band_slack_vars,
            'constraints_builder': constraint_builder,
            'objective_builder': objective_builder
        }

    # ========================================================================
    # Solving - weighted (single solve)
    # ========================================================================

    def solve(
        self,
        model_data: dict
    ) -> dict:
        """
        Run the CP-SAT solver once against the combined weighted objective
        already attached to the model by build_model.

        Returns:
        {
            'success': bool,
            'status': str (OPTIMAL, FEASIBLE, INFEASIBLE),
            'assignments': list[{ person_id, slot_id }],
            'objective_value': float,
            'time_seconds': float,
            'violations': dict
        }
        """
        logger.info(f"Starting solver (time limit: {self.time_limit_seconds}s)")
        start = time.time()

        self.solver = cp_model.CpSolver()
        self.solver.parameters.max_time_in_seconds = self.time_limit_seconds
        if self.random_seed is not None:
            self.solver.parameters.random_seed = self.random_seed
        # CP-SAT's search log is ~700 lines per solve. Useful when tuning
        # the model, overwhelming in normal operation (and in test output),
        # so it follows the service's own log level instead of being on
        # unconditionally.
        self.solver.parameters.log_search_progress = logger.isEnabledFor(logging.DEBUG)
        self._apply_stop_request()

        self.status = self.solver.Solve(model_data['model'])

        elapsed = time.time() - start
        logger.info(f"Solve completed in {elapsed:.2f}s, status: {self.status}")

        return self._extract_result(model_data, elapsed)

    # ========================================================================
    # Solving - lexicographic (several solves, strict priority order)
    # ========================================================================

    def _solve_lexicographic(
        self,
        model_data: dict,
        soft_slots: dict[tuple[str, str], float],
        preferred_slots: dict[tuple[str, str], float],
    ) -> dict:
        """
        "Prioriteitenplanner": runs up to 5 sequential solves on the same
        model instead of one weighted-sum minimize, each phase locking its
        own just-found optimum in as a `<=` constraint before the next
        phase's objective is even considered. A later phase can therefore
        never trade away so much as one unit of an earlier phase's result
        in exchange for improving its own - there is no shared currency
        (a weight) for it to spend against a higher phase, unlike the
        'weighted' model where enough smaller terms stacking up can
        approach a supposedly-dominant one.

        Phases, most senior first:

        1. Coverage - minimize total shortfall (unfilled slot-headcount).
        2. Fairness (worst case) - minimize the single worst individual's
           band deviation (under+over from add_band_constraints) via
           AddMaxEquality over everyone's deviation, not the *sum* of
           deviations the weighted model's add_band_imbalance_objective
           uses - a sum is indifferent between "one person 4 off" and
           "four people 1 off each" (both sum to 4), which is exactly the
           failure mode this exists to close structurally rather than
           calibrate around.
        2b. Fairness (spread) - with that worst case now fixed, minimize
            the *sum* of deviations too, so among every allocation tied on
            the worst case, the one that also spreads the remainder most
            evenly still wins. Not one of Opus's four core phases, but a
            cheap, natural tie-break extension of it (real leximin would
            repeat 2 on the second-worst, third-worst, etc. - this is a
            lighter approximation of the same idea, one extra solve
            instead of up to N).
        3. Soft blocking - minimize weighted LIEVER_NIET violations.
        4. Preference - maximize weighted VOORKEUR honoured, with
           everything above already locked in.

        Phase 1 always runs (even with nothing to minimize, `sum([])` is a
        valid degenerate objective) so self.solver/self.status are always
        populated by the time this returns, even for a period with no
        slots at all. Phases 2/2b/3/4 are skipped outright when there is
        nothing for them to optimize (no band counters in play, no soft
        marks, no preferences) - skipping is safe because there is nothing
        to fix afterward either, so the previous phase's fixed result
        already speaks for the whole model as far as that phase is
        concerned.

        Each phase gets an equal slice of self.time_limit_seconds - a
        planner's configured budget is a promise about total wall-clock
        time, not a per-phase one.
        """
        model = model_data['model']
        shortfall_vars = model_data['shortfall_vars']
        band_slack_vars = model_data['band_slack_vars']
        assignment_vars = model_data['assignment_vars']

        PHASES = 5
        phase_time_limit = max(1.0, self.time_limit_seconds / PHASES)
        total_start = time.time()

        def run_phase(objective_expr, sense: str, label: str):
            if sense == 'min':
                model.Minimize(objective_expr)
            else:
                model.Maximize(objective_expr)
            self.solver = cp_model.CpSolver()
            self.solver.parameters.max_time_in_seconds = phase_time_limit
            if self.random_seed is not None:
                self.solver.parameters.random_seed = self.random_seed
            self.solver.parameters.log_search_progress = logger.isEnabledFor(logging.DEBUG)
            self._apply_stop_request()
            self.status = self.solver.Solve(model)
            ok = self.status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
            value = self.solver.ObjectiveValue() if ok else None
            logger.info(f"Lexicographic phase '{label}': status={self.status}, value={value}")
            return ok, value

        # Phase 1: coverage. Always runs - see docstring.
        shortfall_expr = sum(shortfall_vars.values()) if shortfall_vars else 0
        ok, shortfall_opt = run_phase(shortfall_expr, 'min', '1 dekking')
        if not ok:
            elapsed = time.time() - total_start
            return self._extract_result(model_data, elapsed)
        if shortfall_vars:
            model.Add(sum(shortfall_vars.values()) <= round(shortfall_opt))

        # Phase 2 (+2b): fairness.
        deviations = [under + over for (under, over) in band_slack_vars.values()]
        if deviations:
            max_dev = model.NewIntVar(0, 100_000, 'lex_max_deviation')
            model.AddMaxEquality(max_dev, deviations)
            ok, max_dev_opt = run_phase(max_dev, 'min', '2 eerlijkheid (grootste afwijking)')
            if not ok:
                elapsed = time.time() - total_start
                return self._extract_result(model_data, elapsed)
            model.Add(max_dev <= round(max_dev_opt))

            ok, sum_dev_opt = run_phase(sum(deviations), 'min', '2b eerlijkheid (totale afwijking)')
            if not ok:
                elapsed = time.time() - total_start
                return self._extract_result(model_data, elapsed)
            model.Add(sum(deviations) <= round(sum_dev_opt))

        # Phase 3: soft blocking (LIEVER_NIET).
        soft_terms = [
            penalty * assignment_vars[(p, s)]
            for (p, s), penalty in soft_slots.items()
            if (p, s) in assignment_vars
        ]
        if soft_terms:
            ok, soft_opt = run_phase(sum(soft_terms), 'min', '3 liever-niet')
            if not ok:
                elapsed = time.time() - total_start
                return self._extract_result(model_data, elapsed)
            model.Add(sum(soft_terms) <= round(soft_opt))

        # Phase 4: preference (VOORKEUR) - final phase, nothing left to fix
        # afterward.
        preference_terms = [
            value * assignment_vars[(p, s)]
            for (p, s), value in (preferred_slots or {}).items()
            if (p, s) in assignment_vars
        ]
        if preference_terms:
            ok, _ = run_phase(sum(preference_terms), 'max', '4 voorkeur')
            if not ok:
                elapsed = time.time() - total_start
                return self._extract_result(model_data, elapsed)

        elapsed = time.time() - total_start
        logger.info(f"Lexicographic solve completed in {elapsed:.2f}s across all phases")
        return self._extract_result(model_data, elapsed)

    # ========================================================================
    # Shared result extraction
    # ========================================================================

    def _extract_result(self, model_data: dict, elapsed: float) -> dict:
        """
        Reads assignments/unfilled slots/violations off self.solver +
        self.status - whatever the most recent Solve() call left there,
        whether that was solve()'s single weighted solve or
        _solve_lexicographic's final phase. Shared so both paths report
        results in exactly the same shape and get exactly the same
        band_limit/capacity bookkeeping.
        """
        assignment_vars = model_data['assignment_vars']

        assignments = []
        if self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
            for (person_id, slot_id), var in assignment_vars.items():
                if self.solver.Value(var) == 1:
                    assignments.append({
                        'person_id': person_id,
                        'slot_id': slot_id
                    })

        logger.info(f"Extracted {len(assignments)} assignments")

        # Capacity is a soft constraint (see constraints.py) so the solver
        # can return OPTIMAL/FEASIBLE with some slots still short of their
        # required headcount - surface exactly which ones so the planner
        # can fill the rest by hand.
        unfilled_slots = []
        if self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
            for slot_id, shortfall_var in model_data['shortfall_vars'].items():
                shortfall = self.solver.Value(shortfall_var)
                if shortfall > 0:
                    unfilled_slots.append({'slot_id': slot_id, 'shortfall': shortfall})

        if unfilled_slots:
            logger.warning(f"{len(unfilled_slots)} slots left short of required headcount")

        status_map = {
            cp_model.OPTIMAL: "OPTIMAL",
            cp_model.FEASIBLE: "FEASIBLE",
            cp_model.INFEASIBLE: "INFEASIBLE",
            cp_model.MODEL_INVALID: "MODEL_INVALID"
        }

        # window_rule, blocking_absolute and holiday_spread are hard
        # constraints (unconditional model.Add()s) - a solution reported as
        # OPTIMAL/FEASIBLE can never violate them, so the build-time 0 from
        # get_violations_summary() is already correct for those. capacity
        # and band_limit are soft (shortfall/under/over slack variables),
        # so their real counts only exist after solving - they used to stay
        # at their build-time 0 forever, which made the planner's
        # "Overtredingen" panel always show 0 even when slots were left
        # short or people pushed outside their band.
        violations = model_data['constraints_builder'].get_violations_summary()
        if self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
            violations['capacity'] = len(unfilled_slots)

            band_slack_vars = model_data.get('band_slack_vars', {})
            band_violations = 0
            max_band_deviation = 0
            total_band_deviation = 0
            for under_var, over_var in band_slack_vars.values():
                deviation = self.solver.Value(under_var) + self.solver.Value(over_var)
                if deviation > 0:
                    band_violations += 1
                max_band_deviation = max(max_band_deviation, deviation)
                total_band_deviation += deviation
            violations['band_limit'] = band_violations
        else:
            max_band_deviation = 0
            total_band_deviation = 0

        return {
            'success': self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE],
            'status': status_map.get(self.status, "UNKNOWN"),
            'assignments': assignments,
            'unfilled_slots': unfilled_slots,
            'objective_value': self.solver.ObjectiveValue() if self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE] else None,
            'time_seconds': elapsed,
            'violations': violations,
            # Used by the Next.js "Herhaalplanner" multi-start loop to rank
            # attempts against each other (see
            # lib/rosterGenerationJobs.ts's isBetterRoster) - the *sum*
            # (max_band_deviation) already existed as a violation *count*
            # above, but ranking attempts needs the actual magnitude, not
            # just how many people were affected.
            'max_band_deviation': max_band_deviation,
            'total_band_deviation': total_band_deviation,
        }

    # ========================================================================
    # Full Pipeline
    # ========================================================================

    def generate_roster(
        self,
        period_id: str,
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
        soft_block_penalty: float = 1.0,
        distribution_mode: str = 'GELIJK',
        participation_factors: Optional[dict[str, float]] = None,
        coverage_factors: Optional[dict[str, float]] = None,
        band_deviation_penalty: Optional[list[float]] = None,
        band_deviation_multiplier: float = 1.0,
        holiday_spread_weeks: int = 0,
        shortfall_weight: float = 1000.0,
        band_imbalance_weight: float = 0.5,
        preference_reward_weight: float = 0.3,
        objective_mode: str = 'weighted',
        random_seed: Optional[int] = None,
        window_weeks_avond: Optional[int] = None,
        window_weeks_weekend_feestdag: Optional[int] = None,
        band_overrides: Optional[dict[str, dict[str, tuple[int, int]]]] = None
    ) -> dict:
        """
        End-to-end: build model, solve (weighted or lexicographic per
        objective_mode), extract assignments.

        random_seed only ever varies CP-SAT's own search, never the model
        or constraints - passing the same seed for the same input always
        reproduces the same result. Set by the "Herhaalplanner" multi-start
        loop (Next.js) to a different value per attempt so repeated calls
        with otherwise identical input can land on different solutions.

        window_weeks_avond/window_weeks_weekend_feestdag: see build_model's
        per_teller_windows - both None (default) keeps the single pooled
        window_weeks, for backward compatibility with periods frozen
        before this existed.
        """
        logger.info(f"Generating roster for period {period_id} (objective_mode={objective_mode}, random_seed={random_seed})")
        self.random_seed = random_seed

        try:
            # Build
            model_data = self.build_model(
                people, slots, blocked_slots, soft_slots,
                band_ranges, balances, window_weeks, preferred_slots,
                prior_assignments, manual_assignments, soft_block_penalty,
                distribution_mode, participation_factors, coverage_factors,
                band_deviation_penalty, band_deviation_multiplier,
                holiday_spread_weeks, shortfall_weight, band_imbalance_weight,
                preference_reward_weight, objective_mode,
                window_weeks_avond=window_weeks_avond,
                window_weeks_weekend_feestdag=window_weeks_weekend_feestdag,
                band_overrides=band_overrides
            )

            # Solve
            if objective_mode == 'lexicographic':
                result = self._solve_lexicographic(model_data, soft_slots, preferred_slots or {})
            else:
                result = self.solve(model_data)

            assigned_pairs = {(a['person_id'], a['slot_id']) for a in result['assignments']}
            # Counted from the actual assignment, not read off an objective
            # term - meaningful under both objective_mode's, and the only
            # way the "Herhaalplanner" loop (which always solves
            # 'lexicographic') can compare liever-niet/voorkeur quality
            # between attempts that tied on coverage and fairness.
            soft_block_violations = sum(1 for pair in soft_slots if pair in assigned_pairs)
            preference_matches = sum(1 for pair in (preferred_slots or {}) if pair in assigned_pairs)

            return {
                'success': result['success'],
                'period_id': period_id,
                'assignments': result['assignments'],
                'diagnostics': {
                    'total_slots': len(slots),
                    'total_assignments': len(result['assignments']),
                    'unfilled_slots': result['unfilled_slots'],
                    'total_cost': result['objective_value'] or 0,
                    'time_seconds': result['time_seconds'],
                    'solver_status': result['status'],
                    'violations': result['violations'],
                    'max_band_deviation': result.get('max_band_deviation', 0),
                    'total_band_deviation': result.get('total_band_deviation', 0),
                    'soft_block_violations': soft_block_violations,
                    'preference_matches': preference_matches,
                }
            }

        except Exception as e:
            logger.error(f"Roster generation failed: {str(e)}", exc_info=True)
            return {
                'success': False,
                'period_id': period_id,
                'assignments': [],
                'diagnostics': {
                    'total_slots': len(slots),
                    'total_assignments': 0,
                    'unfilled_slots': [],
                    'total_cost': 0,
                    'time_seconds': 0,
                    'solver_status': 'ERROR',
                    'violations': {},
                    'max_band_deviation': 0,
                    'total_band_deviation': 0,
                    'soft_block_violations': 0,
                    'preference_matches': 0,
                }
            }

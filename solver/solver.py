"""
CP-SAT Solver Execution

Orchestrates model building, constraint application, and solution extraction.
"""

import logging
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
        holiday_spread_weeks: int = 0
    ) -> dict:
        """
        Build the CP-SAT model with all constraints and objectives.

        Returns:
        {
            'model': cp_model.CpModel,
            'assignment_vars': dict[(person, slot) -> IntVar],
            'constraints_builder': ConstraintBuilder
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

        logger.info("Adding window constraints")
        constraint_builder.add_window_constraints(
            assignment_vars, people, slots, window_weeks
        )

        # prior_assignments (before this period) and manual_assignments
        # (already fixed within this period, before this solve - see
        # main.py's SolverInput) are both "immovable facts the window rule
        # must respect", just with different sources - concatenating them
        # here has the same effect as calling either constraint function
        # once per list, since each fact is applied independently.
        fixed_assignments = (prior_assignments or []) + (manual_assignments or [])

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
            coverage_factors=coverage_factors, already_assigned=already_assigned
        )

        # Add objectives
        objective_builder = ObjectiveBuilder(self.model)

        logger.info("Adding shortfall objective")
        shortfall_cost = objective_builder.add_shortfall_objective(
            shortfall_vars, weight=1000.0
        )

        logger.info("Adding band slack objective")
        band_slack_cost = objective_builder.add_band_slack_objective(
            band_slack_vars, penalty_tiers=band_deviation_penalty, multiplier=band_deviation_multiplier
        )

        logger.info("Adding soft preference objective")
        soft_cost = objective_builder.add_soft_preference_objective(
            assignment_vars, soft_slots, weight=soft_block_penalty
        )

        logger.info("Adding band imbalance objective")
        imbalance_cost = objective_builder.add_band_imbalance_objective(
            assignment_vars, people, slots, band_ranges, balances, weight=0.5,
            distribution_mode=distribution_mode, participation_factors=participation_factors,
            coverage_factors=coverage_factors, already_assigned=already_assigned
        )

        logger.info("Adding preference reward objective")
        preference_reward_cost = objective_builder.add_preference_reward_objective(
            assignment_vars, preferred_slots or {}, weight=0.3
        )

        logger.info("Building combined objective")
        objective_builder.build_objective(
            shortfall_cost=shortfall_cost,
            band_slack_cost=band_slack_cost,
            soft_cost=soft_cost,
            imbalance_cost=imbalance_cost,
            preference_reward_cost=preference_reward_cost
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
    # Solving
    # ========================================================================

    def solve(
        self,
        model_data: dict
    ) -> dict:
        """
        Run the CP-SAT solver.

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

        model = model_data['model']
        assignment_vars = model_data['assignment_vars']

        # Create solver with time limit
        self.solver = cp_model.CpSolver()
        self.solver.parameters.max_time_in_seconds = self.time_limit_seconds
        # CP-SAT's search log is ~700 lines per solve. Useful when tuning
        # the model, overwhelming in normal operation (and in test output),
        # so it follows the service's own log level instead of being on
        # unconditionally.
        self.solver.parameters.log_search_progress = logger.isEnabledFor(logging.DEBUG)

        # Solve
        self.status = self.solver.Solve(model)

        elapsed = time.time() - start
        logger.info(f"Solve completed in {elapsed:.2f}s, status: {self.status}")

        # Extract solution
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
            for under_var, over_var in band_slack_vars.values():
                if self.solver.Value(under_var) > 0 or self.solver.Value(over_var) > 0:
                    band_violations += 1
            violations['band_limit'] = band_violations

        return {
            'success': self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE],
            'status': status_map.get(self.status, "UNKNOWN"),
            'assignments': assignments,
            'unfilled_slots': unfilled_slots,
            'objective_value': self.solver.ObjectiveValue() if self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE] else None,
            'time_seconds': elapsed,
            'violations': violations
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
        holiday_spread_weeks: int = 0
    ) -> dict:
        """
        End-to-end: build model, solve, extract assignments.
        """
        logger.info(f"Generating roster for period {period_id}")

        try:
            # Build
            model_data = self.build_model(
                people, slots, blocked_slots, soft_slots,
                band_ranges, balances, window_weeks, preferred_slots,
                prior_assignments, manual_assignments, soft_block_penalty,
                distribution_mode, participation_factors, coverage_factors,
                band_deviation_penalty, band_deviation_multiplier,
                holiday_spread_weeks
            )

            # Solve
            result = self.solve(model_data)

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
                    'violations': result['violations']
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
                    'violations': {}
                }
            }

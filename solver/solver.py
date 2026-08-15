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

    def __init__(self, time_limit_seconds: int = 30):
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
        capacity_required: dict[str, int],
        band_ranges: dict[str, list[int]],
        balances: dict[str, dict[str, int]],
        window_weeks: int = 2
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
            assignment_vars, people, slots, band_ranges, balances
        )

        # Add objectives
        objective_builder = ObjectiveBuilder(self.model)

        logger.info("Adding shortfall objective")
        shortfall_cost = objective_builder.add_shortfall_objective(
            shortfall_vars, weight=1000.0
        )

        logger.info("Adding band slack objective")
        band_slack_cost = objective_builder.add_band_slack_objective(
            band_slack_vars, weight=5.0
        )

        logger.info("Adding soft preference objective")
        soft_cost = objective_builder.add_soft_preference_objective(
            assignment_vars, soft_slots, weight=1.0
        )

        logger.info("Adding band imbalance objective")
        imbalance_cost = objective_builder.add_band_imbalance_objective(
            assignment_vars, people, slots, band_ranges, balances, weight=0.5
        )

        logger.info("Building combined objective")
        objective_builder.build_objective(
            shortfall_cost=shortfall_cost,
            band_slack_cost=band_slack_cost,
            soft_cost=soft_cost,
            imbalance_cost=imbalance_cost
        )

        elapsed = time.time() - start
        logger.info(f"Model built in {elapsed:.2f}s")

        return {
            'model': self.model,
            'assignment_vars': assignment_vars,
            'shortfall_vars': shortfall_vars,
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

        return {
            'success': self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE],
            'status': status_map.get(self.status, "UNKNOWN"),
            'assignments': assignments,
            'unfilled_slots': unfilled_slots,
            'objective_value': self.solver.ObjectiveValue() if self.status in [cp_model.OPTIMAL, cp_model.FEASIBLE] else None,
            'time_seconds': elapsed,
            'violations': model_data['constraints_builder'].get_violations_summary()
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
        band_ranges: dict[str, list[int]],
        balances: dict[str, dict[str, int]],
        window_weeks: int = 2
    ) -> dict:
        """
        End-to-end: build model, solve, extract assignments.
        """
        logger.info(f"Generating roster for period {period_id}")

        try:
            # Build
            model_data = self.build_model(
                people, slots, blocked_slots, soft_slots, {},
                band_ranges, balances, window_weeks
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

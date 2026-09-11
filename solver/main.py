"""
Dienstrooster Solver Service

FastAPI service using Google OR-Tools CP-SAT solver for fair roster generation.
Phase 1: Infrastructure and data models
Phase 2: Constraint implementation and solver execution
"""

import logging
import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import Literal, Optional
from datetime import datetime, timezone

# Setup logging - LOG_LEVEL (docker-compose.yml / .env.example) picks the
# verbosity; an unset or unrecognised value falls back to INFO rather than
# failing startup over a typo.
_log_level = getattr(logging, os.environ.get('LOG_LEVEL', 'INFO').upper(), logging.INFO)
logging.basicConfig(
    level=_log_level,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown logging - replaces the deprecated @app.on_event
    decorators (removed in newer FastAPI/Starlette) with the lifespan
    context manager they were replaced by."""
    logger.info("=" * 60)
    logger.info("Dienstrooster Solver Service Starting")
    logger.info("=" * 60)
    logger.info("Version: 1.0.0")
    logger.info("Endpoints:")
    logger.info("  - GET  /health       (health check)")
    logger.info("  - POST /solve        (generate roster)")
    logger.info("=" * 60)
    yield
    logger.info("Dienstrooster Solver Service shutting down")


# Create FastAPI app
app = FastAPI(
    title="Dienstrooster Solver",
    description="CP-SAT Solver for fair shift roster generation",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware - this service is only ever called server-to-server by the
# web container (see docker-compose.yml: solver has no published port), so
# there is no browser origin to allow and no need for credentialed requests.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_credentials=False,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


# ============================================================================
# Pydantic Models
# ============================================================================

class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "solver"
    version: str = "1.0.0"
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class Slot(BaseModel):
    id: str
    datum: str  # YYYY-MM-DD
    iso_jaar: int
    iso_week: int
    shift_type_id: str
    shift_type_name: str  # AVOND, WEEKEND, FEESTDAG
    # Must be >=1: constraints.add_capacity_constraints builds
    # `NewIntVar(0, required, ...)`, an invalid (empty) domain for
    # required<=0 that CP-SAT raises on - previously reached that raise and
    # was swallowed by generate_roster's broad except into a generic
    # 'ERROR' status instead of a clean 422 at the API boundary.
    benodigd_aantal_personen: int = Field(default=1, ge=1)
    is_feestdag: bool = False
    feestdag_groep: Optional[str] = None


class PersonPreference(BaseModel):
    slot_id: str
    # A typo here (e.g. "ABSOLUT") used to fall through every branch in
    # solve_roster's if/elif as silently-untreated, no error and no
    # constraint applied - Literal makes FastAPI reject it as a 422
    # instead of solving the wrong problem.
    blocking_level: Literal['ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR', 'NEUTRAL']


class PriorAssignment(BaseModel):
    """
    A shift that already happened just before this period started - the
    confirmed tail of the previous period (dienstrooster_prior_assignment).
    Lets the window rule see across the period boundary instead of
    resetting at week 1 of every new period. `teller` additionally lets
    add_holiday_spread_constraints see a FEESTDAG shift that happened just
    before the period started, the same way window_weeks already does for
    any counter via add_prior_assignment_constraints.
    """
    person_id: str
    datum: str  # YYYY-MM-DD
    teller: str  # AVOND, WEEKEND, or FEESTDAG


class RuleSet(BaseModel):
    window_weeks: int = Field(default=2, ge=0)
    # A fixed 2-tuple rather than list[int]: constraints.py always does
    # `base_min, base_max = band_ranges.get(counter, [7, 8])`, and a
    # wrong-length list used to reach that unpack and crash with a raw
    # Python ValueError, caught by generate_roster's broad except as a
    # generic solver ERROR instead of a clean 422 at the API boundary.
    #
    # Each tuple must be (min, max) with 0 <= min <= max - a reversed pair
    # (e.g. accidentally sending (9, 7)) used to be accepted silently and
    # would give every person simultaneous under- and over-band slack in
    # add_band_constraints, doubling their deviation cost for no reason
    # instead of erroring.
    band_avond: tuple[int, int] = (7, 8)
    band_weekend: tuple[int, int] = (7, 8)
    band_feestdag: tuple[int, int] = (7, 8)
    distribution_mode: Literal['GELIJK', 'NAAR_RATO'] = "GELIJK"
    # A negative value would turn the LIEVER_NIET penalty into a reward,
    # actively steering the solver towards a blocked-but-not-ABSOLUUT slot.
    soft_block_penalty: float = Field(default=1.0, ge=0)
    # Cumulative, escalating cost per unit a person strays outside their
    # band - see objective.add_band_slack_objective. Default reproduces
    # the flat weight=5.0-per-unit behaviour this replaced. Each tier must
    # be non-negative for the same reason as soft_block_penalty above.
    #
    # Deliberately not capped below the shortfall weight (1000.0 in
    # solver.py) - a planner who sets aggressive tiers here (e.g.
    # [10, 40, 160, 640, 2560]) can reach a level where the solver prefers
    # leaving a slot unfilled over stretching one person's band further,
    # which sits above the shortfall weight. Raised and decided during
    # review: that's accepted, not a bug - a planner who wants "coverage
    # always wins, no matter how extreme the deviation" achieves that by
    # not configuring tiers that high, not because the solver enforces it.
    band_deviation_penalty: list[float] = [5.0]
    # >=1 so tiers beyond the configured list only ever escalate
    # (penalty_tiers[-1] * multiplier**extra_levels) rather than silently
    # de-escalating for multiplier<1, which would undo the whole point of
    # tiered, spread-the-shortage-don't-concentrate-it pricing.
    band_deviation_multiplier: float = Field(default=1.0, ge=1.0)
    # Hard minimum weeks between two FEESTDAG shifts for the same person,
    # independent of window_weeks. 0 (default) = no such rule.
    holiday_spread_weeks: int = Field(default=0, ge=0)

    @field_validator('band_avond', 'band_weekend', 'band_feestdag')
    @classmethod
    def _band_is_ordered_and_nonnegative(cls, value: tuple[int, int]) -> tuple[int, int]:
        low, high = value
        if low < 0 or high < 0:
            raise ValueError('band values must be >= 0')
        if low > high:
            raise ValueError('band min must be <= band max')
        return value

    @field_validator('band_deviation_penalty')
    @classmethod
    def _penalty_tiers_are_positive(cls, value: list[float]) -> list[float]:
        # Zero (not just negative) must be rejected too: the documented
        # weight hierarchy is shortfall > band_slack > soft_blocking >
        # preferred (VOORKEUR), with the latter two hardcoded in solver.py
        # at 1.0 and 0.3 - a tier of 0 (or an empty list, silently replaced
        # by the [5.0] default deeper in objective.py) makes that specific
        # unit of band deviation genuinely free, and since tier_cost()
        # extrapolates every tier beyond the configured ones from the last
        # one, a trailing 0 makes ALL further deviation free too. That lets
        # a ruleset config alone - no code change - turn off the fairness
        # enforcement the solver exists for while leaving VOORKEUR's
        # hardcoded reward untouched, silently inverting the hierarchy.
        if not value:
            raise ValueError('band_deviation_penalty must not be empty')
        if any(tier <= 0 for tier in value):
            raise ValueError('band_deviation_penalty tiers must all be > 0')
        return value


class SolverInput(BaseModel):
    period_id: str
    slots: list[Slot]
    person_preferences: dict[str, list[PersonPreference]]
    people: list[str]
    rules: RuleSet
    balances: dict[str, dict[str, int]]
    prior_assignments: list[PriorAssignment] = []
    # person_id -> pool_membership.deelnamefactor (e.g. 0.5 for half-time).
    # Only consulted when rules.distribution_mode == "NAAR_RATO" - see
    # constraints.add_band_constraints.
    participation_factors: dict[str, float] = {}
    # How long CP-SAT may search before returning its best-so-far solution.
    # Default matches the "standaard" duration offered in the roster
    # generation dialog; a planner can ask for a longer search (5, then 10
    # minutes) when a first attempt comes back FEASIBLE rather than
    # OPTIMAL. Capped at 600s (10 minutes) - beyond that the dialog itself
    # has no further "try longer" option, and an unbounded value would let
    # a single request pin the solver indefinitely (see generate-roster
    # route/RosterGenerationDialog for the rest of that design tradeoff).
    time_limit_seconds: int = Field(default=120, ge=1, le=600)

    @field_validator('slots')
    @classmethod
    def _slot_ids_are_unique(cls, value: list[Slot]) -> list[Slot]:
        # constraints.py/objective.py key every assignment variable and
        # capacity/band constraint on slot.id - a caller-side bug that
        # sends the same slot twice (e.g. a duplicated row from the
        # Next.js query) would otherwise silently produce a wrong model
        # rather than a clean error: the second record's assignment
        # variable overwrites the first's, a capacity constraint gets
        # added twice for the same variable, and band/imbalance totals
        # double-count that one assignment - never a crash, just a
        # quietly wrong roster.
        seen = set()
        for slot in value:
            if slot.id in seen:
                raise ValueError(f'duplicate slot id: {slot.id}')
            seen.add(slot.id)
        return value


class Assignment(BaseModel):
    person_id: str
    slot_id: str
    source: str = "SOLVER"


class UnfilledSlot(BaseModel):
    slot_id: str
    shortfall: int


class SolverDiagnostics(BaseModel):
    total_slots: int
    total_assignments: int
    unfilled_slots: list[UnfilledSlot] = []
    total_cost: float
    time_seconds: float
    solver_status: str
    violations: dict[str, int]


class SolverOutput(BaseModel):
    success: bool
    period_id: str
    assignments: list[Assignment]
    diagnostics: SolverDiagnostics
    message: str = "Roster generated successfully"


# ============================================================================
# Endpoints
# ============================================================================

@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint for orchestration"""
    logger.debug("Health check requested")
    return HealthResponse()


@app.get("/")
async def root():
    """Root endpoint - service information"""
    return {
        "service": "Dienstrooster Solver",
        "version": "1.0.0",
        "status": "ready",
        "endpoints": {
            "health": "/health",
            "solve": "/solve (POST)"
        }
    }


@app.post("/solve", response_model=SolverOutput)
async def solve_roster(request: SolverInput):
    """
    Generate roster assignments using CP-SAT solver.

    Receives:
    - period_id: Period identifier
    - slots: List of shift slots to fill
    - person_preferences: Blocking/soft preferences per person
    - people: List of person IDs
    - rules: Window weeks, band ranges, distribution mode
    - balances: Current balance per person per counter
    - prior_assignments: Confirmed tail of the previous period, so the
      window rule carries over across the period boundary

    Returns:
    - assignments: List of person-slot pairings
    - diagnostics: Cost breakdown, violations, solver status
    """
    start_time = time.time()
    logger.info(f"Solve request for period {request.period_id}")
    logger.info(f"  Slots: {len(request.slots)}")
    logger.info(f"  People: {len(request.people)}")
    logger.info(f"  Window weeks: {request.rules.window_weeks}")

    try:
        from solver import RosterSolver

        # Build blocked, soft, and preferred slot sets
        blocked_slots = set()
        soft_slots = {}
        preferred_slots = {}

        for person_id, preferences in request.person_preferences.items():
            for pref in preferences:
                if pref.blocking_level == "ABSOLUUT":
                    blocked_slots.add((person_id, pref.slot_id))
                elif pref.blocking_level == "LIEVER_NIET":
                    soft_slots[(person_id, pref.slot_id)] = 1.0
                elif pref.blocking_level == "VOORKEUR":
                    preferred_slots[(person_id, pref.slot_id)] = 1.0

        # Under NAAR_RATO, constraints.add_band_constraints and
        # objective.add_band_slack_objective both silently fall back to
        # factor=1.0 (full-time) for anyone missing from
        # participation_factors via `factors.get(person_id, 1.0)` - that's
        # a reasonable default to keep the solve from failing outright,
        # but it defeats the whole point of NAAR_RATO for that person with
        # no signal anywhere that it happened. Surface it in the logs so a
        # data-drift bug (a caller forgetting to send someone's factor)
        # doesn't go completely unnoticed.
        if request.rules.distribution_mode == 'NAAR_RATO':
            missing_factors = [p for p in request.people if p not in request.participation_factors]
            if missing_factors:
                logger.warning(
                    f"NAAR_RATO active but {len(missing_factors)} of {len(request.people)} "
                    f"people have no participation_factors entry - defaulting to 1.0 "
                    f"(full-time) for: {missing_factors}"
                )

        # Build band ranges
        band_ranges = {
            'AVOND': request.rules.band_avond,
            'WEEKEND': request.rules.band_weekend,
            'FEESTDAG': request.rules.band_feestdag,
        }

        # Run solver
        solver = RosterSolver(time_limit_seconds=request.time_limit_seconds)
        result = solver.generate_roster(
            period_id=request.period_id,
            people=request.people,
            slots=[s.model_dump() for s in request.slots],
            blocked_slots=blocked_slots,
            soft_slots=soft_slots,
            band_ranges=band_ranges,
            balances=request.balances,
            window_weeks=request.rules.window_weeks,
            preferred_slots=preferred_slots,
            prior_assignments=[p.model_dump() for p in request.prior_assignments],
            soft_block_penalty=request.rules.soft_block_penalty,
            distribution_mode=request.rules.distribution_mode,
            participation_factors=request.participation_factors,
            band_deviation_penalty=request.rules.band_deviation_penalty,
            band_deviation_multiplier=request.rules.band_deviation_multiplier,
            holiday_spread_weeks=request.rules.holiday_spread_weeks
        )

        if not result['success']:
            logger.warning(f"Solver did not find optimal solution: {result['diagnostics']}")

        assignments = [Assignment(**a) for a in result['assignments']]
        diagnostics = SolverDiagnostics(**result['diagnostics'])

        elapsed = time.time() - start_time
        logger.info(f"Solve completed: {len(assignments)} assignments in {elapsed:.2f}s")

        # Unconditionally "Generated N assignments" used to read as a
        # success message even when result['success'] was False (e.g.
        # INFEASIBLE, or UNKNOWN after the time_limit) - "Generated 0
        # assignments in 0.03s" looks like nothing went wrong. The Next.js
        # side (generate-roster/route.ts) forwards this message as-is on
        # the failure path, so it's the only text the planner ever sees.
        message = (
            f"Generated {len(assignments)} assignments in {elapsed:.2f}s"
            if result['success']
            else f"Solve did not succeed (status: {diagnostics.solver_status}) after {elapsed:.2f}s"
        )

        return SolverOutput(
            success=result['success'],
            period_id=request.period_id,
            assignments=assignments,
            diagnostics=diagnostics,
            message=message
        )

    except Exception as e:
        logger.error(f"Solver error: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Solver error: {str(e)}"
        )


# Startup/shutdown logging lives in the `lifespan` context manager near the
# top of this file, next to the `app = FastAPI(...)` call it's attached to.

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

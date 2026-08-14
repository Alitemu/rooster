"""
Dienstrooster Solver Service

FastAPI service using Google OR-Tools CP-SAT solver for fair roster generation.
Phase 1: Infrastructure and data models
Phase 2: Constraint implementation and solver execution
"""

import logging
import time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="Dienstrooster Solver",
    description="CP-SAT Solver for fair shift roster generation",
    version="1.0.0"
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
    timestamp: str = Field(default_factory=lambda: datetime.utcnow().isoformat())


class Slot(BaseModel):
    id: str
    datum: str  # YYYY-MM-DD
    iso_jaar: int
    iso_week: int
    shift_type_id: str
    shift_type_name: str  # AVOND, WEEKEND, FEESTDAG
    benodigd_aantal_personen: int = 1
    is_feestdag: bool = False
    feestdag_groep: Optional[str] = None


class PersonPreference(BaseModel):
    slot_id: str
    blocking_level: str  # ABSOLUUT or LIEVER_NIET


class RuleSet(BaseModel):
    window_weeks: int = 2
    band_avond: list[int] = [7, 8]
    band_weekend: list[int] = [7, 8]
    band_feestdag: list[int] = [7, 8]
    distribution_mode: str = "GELIJK"


class SolverInput(BaseModel):
    period_id: str
    slots: list[Slot]
    person_preferences: dict[str, list[PersonPreference]]
    people: list[str]
    rules: RuleSet
    balances: dict[str, dict[str, int]]
    active_people: int


class Assignment(BaseModel):
    person_id: str
    slot_id: str
    source: str = "SOLVER"


class SolverDiagnostics(BaseModel):
    total_slots: int
    total_assignments: int
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
    - active_people: Number of active pool members

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

        # Build blocked and soft slot sets
        blocked_slots = set()
        soft_slots = {}

        for person_id, preferences in request.person_preferences.items():
            for pref in preferences:
                if pref.blocking_level == "ABSOLUUT":
                    blocked_slots.add((person_id, pref.slot_id))
                elif pref.blocking_level == "LIEVER_NIET":
                    soft_slots[(person_id, pref.slot_id)] = 1.0

        # Build band ranges
        band_ranges = {
            'AVOND': request.rules.band_avond,
            'WEEKEND': request.rules.band_weekend,
            'FEESTDAG': request.rules.band_feestdag,
        }

        # Run solver
        solver = RosterSolver(time_limit_seconds=30)
        result = solver.generate_roster(
            period_id=request.period_id,
            people=request.people,
            slots=[s.dict() for s in request.slots],
            blocked_slots=blocked_slots,
            soft_slots=soft_slots,
            band_ranges=band_ranges,
            balances=request.balances,
            window_weeks=request.rules.window_weeks
        )

        if not result['success']:
            logger.warning(f"Solver did not find optimal solution: {result['diagnostics']}")

        assignments = [Assignment(**a) for a in result['assignments']]
        diagnostics = SolverDiagnostics(**result['diagnostics'])

        elapsed = time.time() - start_time
        logger.info(f"Solve completed: {len(assignments)} assignments in {elapsed:.2f}s")

        return SolverOutput(
            success=result['success'],
            period_id=request.period_id,
            assignments=assignments,
            diagnostics=diagnostics,
            message=f"Generated {len(assignments)} assignments in {elapsed:.2f}s"
        )

    except Exception as e:
        logger.error(f"Solver error: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Solver error: {str(e)}"
        )


# ============================================================================
# Startup/Shutdown
# ============================================================================

@app.on_event("startup")
async def startup_event():
    logger.info("=" * 60)
    logger.info("Dienstrooster Solver Service Starting")
    logger.info("=" * 60)
    logger.info("Version: 1.0.0")
    logger.info("Status: Infrastructure ready, solver implementation in progress")
    logger.info("Endpoints:")
    logger.info("  - GET  /health       (health check)")
    logger.info("  - POST /solve        (generate roster)")
    logger.info("=" * 60)


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Dienstrooster Solver Service shutting down")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

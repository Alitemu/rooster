# Dienstrooster - Phase 2: Solver & Assignment Generation

## Context

Phase 1 provided the input UI and data collection layer. Phase 2 adds the intelligent assignment engine using Google OR-Tools (CP-SAT solver) to automatically generate fair rosters based on staff preferences, part-time patterns, and balance rules.

**Output:** After Phase 2, planners can generate a complete roster with assignments for all 245 slots across all staff members, respecting all constraints and optimizing for fairness.

## High-Level Architecture

```
Phase 1: Staff Preferences → availability entries
                          ↓
Phase 2 Solver: Read preferences + rules → Python CP-SAT → assignment entries
                          ↓
Phase 1 Planner: View roster → export → publish
```

## Solver Design

### Input Data
The solver reads from the database:
1. **Slots** - 245 shift_slot entries (date, iso_week, shift_type)
2. **Preferences** - availability entries (person + slot + blocking level)
3. **Rules** - ruleset config (window, balances, factors)
4. **Balances** - ledger_entry sum per person per counter
5. **Part-time** - parttime_pattern entries (auto-constraints)
6. **Holidays** - holiday_history (group assignments)

### Constraints (Hard)

1. **Window Rule**: No consecutive shifts within `windowWeeks` days
   - If person assigned to week 5 → blocked weeks 3,4,6,7
   - Exception: same-week weekend pair is allowed

2. **Blocking Absolute**: Person with `ABSOLUUT` (blocked) cannot be assigned
   - Soft: LIEVER_NIET preferences carry -1 penalty to objective

3. **Part-time Pattern**: 
   - ELKE_WEEK: must assign on this weekday every week
   - EVEN_WEKEN/ONEVEN_WEKEN: every 2 weeks on weekday
   - Cannot be overridden by preferences

4. **Capacity per Slot**: Each slot needs `benodigd_aantal_personen` people (default 1)

5. **Band Limits**: Each person's total assignments must be in `band[min, max]` range
   - Adjusted for balance: actual_band = band + ledger_sum
   - Examples:
     - Beginsaldo -1 → band [7,8] becomes [6,7]
     - Beginsaldo +2 → band [7,8] becomes [9,10]

6. **Holiday Rotation**: Count holiday assignments per group per year
   - Store in holiday_history (person, group, year, count)
   - Constraint: try to equalize across group

### Objective (Soft)

Minimize:
1. Total violations of LIEVER_NIET preferences (soft blocking)
2. Imbalance in band fulfillment (prefer middle of band)
3. Imbalance in holiday assignments (fair rotation)
4. Large jumps in starting balance for next period

## Implementation Plan (7 steps)

### Step 1: Solver Service Infrastructure
**Files:** 
- `solver/main.py` - FastAPI app
- `solver/requirements.txt` - Dependencies (ortools, pydantic, etc.)
- `solver/Dockerfile` - Container definition
- `docker-compose.yml` - Update to include solver service

**What:** Set up Python FastAPI server as separate container, health check endpoint, logging.

### Step 2: Data Models & Schemas
**Files:**
- `solver/models.py` - Input/output Pydantic models
- `solver/constraints.py` - Constraint definitions
- `solver/objective.py` - Objective function definitions

**What:**
- `SolverInput` - Full problem data (slots, preferences, rules, balances)
- `Assignment` - Output (person_id, slot_id, source='SOLVER')
- `SolverOutput` - List of assignments + diagnostics
- `ConstraintViolation` - Tracking hard constraint breaches (should be 0)

### Step 3: Constraint Building
**Files:**
- `solver/constraints.py` (expanded)

**What:** Implement in CP-SAT:
1. Window rule (BoolVar per person-week, at most 1 true per window)
2. Blocking absolute (skip assignment to ABSOLUUT slots)
3. Part-time pattern (force assignment on matching weekdays per frequency)
4. Capacity (sum of assignments per slot = required)
5. Band limits (sum per counter per person = band)
6. Holiday rotation (track per group, apply soft equality)

### Step 4: Objective Function
**Files:**
- `solver/objective.py` (expanded)

**What:** Combine penalties:
1. LIEVER_NIET violations: cost = 1 per violation
2. Band imbalance: cost = abs(assigned - target) per person per counter
3. Holiday inequality: cost = variance across group
4. Scale appropriately so each term is meaningful

### Step 5: Solver Execution
**Files:**
- `solver/solver.py`

**What:**
- Load input, build model, add constraints, set objective
- Run CP-SAT with time limit (e.g., 30 seconds)
- Extract solution, convert to Assignment entries
- Generate diagnostics: cost breakdown, violations, time spent

### Step 6: Backend Integration
**Files:**
- `server/generateRoster.ts` - Server action
- `app/api/planner/period/[id]/generate-roster/route.ts` - API endpoint

**What:**
- Validate period is in CONCEPT or OPEN status
- Fetch input data from DB
- POST to solver service
- Store assignments in DB
- Update period status to GENERATED
- Return assignment summary + cost breakdown

### Step 7: Planner UI & Testing
**Files:**
- `components/RosterGenerationDialog.tsx` - Trigger + progress
- `components/RosterDiagnostics.tsx` - Cost breakdown + violations
- `tests/solver-integration.test.ts` - End-to-end (local OR-Tools)
- `tests/e2e/roster-generation.spec.ts` - Playwright full flow

**What:**
- Button in planner dashboard to generate roster
- Progress modal during solver run
- Display results: assignments created, cost, time
- Show any soft violations (LIEVER_NIET missed)
- Ability to regenerate or manually override

## Data Flow

### Request (Planner clicks "Generate Roster")
```
POST /api/planner/period/[id]/generate-roster
{
  period_id: "period-2027-1"
}
↓
Backend fetches from DB:
  - 245 shift_slot entries
  - 30 × 245 availability entries
  - Pool membership, part-time patterns, ledger sums
  - Holiday history for current year
↓
Sends to Solver:
  SolverInput {
    slots: [...],
    person_preferences: { person_id: [{ slot_id, level }] },
    rules: { windowWeeks: 2, band: [7,8], ... },
    balances: { person_id: { counter: delta } },
    holidays: { person_id: { PASEN: count, ... } }
  }
```

### Solver Execution
```
Python CP-SAT:
  1. Create variables: x[person][slot] = BoolVar (assigned or not)
  2. Add constraints (window, blocking, part-time, capacity, band)
  3. Set objective (minimize violations + imbalance)
  4. Solve (30s time limit)
↓
Output:
  SolverOutput {
    assignments: [
      { person_id, slot_id, source: "SOLVER" },
      ...
    ],
    cost: 47.3,
    violated_constraints: 0,
    soft_penalties: { ... }
  }
```

### Response (Store in DB)
```
← Solver returns assignments
↓
Backend stores:
  - INSERT assignment entries (person_id, slot_id, ...) 
  - UPDATE period status → GENERATED
  - LOG audit_log entry: actor=planner, action=GENERATE_ROSTER
↓
Response to Planner:
  {
    success: true,
    data: {
      assignments_created: 245,
      cost: 47.3,
      violations: 0,
      time_seconds: 8
    }
  }
```

## Key Algorithms

### Window Rule Enforcement
```python
# For each person, at most one assignment per window_weeks window
# Window is: person assigned to week W → blocked W-k, W+k where k = window_weeks/2

for person in persons:
    for start_week in range(1, 53):
        window_vars = [
            x[person][slot] 
            for slot in slots 
            if start_week <= slot.iso_week < start_week + window_weeks
        ]
        solver.Add(sum(window_vars) <= 1)
```

### Part-time Pattern Expansion
```python
# Transform pattern into forced assignments
def get_pattern_slots(person, pattern):
    # pattern.weekdag = "MA" (0), ..., "ZO" (6)
    # pattern.frequentie = ELKE_WEEK | EVEN_WEKEN | ONEVEN_WEKEN
    
    matching_slots = []
    for slot in slots:
        if slot.datum.weekday() != pattern.weekdag:
            continue
        if pattern.frequentie == "ELKE_WEEK":
            matching_slots.append(slot)
        elif pattern.frequentie == "EVEN_WEKEN":
            if slot.iso_week % 2 == 0:
                matching_slots.append(slot)
        elif pattern.frequentie == "ONEVEN_WEKEN":
            if slot.iso_week % 2 == 1:
                matching_slots.append(slot)
    
    # Constraints: must assign exactly one per week (or two-week cycle)
    return matching_slots
```

### Band Calculation
```python
def get_person_band(person_id, counter, ledger_sum):
    # Base band from rules
    base_band = rules.band[counter]  # e.g., [7, 8]
    
    # Adjust for balance
    actual_band = [base_band[0] + ledger_sum, base_band[1] + ledger_sum]
    
    # Constraint: sum of assignments per counter per person in range
    counter_assignments = sum([
        x[person_id][slot] 
        for slot in slots 
        if slot.shift_type.teller == counter
    ])
    solver.Add(counter_assignments >= actual_band[0])
    solver.Add(counter_assignments <= actual_band[1])
```

## Testing Strategy

### Unit Tests (Python)
1. **Constraint tests**: Verify each constraint builds correctly
2. **Model tests**: Small 2-person, 2-slot problems with known solutions
3. **Objective tests**: Verify cost calculation

### Integration Tests
1. **Small problem**: 3 people, 10 slots, known optimal solution
2. **Real data**: Run solver on seeded Phase 1 data (30 people, 245 slots)
3. **Regression**: Same input always produces same assignment count

### E2E Tests (Playwright)
1. Open planner dashboard
2. Click "Generate Roster"
3. Wait for solver to complete
4. Verify assignments show in roster view
5. Check balance updates correctly

## Rollback & Manual Override

If solver produces suboptimal solution:
1. **Regenerate**: Click "Generate Roster" again (re-seeds solver)
2. **Manual fix**: Planner can manually edit `assignment` entries
3. **Restore**: Revert to previous version via audit log

No automatic rollback; planner confirms quality before publishing.

## Timeline & Dependencies

**Depends on:** Phase 1 complete (slots, preferences, rules stored)

**Build order:**
1. Solver infrastructure (docker, FastAPI) - 2 days
2. Data models & constraints - 3 days
3. Objective function & solver execution - 2 days
4. Backend integration - 1 day
5. UI & testing - 3 days

**Total: ~2 weeks**

## Deliverables

- ✅ Solver service running in docker-compose
- ✅ API endpoint: `POST /api/planner/period/[id]/generate-roster`
- ✅ Planner UI button + progress + diagnostics
- ✅ 245 assignment entries in DB per period
- ✅ E2E tests verifying full generation flow
- ✅ Documentation on constraint design & solver configuration

## Future Enhancements

1. **Manual override UI** - Drag-drop assignment editor
2. **What-if scenarios** - Re-solve with modified constraints
3. **Solver configuration UI** - Adjust time limit, objective weights
4. **Performance metrics** - Track cost over multiple solves
5. **Fairness audit** - Analyze why certain assignments were made

---

**Phase 2 Status: PLANNING**
Ready to begin implementation.

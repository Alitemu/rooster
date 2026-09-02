"""
Solver rule tests.

Convention (CLAUDE.md): one hard rule = one test that proves it cannot be
broken - not an example of correct output, but proof of enforcement.

Run: pytest solver/ -v      (deps: pip install -r solver/requirements-dev.txt)
"""

import math
import pytest
from solver import RosterSolver


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def make_slots(num_weeks, teller='AVOND', per_week=1):
    """One slot per ISO week, weeks 1..num_weeks."""
    slots = []
    for w in range(1, num_weeks + 1):
        for i in range(per_week):
            slots.append({
                'id': f'slot-w{w}-{i}',
                'datum': f'2027-{((w - 1) // 4) + 1:02d}-{((w - 1) % 4) * 7 + 1:02d}',
                'iso_jaar': 2027,
                'iso_week': w,
                'shift_type_id': 'st-1',
                'shift_type_name': teller,
                'benodigd_aantal_personen': 1,
                'is_feestdag': False,
                'feestdag_groep': None,
            })
    return slots


def solve(people, slots, window_weeks=2, band=None, blocked=None, soft=None, balances=None, preferred=None):
    """Run the full pipeline with wide-open bands unless told otherwise."""
    wide = [0, len(slots)]
    band_ranges = band or {'AVOND': wide, 'WEEKEND': wide, 'FEESTDAG': wide}
    return RosterSolver(time_limit_seconds=10).generate_roster(
        period_id='test',
        people=people,
        slots=slots,
        blocked_slots=blocked or set(),
        soft_slots=soft or {},
        band_ranges=band_ranges,
        balances=balances or {p: {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0} for p in people},
        window_weeks=window_weeks,
        preferred_slots=preferred or {},
    )


def weeks_by_person(result, slots):
    """person_id -> sorted list of ISO weeks they were assigned."""
    week_of = {s['id']: s['iso_week'] for s in slots}
    out = {}
    for a in result['assignments']:
        out.setdefault(a['person_id'], []).append(week_of[a['slot_id']])
    return {p: sorted(w) for p, w in out.items()}


# ---------------------------------------------------------------------------
# HARD RULE: window rule
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('window_weeks', [2, 3, 4, 5, 7])
def test_window_rule_enforces_configured_gap(window_weeks):
    """
    CLAUDE.md defines windowWeeks as "Number of weeks between shifts".

    So two shifts for the same person must be at least windowWeeks apart -
    for windowWeeks=2 that reproduces the documented example exactly: a
    shift in week 12 means no shift in weeks 11 or 13.
    """
    slots = make_slots(21)
    result = solve(['p1'], slots, window_weeks=window_weeks)

    weeks = weeks_by_person(result, slots).get('p1', [])
    gaps = [b - a for a, b in zip(weeks, weeks[1:])]

    assert all(g >= window_weeks for g in gaps), (
        f'windowWeeks={window_weeks}: assigned weeks {weeks} contain a gap '
        f'smaller than {window_weeks} (gaps={gaps})'
    )


def test_window_rule_matches_documented_example():
    """CLAUDE.md: 'person with shift in week 12 has no shift in weeks 11, 13'."""
    slots = make_slots(21)
    result = solve(['p1'], slots, window_weeks=2)
    weeks = set(weeks_by_person(result, slots).get('p1', []))

    for w in weeks:
        assert w - 1 not in weeks and w + 1 not in weeks, (
            f'week {w} has a neighbouring assignment; weeks={sorted(weeks)}'
        )


@pytest.mark.parametrize('window_weeks', [2, 3, 4, 5, 7])
def test_solver_can_deliver_what_the_capacity_check_promises(window_weeks):
    """
    lib/capacity.ts tells the planner, before generation, that each person
    can take floor(weeks / windowWeeks) shifts, and uses that to decide
    whether the pool is big enough. If the solver's window rule is stricter
    than that, the capacity screen green-lights periods the solver then
    cannot actually staff - which shows up as unexplained gaps in the
    finished roster.

    This is the regression that a symmetric [w-k, w+k] window caused: it
    spans 2k+1 weeks, so it silently enforced a much larger gap than
    configured (windowWeeks=2 behaved like a 3-week gap).
    """
    num_weeks = 21
    slots = make_slots(num_weeks)
    result = solve(['p1'], slots, window_weeks=window_weeks)

    assigned = len(weeks_by_person(result, slots).get('p1', []))
    promised = math.floor(num_weeks / window_weeks)

    assert assigned >= promised, (
        f'windowWeeks={window_weeks}: capacity check promises {promised} shifts '
        f'per person but the solver could only place {assigned}'
    )


# ---------------------------------------------------------------------------
# HARD RULE: ABSOLUUT blocking
# ---------------------------------------------------------------------------

def test_absoluut_block_is_never_violated_even_under_scarcity():
    """
    Capacity is soft, so the solver is under pressure to fill every slot.
    It must still never place someone on a slot they hard-blocked - it
    should leave the slot open instead.
    """
    slots = make_slots(6)
    # One person, every slot blocked: the only way to "fill" anything is to
    # violate a block. Correct behaviour is to assign nothing.
    blocked = {('p1', s['id']) for s in slots}
    result = solve(['p1'], slots, window_weeks=1, blocked=blocked)

    assert result['success']
    assert result['assignments'] == [], 'solver violated an ABSOLUUT block'
    assert len(result['diagnostics']['unfilled_slots']) == 6


# ---------------------------------------------------------------------------
# SOFT capacity: partial rosters instead of all-or-nothing
# ---------------------------------------------------------------------------

def test_understaffed_period_returns_partial_roster_not_nothing():
    """
    The whole point of making capacity soft: when there genuinely aren't
    enough people, a planner needs a best-effort roster plus a list of
    gaps to fill by hand - not zero assignments.
    """
    slots = make_slots(10)
    # windowWeeks=5 means one person covers at most 2 of these 10 weeks.
    result = solve(['p1'], slots, window_weeks=5)

    assert result['success'], 'solver should still succeed when short-staffed'
    assigned = len(result['assignments'])
    unfilled = len(result['diagnostics']['unfilled_slots'])

    assert assigned > 0, 'expected a partial roster, got nothing'
    assert unfilled > 0, 'expected reported gaps'
    assert assigned + unfilled == len(slots)


def test_shortfall_is_preferred_over_breaking_a_hard_rule():
    """Leaving a slot open must cost less than violating the window rule."""
    slots = make_slots(4)
    result = solve(['p1'], slots, window_weeks=4)

    weeks = weeks_by_person(result, slots).get('p1', [])
    assert len(weeks) == 1, f'expected exactly 1 shift with a 4-week gap over 4 weeks, got {weeks}'
    assert len(result['diagnostics']['unfilled_slots']) == 3


# ---------------------------------------------------------------------------
# SOFT band: prefer stretching a band over leaving a shift uncovered
# ---------------------------------------------------------------------------

def test_band_is_stretched_rather_than_leaving_a_slot_empty():
    """
    Band limits are soft. If honouring everyone's band would leave a shift
    uncovered, the solver should exceed a band instead - that mirrors what
    a planner does by hand.
    """
    slots = make_slots(3)
    # Band caps everyone at 1, but there are 3 slots and 1 person.
    result = solve(['p1'], slots, window_weeks=1, band={'AVOND': [0, 1], 'WEEKEND': [0, 1], 'FEESTDAG': [0, 1]})

    assigned = len(result['assignments'])
    assert assigned == 3, (
        f'expected the band to stretch to cover all 3 slots, got {assigned} '
        f'assigned and {len(result["diagnostics"]["unfilled_slots"])} unfilled'
    )


# ---------------------------------------------------------------------------
# FAIRNESS: band imbalance objective
# ---------------------------------------------------------------------------

def test_workload_is_balanced_across_people():
    """
    The band-imbalance objective pulls each person's count toward the
    middle of their band. With 6 slots, 3 interchangeable people and a
    band of [1,3] (middle = 2), an even 2/2/2 split is reachable and
    nobody should end up carrying triple someone else's load.

    The band is deliberately [1,3] rather than a wide-open range: 1, 2 and
    3 shifts all sit *inside* the band, so the soft band-slack term scores
    every split identically and this test isolates the imbalance objective
    itself. (A wide band such as [0,6] would put the middle at 3, which is
    unreachable when only 6 shifts exist for 3 people - every split then
    costs the same and the objective genuinely cannot choose.)
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3']
    band = {'AVOND': [1, 3], 'WEEKEND': [1, 3], 'FEESTDAG': [1, 3]}
    result = solve(people, slots, window_weeks=2, band=band)

    counts = {p: 0 for p in people}
    for a in result['assignments']:
        counts[a['person_id']] += 1

    spread = max(counts.values()) - min(counts.values())
    assert spread <= 1, f'workload is lopsided: {counts}'


# ---------------------------------------------------------------------------
# PREFERENCE: VOORKEUR reward
# ---------------------------------------------------------------------------

def test_preference_is_honoured_when_choice_is_otherwise_tied():
    """
    A VOORKEUR preference is soft, like band imbalance - this doesn't prove
    it's always honoured, just that it shapes the outcome when the choice
    would otherwise be a tie.

    One slot, two interchangeable people (same empty balance, same wide
    band): whichever of them gets the shift costs the same on every other
    objective term (band imbalance is symmetric here - exactly one person
    ends up with 1 assignment either way). The only thing that can break
    the tie is p1's stated preference for this slot, so the solver should
    reliably choose p1.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    preferred = {('p1', slots[0]['id']): 1.0}
    result = solve(people, slots, window_weeks=1, preferred=preferred)

    assert result['success']
    assigned = [a['person_id'] for a in result['assignments']]
    assert assigned == ['p1'], (
        f'expected the preferred person p1 to get the sole shift, got {assigned}'
    )

"""
Solver rule tests.

Convention (CLAUDE.md): one hard rule = one test that proves it cannot be
broken - not an example of correct output, but proof of enforcement.

Run: pytest solver/ -v      (deps: pip install -r solver/requirements-dev.txt)
"""

import math
from datetime import date, timedelta

import pytest
from solver import RosterSolver


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def make_slots(num_weeks, teller='AVOND', per_week=1, start_year=2027, start_week=1):
    """
    One slot per real calendar week, starting at the Monday of
    (start_year, start_week) and advancing one real week at a time.

    Real dates matter here, not just the labelled iso_week: the window
    rule constraint groups slots by calendar week derived from `datum`
    (see solver/constraints.py:_week_ordinal), so a fixture whose dates
    don't actually advance by 7 days per labelled week would silently
    test something other than what the constraint enforces. Defaulting to
    (2027, 1) keeps every existing call site within a single ISO year;
    test_window_rule_holds_across_a_year_boundary below overrides the
    start to straddle two years on purpose.
    """
    base_monday = date.fromisocalendar(start_year, start_week, 1)
    slots = []
    for w in range(num_weeks):
        d = base_monday + timedelta(weeks=w)
        iso_year, iso_week, _ = d.isocalendar()
        for i in range(per_week):
            slots.append({
                'id': f'slot-w{w + 1}-{i}',
                'datum': d.isoformat(),
                'iso_jaar': iso_year,
                'iso_week': iso_week,
                'shift_type_id': 'st-1',
                'shift_type_name': teller,
                'benodigd_aantal_personen': 1,
                'is_feestdag': False,
                'feestdag_groep': None,
            })
    return slots


def solve(people, slots, window_weeks=2, band=None, blocked=None, soft=None, balances=None,
          preferred=None, prior=None, soft_block_penalty=1.0, distribution_mode='GELIJK',
          participation_factors=None, band_deviation_penalty=None, band_deviation_multiplier=1.0,
          holiday_spread_weeks=0):
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
        prior_assignments=prior or [],
        soft_block_penalty=soft_block_penalty,
        distribution_mode=distribution_mode,
        participation_factors=participation_factors,
        band_deviation_penalty=band_deviation_penalty,
        band_deviation_multiplier=band_deviation_multiplier,
        holiday_spread_weeks=holiday_spread_weeks,
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


def test_window_rule_holds_across_a_year_boundary():
    """
    Regression: the window rule used to be checked by grouping slots on
    the raw iso_week field, which resets to 1 at every year boundary. A
    period spanning December into January could then give the same person
    two shifts one calendar week apart (week 52/53 of one year, week 1 of
    the next) without tripping the constraint at all.

    Two slots, one person, one calendar week apart, straddling the
    2026/2027 boundary. With windowWeeks=2 the person may take at most
    one of them - the other must be left unfilled, exactly like the
    same-year case in test_shortfall_is_preferred_over_breaking_a_hard_rule.
    """
    # ISO week 53 of 2026 is the last week of that year; ISO week 1 of
    # 2027 starts the very next calendar week.
    slots = make_slots(2, start_year=2026, start_week=53)
    assert slots[0]['iso_jaar'] == 2026 and slots[0]['iso_week'] == 53
    assert slots[1]['iso_jaar'] == 2027 and slots[1]['iso_week'] == 1

    result = solve(['p1'], slots, window_weeks=2)

    assert len(result['assignments']) == 1, (
        f"window rule broken across the year boundary: expected exactly 1 "
        f"assignment, got {result['assignments']}"
    )


def test_window_rule_carries_over_from_the_previous_period():
    """
    Regression: a period's solve only ever saw its own slots, so the
    window rule reset to zero knowledge at week 1 of every new period. A
    person who worked the last day of the *previous* period could be
    handed a shift on day 1 of the *new* one - a real violation the
    solver itself produced, not a manual-override edge case.

    prior_assignments carries the confirmed tail of the previous period
    (dienstrooster_prior_assignment) into this period's solve. One
    person, one slot in week 1 of a fresh period, and a prior assignment
    for that same person one calendar week earlier: with windowWeeks=2
    the slot must be left unfilled rather than handed to the only
    candidate who already worked days ago.
    """
    slots = make_slots(1, start_year=2027, start_week=2)  # a lone slot in week 2, 2027
    prior = [{'person_id': 'p1', 'datum': '2027-01-04'}]  # p1 worked week 1, 2027

    result = solve(['p1'], slots, window_weeks=2, prior=prior)

    assert result['assignments'] == [], (
        f"window rule ignored the previous period's carry-over: {result['assignments']}"
    )
    assert len(result['diagnostics']['unfilled_slots']) == 1


def test_window_rule_carry_over_respects_the_configured_gap():
    """
    The carry-over check must use the same gap as the in-period window
    rule, not something stricter or looser: a prior assignment exactly
    windowWeeks away is far enough and must not block the new slot.
    """
    slots = make_slots(1, start_year=2027, start_week=3)  # week 3, 2027
    prior = [{'person_id': 'p1', 'datum': '2027-01-04'}]  # p1 worked week 1 - 2 weeks earlier

    result = solve(['p1'], slots, window_weeks=2, prior=prior)

    assert len(result['assignments']) == 1, (
        f"carry-over blocked a gap that exactly matches windowWeeks: {result['assignments']}"
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


def test_capacity_violations_are_reported_not_always_zero():
    """
    diagnostics.violations['capacity'] used to stay at its build-time 0
    forever - the count is only known after solving, from the shortfall
    variables' solved values, which solve() never read back. A short-staffed
    period would report 0 capacity violations even with real gaps.
    """
    slots = make_slots(10)
    result = solve(['p1'], slots, window_weeks=5)

    unfilled = len(result['diagnostics']['unfilled_slots'])
    assert unfilled > 0, 'fixture must actually produce a shortfall to test against'
    assert result['diagnostics']['violations']['capacity'] == unfilled


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


def test_band_limit_violations_are_reported_not_always_zero():
    """
    diagnostics.violations['band_limit'] used to stay at its build-time 0
    forever, for the same reason as the capacity counter above - band slack
    is only known after solving. A person stretched outside their band
    should be counted, not silently reported as 0 overtredingen.
    """
    slots = make_slots(3)
    result = solve(['p1'], slots, window_weeks=1, band={'AVOND': [0, 1], 'WEEKEND': [0, 1], 'FEESTDAG': [0, 1]})

    assert len(result['assignments']) == 3
    assert result['diagnostics']['violations']['band_limit'] >= 1


def test_a_large_negative_balance_correction_does_not_make_the_whole_model_infeasible():
    """
    A large enough negative delta (e.g. a manual ledger correction) pulls a
    person's effective band maximum below zero. The `over` slack variable
    must have enough headroom to absorb that gap - otherwise the hard
    band-max constraint becomes unsatisfiable for every possible solution,
    and generation fails for the whole period over one person's balance.
    """
    slots = make_slots(1, teller='FEESTDAG')
    result = solve(
        ['p1'], slots, window_weeks=1,
        band={'AVOND': [7, 8], 'WEEKEND': [7, 8], 'FEESTDAG': [7, 8]},
        balances={'p1': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': -20}},
    )

    assert result['success'], (
        f"expected a solvable model despite the large negative delta, got "
        f"solver_status={result.get('solver_status')}"
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


# ---------------------------------------------------------------------------
# SOFT BLOCKING: LIEVER_NIET weight (softBlockPenalty)
# ---------------------------------------------------------------------------

def test_soft_block_penalty_weight_controls_whether_it_is_honoured():
    """
    softBlockPenalty (RulesetConfig) is the objective weight on LIEVER_NIET
    violations - it has to actually reach the solver's objective, not just
    sit in the ruleset JSON. This proves it does, by picking a scenario
    where honouring p1's LIEVER_NIET costs something real (band imbalance)
    and showing the outcome flips depending on the weight.

    One slot, band [1,1] on AVOND. p1's balance is untouched (actual band
    [1,1]: not getting the shift costs 1 unit of band-under slack). p2's
    balance is -1 (actual band [0,0]: getting the shift costs 1 unit of
    band-over slack). Assigning p1 costs zero band slack; assigning p2
    instead costs band slack on both (5.0 weight each = 10.0 total). p1 has
    marked the slot LIEVER_NIET, costing `soft_block_penalty * 1.0`.

    - Low penalty (1.0 < 10.0): cheaper to just take the band-optimal
      assignment and pay the small soft-block cost - p1 gets the shift.
    - High penalty (20.0 > 10.0): now cheaper to eat the band slack than
      violate p1's preference - p2 gets the shift instead.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    band = {'AVOND': [1, 1], 'WEEKEND': [1, 1], 'FEESTDAG': [1, 1]}
    balances = {
        'p1': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p2': {'AVOND': -1, 'WEEKEND': 0, 'FEESTDAG': 0},
    }
    soft = {('p1', slots[0]['id']): 1.0}

    low = solve(people, slots, window_weeks=1, band=band, balances=balances, soft=soft,
                soft_block_penalty=1.0)
    assert [a['person_id'] for a in low['assignments']] == ['p1'], (
        'at a low penalty, the band-optimal assignment should win despite the LIEVER_NIET mark'
    )

    high = solve(people, slots, window_weeks=1, band=band, balances=balances, soft=soft,
                 soft_block_penalty=20.0)
    assert [a['person_id'] for a in high['assignments']] == ['p2'], (
        'at a high penalty, avoiding the LIEVER_NIET slot should win even at the cost of band imbalance'
    )


# ---------------------------------------------------------------------------
# DISTRIBUTION MODE: NAAR_RATO band scaling by participation factor
# ---------------------------------------------------------------------------

def test_naar_rato_scales_a_part_timers_band_by_their_participation_factor():
    """
    distribution_mode='NAAR_RATO' scales each person's band by their
    pool_membership.deelnamefactor before anything else - a half-time
    person's target should be roughly half of a full-timer's, while
    'GELIJK' (the default) holds everyone to the same target regardless.

    First half - GELIJK: 6 AVOND slots, 3 people, band [2,2] (a tight
    target of 2 each - exactly enough for a 2/2/2 split). p3 has a
    participation factor of 0.5, which GELIJK must ignore.

    Second half - NAAR_RATO: same band and slots, but p1 is given a +1
    ledger balance (actual band [3,3]) so that p1=3, p2=2, p3=1 is the
    *unique* zero-cost allocation once p3's own band is scaled to [1,1] -
    every other split needs band slack or imbalance slack somewhere and
    costs strictly more. That avoids relying on how CP-SAT breaks a tie
    between two equally-cheap allocations (an earlier version of this test
    asserted an outcome that was actually a perfect tie between "p3 absorbs
    the extra shift" and "a full-timer does", and started flipping once
    unrelated model changes shifted the solver's internal tie-break).
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3']
    band = {'AVOND': [2, 2], 'WEEKEND': [2, 2], 'FEESTDAG': [2, 2]}

    def count_for(result, person):
        return sum(1 for a in result['assignments'] if a['person_id'] == person)

    gelijk = solve(people, slots, window_weeks=2, band=band, distribution_mode='GELIJK',
                    participation_factors={'p3': 0.5})
    assert count_for(gelijk, 'p3') == 2, (
        'GELIJK must ignore the participation factor - p3 should get the same target as everyone else'
    )

    balances = {
        'p1': {'AVOND': 1, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p2': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p3': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
    }
    naar_rato = solve(people, slots, window_weeks=2, band=band, balances=balances,
                       distribution_mode='NAAR_RATO', participation_factors={'p3': 0.5})
    counts = {p: count_for(naar_rato, p) for p in people}
    assert counts == {'p1': 3, 'p2': 2, 'p3': 1}, (
        f"expected the unique zero-slack split (p1=3, p2=2, p3=1 - p3's band scaled to [1,1]), got {counts}"
    )


# ---------------------------------------------------------------------------
# BAND DEVIATION: escalating, cumulative bandDeviationPenalty
# ---------------------------------------------------------------------------

def test_band_deviation_penalty_defaults_to_the_old_flat_weight():
    """
    A period whose ruleset never set bandDeviationPenalty must solve
    exactly as it did before this setting existed - band_deviation_penalty
    defaults to None, which add_band_slack_objective treats as the flat
    [5.0] tier this replaced.

    2 people, 1 slot, band [0,0] (nobody "should" take it, but leaving it
    empty costs far more - shortfall dominates). Whoever takes it ends up
    exactly 1 over their band: 1 unit of band-slack costs weight(5.0) * 1,
    plus the (unrelated, untouched-by-this-change) band-imbalance term's
    own 0.5 for being 1 off its own target of 0 - 5.5 total, exactly what
    this fixture already cost before bandDeviationPenalty existed.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    band = {'AVOND': [0, 0], 'WEEKEND': [0, 0], 'FEESTDAG': [0, 0]}
    result = solve(people, slots, window_weeks=1, band=band)

    assert result['success']
    assert len(result['assignments']) == 1
    assert result['diagnostics']['total_cost'] == 5.5


def test_band_deviation_penalty_spreads_a_shortage_instead_of_concentrating_it():
    """
    With an escalating, cumulative penalty ([10, 40, 160], ×4 beyond that),
    2 units of deviation cost 10+40=50 when concentrated on one person, but
    only 10+10=20 when spread one-each across two people - so the solver
    should never let one person absorb more than their fair share of a
    shortage when spreading it is an option.

    4 people, band [1,1] (everyone wants exactly 1), 6 slots - 2 more than
    the 4 "exact fit" targets, so 2 units of deviation are unavoidable
    somewhere. Under the old flat weight, concentrating both units on one
    person costs exactly the same as spreading them (2*5.0 either way) - a
    real tie, which is the point of this setting: it breaks that tie in
    favour of spreading.
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3', 'p4']
    band = {'AVOND': [1, 1], 'WEEKEND': [1, 1], 'FEESTDAG': [1, 1]}

    result = solve(people, slots, window_weeks=1, band=band,
                    band_deviation_penalty=[10.0, 40.0, 160.0], band_deviation_multiplier=4.0)

    assert result['success']
    counts = {}
    for a in result['assignments']:
        counts[a['person_id']] = counts.get(a['person_id'], 0) + 1

    assert max(counts.values()) <= 2, (
        f'no single person should absorb both extra shifts when spreading them is cheaper: {counts}'
    )
    over_band = sum(1 for c in counts.values() if c > 1)
    assert over_band == 2, f'the 2 extra shifts should land on 2 different people, not concentrated: {counts}'


def test_band_deviation_penalty_keeps_growing_past_the_reified_tier_cap():
    """
    add_band_slack_objective only reifies max_tiers=8 "deviation >= N"
    booleans - deviation beyond that has no boolean of its own. If nothing
    prices the gap, a deviation of 10 costs exactly the same as a deviation
    of 8, which defeats the whole point of an *escalating* penalty right
    when a badly understaffed pool needs it most.

    1 person forced to take all 8 slots of a fixed-size period (nobody
    else exists, so the huge shortfall weight always wins over any band
    cost) isolates deviation via the ledger delta alone, not headcount:
    delta=-8 makes their effective band max 0 (deviation=8); delta=-10
    makes it -2 (deviation=10). Both scenarios have identical assignment
    counts and slot counts, so the only things that can move are the
    band-slack term (this bug) and the band-imbalance term (a separate,
    already-correct term with a known fixed weight of 0.5) - both track
    the same 2-unit delta, so the total cost must rise by
    tier_cost(9)*2 + 0.5*2 = 5.0*2 + 1.0 = 11.0, not by just the
    imbalance term's 1.0 alone.
    """
    slots = make_slots(8)
    band = {'AVOND': [8, 8], 'WEEKEND': [8, 8], 'FEESTDAG': [8, 8]}

    at_tier_cap = solve(['p1'], slots, window_weeks=1, band=band,
                         balances={'p1': {'AVOND': -8, 'WEEKEND': 0, 'FEESTDAG': 0}})
    past_tier_cap = solve(['p1'], slots, window_weeks=1, band=band,
                           balances={'p1': {'AVOND': -10, 'WEEKEND': 0, 'FEESTDAG': 0}})

    assert at_tier_cap['success'] and past_tier_cap['success']
    assert len(at_tier_cap['assignments']) == 8 and len(past_tier_cap['assignments']) == 8

    delta_cost = past_tier_cap['diagnostics']['total_cost'] - at_tier_cap['diagnostics']['total_cost']
    assert delta_cost == pytest.approx(11.0), (
        f'2 extra units of deviation past the tier cap should cost 11.0 more '
        f'(10.0 band-slack + 1.0 imbalance), got {delta_cost} more - '
        f'deviation beyond max_tiers is being priced at 0'
    )


# ---------------------------------------------------------------------------
# HOLIDAY SPREAD: holidaySpreadWithinPeriod - independent of window_weeks
# ---------------------------------------------------------------------------

def test_holiday_spread_blocks_two_feestdag_shifts_even_when_window_weeks_is_off():
    """
    holidaySpreadWithinPeriod is a hard, FEESTDAG-only rule that has to
    hold even when the general window rule doesn't - window_weeks=0 is a
    valid planner choice ("no minimum gap at all") that switches the window
    rule off entirely, and this must not quietly ride along with it.

    Only p1 exists, two FEESTDAG slots 2 weeks apart, holiday_spread_weeks
    set to 4 (a stricter gap than the 2 weeks between them). Since the only
    person available can't legally take both, one has to stay unfilled -
    a wide-open band and window_weeks=0 mean nothing else stops the solver
    from double-booking p1 except this rule.
    """
    feestdagen = make_slots(3, teller='FEESTDAG')
    two_weeks_apart = [feestdagen[0], feestdagen[2]]  # week 1 and week 3

    result = solve(['p1'], two_weeks_apart, window_weeks=0, holiday_spread_weeks=4)

    assert len(result['assignments']) == 1, (
        f"p1 should be blocked from taking both FEESTDAG slots, got {result['assignments']}"
    )


def test_holiday_spread_off_by_default_leaves_window_weeks_zero_unaffected():
    """
    The flip side of the above: with holiday_spread_weeks left at its
    default (0, unconfigured), window_weeks=0 really does mean no gap
    requirement at all, FEESTDAG included - this is a new, opt-in rule
    that must never activate itself.
    """
    feestdagen = make_slots(3, teller='FEESTDAG')
    two_weeks_apart = [feestdagen[0], feestdagen[2]]

    result = solve(['p1'], two_weeks_apart, window_weeks=0)  # holiday_spread_weeks defaults to 0

    assert len(result['assignments']) == 2, (
        f'with no holiday spread configured, p1 should be able to take both: {result["assignments"]}'
    )


def test_holiday_spread_only_constrains_feestdag_pairs():
    """
    The rule is FEESTDAG-specific - it must not block a FEESTDAG shift
    sitting close to an AVOND shift for the same person, only two FEESTDAG
    shifts close to each other.
    """
    # Built by hand rather than two separate make_slots() calls: each call
    # numbers its slot ids from its own w=0, so two 1-week calls would both
    # produce 'slot-w1-0' and collide in assignment_vars.
    base = make_slots(2, teller='AVOND')
    avond, feestdag = base[0], dict(base[1], id='feestdag-w2-0', shift_type_name='FEESTDAG')

    result = solve(['p1'], [avond, feestdag], window_weeks=0, holiday_spread_weeks=10)

    assert len(result['assignments']) == 2, (
        f'an AVOND + FEESTDAG pair should never be blocked by holiday spread: {result["assignments"]}'
    )

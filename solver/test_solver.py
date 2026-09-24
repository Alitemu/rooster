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
          preferred=None, prior=None, manual=None, soft_block_penalty=1.0, distribution_mode='GELIJK',
          participation_factors=None, coverage=None, band_deviation_penalty=None, band_deviation_multiplier=1.0,
          holiday_spread_weeks=0, shortfall_weight=1000.0, band_imbalance_weight=0.5,
          preference_reward_weight=0.3, objective_mode='weighted', random_seed=None,
          window_weeks_avond=None, window_weeks_weekend_feestdag=None, band_overrides=None):
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
        manual_assignments=manual or [],
        soft_block_penalty=soft_block_penalty,
        distribution_mode=distribution_mode,
        participation_factors=participation_factors,
        coverage_factors=coverage,
        band_deviation_penalty=band_deviation_penalty,
        band_deviation_multiplier=band_deviation_multiplier,
        holiday_spread_weeks=holiday_spread_weeks,
        shortfall_weight=shortfall_weight,
        band_imbalance_weight=band_imbalance_weight,
        preference_reward_weight=preference_reward_weight,
        objective_mode=objective_mode,
        random_seed=random_seed,
        window_weeks_avond=window_weeks_avond,
        window_weeks_weekend_feestdag=window_weeks_weekend_feestdag,
        band_overrides=band_overrides,
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
# BAND MAX: soft up to MAX_BAND_OVERSHOOT, a hard ceiling past that
# ---------------------------------------------------------------------------

def test_band_max_is_never_exceeded_even_if_a_slot_stays_unfilled():
    """
    Band limits are soft, but asymmetrically: falling short of the minimum
    is cheaper than an unfilled slot (so the solver still prefers assigning
    someone under-target over leaving a shift empty), while exceeding the
    maximum is priced *more* than an unfilled slot - "eerlijk verdelen,
    koste wat kost": nobody is pushed past their streefwaarde just to
    cover a shift.

    1 person, band capped at 1, but 3 slots on offer. Taking only 1 (the
    band max) costs 1 unfilled slot (1000) plus a small imbalance cost;
    taking all 3 would cost 2 units of over-band slack, each priced above
    1000 on its own - strictly worse. So the solver must stop at exactly 1
    and leave the other 2 unfilled, the reverse of what used to be
    "correct" here.
    """
    slots = make_slots(3)
    result = solve(['p1'], slots, window_weeks=1, band={'AVOND': [0, 1], 'WEEKEND': [0, 1], 'FEESTDAG': [0, 1]})

    assigned = len(result['assignments'])
    assert assigned == 1, (
        f'expected the solver to stop at the band max (1) and leave the rest unfilled, '
        f'got {assigned} assigned and {len(result["diagnostics"]["unfilled_slots"])} unfilled'
    )
    assert len(result['diagnostics']['unfilled_slots']) == 2
    assert result['diagnostics']['violations']['band_limit'] == 0, (
        'taking exactly the band max should trigger no band violation at all'
    )


def test_band_max_overshoot_is_hard_capped_even_under_dekking_priority():
    """
    Phase 1 (dekking) has no notion of band cost at all - it only
    minimizes unfilled slots, so under an unbounded `over` slack it would
    push a single available person as far past their band max as needed
    to cover every last shift, no matter how far over that left them
    (exactly the scenario a planner-promised korting must never suffer -
    see constraints.add_band_constraints' docstring). MAX_BAND_OVERSHOOT=0
    makes even a single unit past the max a hard ceiling, applying even
    under 'lexicographic' where dekking would otherwise always win:
    1 person, band max 1, 3 slots on offer - dekking can fill at most 1
    (exactly the band max, zero overshoot allowed), never more.
    """
    slots = make_slots(3)
    result = solve(
        ['p1'], slots, window_weeks=1,
        band={'AVOND': [0, 1], 'WEEKEND': [0, 1], 'FEESTDAG': [0, 1]},
        objective_mode='lexicographic',
    )

    assert result['success']
    assigned = len(result['assignments'])
    assert assigned == 1, (
        f'expected dekking to stop at exactly the band max (1) even though it could otherwise '
        f'cover more slots by pushing p1 over, got {assigned} assigned'
    )
    assert len(result['diagnostics']['unfilled_slots']) == 2
    assert result['diagnostics']['max_band_deviation'] == 0, (
        'nobody should ever be pushed past their band max now - MAX_BAND_OVERSHOOT is 0'
    )


def test_band_limit_violations_are_reported_not_always_zero():
    """
    diagnostics.violations['band_limit'] used to stay at its build-time 0
    forever, for the same reason as the capacity counter above - band slack
    is only known after solving. Someone left under their band minimum
    should be counted, not silently reported as 0 overtredingen.

    1 person, only 1 slot on offer, but a minimum of 5 - taking the single
    available slot is still strictly cheaper than leaving it unfilled too
    (1 unfilled costs 1000; under-band slack costs a few units at most), so
    the solver takes it and ends up 4 short of its own minimum.
    """
    slots = make_slots(1)
    result = solve(['p1'], slots, window_weeks=1, band={'AVOND': [5, 5], 'WEEKEND': [5, 5], 'FEESTDAG': [5, 5]})

    assert len(result['assignments']) == 1
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

    Bands are shared per counter across everyone (only a ledger delta can
    shift a specific person's own actual window), so the two people here
    are told apart by balance, not by different bands - and deliberately
    kept so *neither* option ever exceeds anyone's band max: exceeding a
    max now costs more than leaving the slot unfilled outright (see the
    asymmetric-pricing tests above), which would swamp this comparison and
    make the slot go unfilled instead of flipping between p1/p2.

    Shared band [0,1] (matches the 1 available slot). p1 has a +1 AVOND
    balance, shifting their own actual window to [1,2] (target middle 1 -
    assigning them hits it exactly, costing 0 imbalance; leaving them idle
    costs 1 unit of the ordinary, cheap band-*under* tier, not the
    over-band floor - they're never above their own max=2). p2's balance
    is untouched (window stays [0,1], target middle 0).

    - Assign p1 (p2 idle): 0 (p1 imbalance, dead on target) + 0 (p2 idle,
      dead on their own target of 0) + soft_block_penalty*1.0 (p1's
      LIEVER_NIET) = just the penalty.
    - Assign p2 (p1 idle): 5.0 (p1's band-under, cheap tier) + 0.5 (p1
      imbalance) + 0.5 (p2 imbalance) = 6.0 flat, no LIEVER_NIET cost.

    - Low penalty (1.0 < 6.0): cheaper to just assign p1 and pay the small
      soft-block cost.
    - High penalty (20.0 > 6.0): now cheaper to assign p2 instead and
      avoid the LIEVER_NIET slot entirely.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    band = {'AVOND': [0, 1], 'WEEKEND': [0, 1], 'FEESTDAG': [0, 1]}
    balances = {
        'p1': {'AVOND': 1, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p2': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
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
# CONFIGURABLE WEIGHTS: shortfall_weight, band_imbalance_weight,
# preference_reward_weight actually reach the objective
# ---------------------------------------------------------------------------

def test_shortfall_weight_controls_whether_an_unfilled_slot_beats_a_disliked_one():
    """
    shortfall_weight (RulesetConfig) is the objective weight on a
    completely unfilled slot - it has to actually reach the solver's
    objective when a planner configures it, not just sit in the ruleset
    JSON as the hardcoded 1000.0 it used to always be.

    One slot, one person, marked LIEVER_NIET by that same person
    (soft_block_penalty fixed at 10.0). Assigning them costs 10.0 (soft
    block) + 0.5 (band imbalance, the default weight - see the wide
    default band's own middle of 0) = 10.5 total. Leaving it unfilled
    costs exactly shortfall_weight.

    - High shortfall_weight (1000.0, the default): 10.5 < 1000 - cheaper
      to assign despite the LIEVER_NIET mark.
    - Low shortfall_weight (5.0): 10.5 > 5.0 - now cheaper to leave the
      slot unfilled than to honour it against the person's own wishes.
    """
    slots = make_slots(1)
    soft = {('p1', slots[0]['id']): 1.0}

    high = solve(['p1'], slots, window_weeks=1, soft=soft, soft_block_penalty=10.0,
                 shortfall_weight=1000.0)
    assert len(high['assignments']) == 1, (
        'at a high shortfall_weight, filling the slot should win despite the LIEVER_NIET mark'
    )

    low = solve(['p1'], slots, window_weeks=1, soft=soft, soft_block_penalty=10.0,
                shortfall_weight=5.0)
    assert len(low['assignments']) == 0, (
        'at a low shortfall_weight, leaving the slot unfilled should win over honouring it against a preference'
    )
    assert len(low['diagnostics']['unfilled_slots']) == 1


def test_band_imbalance_weight_controls_whether_fairness_beats_a_preference():
    """
    band_imbalance_weight (RulesetConfig) is the pull-toward-the-band-
    middle weight - it has to actually reach the solver's objective when
    configured, not just sit in the ruleset JSON as the hardcoded 0.5 it
    used to always be.

    2 people, 2 slots, wide band [0,2] (mid=1 - a 1/1 split costs 0
    imbalance). p1 has a VOORKEUR mark on *both* slots, worth
    preference_reward_weight each. Taking both slots (2/0, imbalance
    deviation of 1 on each side = 2 units) earns p1 twice the reward
    instead of once, but costs 2 * band_imbalance_weight in fairness:

    - High band_imbalance_weight (0.5, the default): 2*0.5=1.0 > the
      extra 1*preference_reward_weight(0.3) gained by grabbing the second
      slot - the fair 1/1 split wins.
    - Low band_imbalance_weight (0.05): 2*0.05=0.1 < 0.3 - now cheaper to
      let p1 take both and sacrifice the even split.
    """
    slots = make_slots(2)
    people = ['p1', 'p2']
    band = {'AVOND': [0, 2], 'WEEKEND': [0, 2], 'FEESTDAG': [0, 2]}
    preferred = {('p1', slots[0]['id']): 1.0, ('p1', slots[1]['id']): 1.0}

    def count_for(result, person):
        return sum(1 for a in result['assignments'] if a['person_id'] == person)

    fair = solve(people, slots, window_weeks=1, band=band, preferred=preferred,
                 band_imbalance_weight=0.5)
    assert count_for(fair, 'p1') == 1 and count_for(fair, 'p2') == 1, (
        f"at a high band_imbalance_weight, the even split should win despite p1's double preference: "
        f"{[a['person_id'] for a in fair['assignments']]}"
    )

    unfair = solve(people, slots, window_weeks=1, band=band, preferred=preferred,
                   band_imbalance_weight=0.05)
    assert count_for(unfair, 'p1') == 2 and count_for(unfair, 'p2') == 0, (
        f"at a low band_imbalance_weight, honouring both of p1's preferences should win over the even split: "
        f"{[a['person_id'] for a in unfair['assignments']]}"
    )


def test_preference_reward_weight_controls_whether_a_preference_beats_fairness():
    """
    preference_reward_weight (RulesetConfig) is the VOORKEUR reward - it
    has to actually reach the solver's objective when configured, not
    just sit in the ruleset JSON as the hardcoded 0.3 it used to always
    be. Mirrors the band_imbalance_weight test above exactly, sweeping
    the other side of the same trade-off (band_imbalance_weight fixed at
    its default 0.5, so grabbing both preferred slots costs 2*0.5=1.0 in
    fairness):

    - Low preference_reward_weight (0.3, the default): 1*0.3=0.3 < the
      1.0 fairness cost of grabbing the second slot - the even split wins.
    - High preference_reward_weight (2.0): 1*2.0=2.0 > 1.0 - now cheaper
      to let p1 take both and sacrifice the even split.
    """
    slots = make_slots(2)
    people = ['p1', 'p2']
    band = {'AVOND': [0, 2], 'WEEKEND': [0, 2], 'FEESTDAG': [0, 2]}
    preferred = {('p1', slots[0]['id']): 1.0, ('p1', slots[1]['id']): 1.0}

    def count_for(result, person):
        return sum(1 for a in result['assignments'] if a['person_id'] == person)

    fair = solve(people, slots, window_weeks=1, band=band, preferred=preferred,
                 preference_reward_weight=0.3)
    assert count_for(fair, 'p1') == 1 and count_for(fair, 'p2') == 1, (
        f"at a low preference_reward_weight, the even split should win despite p1's double preference: "
        f"{[a['person_id'] for a in fair['assignments']]}"
    )

    unfair = solve(people, slots, window_weeks=1, band=band, preferred=preferred,
                   preference_reward_weight=2.0)
    assert count_for(unfair, 'p1') == 2 and count_for(unfair, 'p2') == 0, (
        f"at a high preference_reward_weight, honouring both of p1's preferences should win over the even split: "
        f"{[a['person_id'] for a in unfair['assignments']]}"
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


def test_naar_rato_scaling_keeps_band_width_at_least_one():
    """
    Rounding both bounds the same way can collapse a part-timer's scaled
    band to width 0 (factor=0.5 on [7,8]: round(3.5)=4, round(4.0)=4 ->
    [4,4]) while a full-timer keeps width 2 - a systematic, non-
    proportional penalty against part-timers, who'd then pay band-slack
    cost for the ordinary variation a full-timer gets for free.
    floor(min)/ceil(max) keeps width >=1: factor=0.5 on [7,8] ->
    floor(3.5)=3, ceil(4.0)=4 -> [3,4].

    Only p1 exists with 3 AVOND slots on offer - all 3 must fit inside the
    scaled [3,4] band with zero band-slack.
    """
    slots = make_slots(3)
    band = {'AVOND': [7, 8], 'WEEKEND': [7, 8], 'FEESTDAG': [7, 8]}

    result = solve(['p1'], slots, window_weeks=0, band=band,
                    distribution_mode='NAAR_RATO', participation_factors={'p1': 0.5})

    assert len(result['assignments']) == 3, (
        f"p1 should take all 3 available slots (inside the scaled [3,4] band): {result['assignments']}"
    )
    assert result['diagnostics']['violations'].get('band_limit', 0) == 0, (
        f"3 shifts should fit inside p1's scaled band [3,4] with no band-slack: {result['diagnostics']}"
    )


# ---------------------------------------------------------------------------
# COVERAGE FACTOR: automatic band scaling for mid-period joiners/leavers
# ---------------------------------------------------------------------------

def test_coverage_factor_scales_the_band_even_under_gelijk():
    """
    Unlike participation_factors (only consulted under NAAR_RATO),
    coverage_factors must scale the band unconditionally - someone whose
    pool membership only covers part of the period is a structural fact,
    not a fairness policy choice, so even 'GELIJK' (the default
    distribution_mode) must apply it.

    Same fixture and reasoning as
    test_naar_rato_scales_a_part_timers_band_by_their_participation_factor:
    6 AVOND slots, 3 people, band [2,2]. p3's coverage_factor of 0.5 scales
    their band to [1,1]. p1 is given a +1 ledger balance (actual band
    [3,3]) so that p1=3, p2=2, p3=1 is the *unique* zero-cost allocation -
    every other split needs band slack or imbalance slack somewhere and
    costs strictly more.
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3']
    band = {'AVOND': [2, 2], 'WEEKEND': [2, 2], 'FEESTDAG': [2, 2]}

    def count_for(result, person):
        return sum(1 for a in result['assignments'] if a['person_id'] == person)

    balances = {
        'p1': {'AVOND': 1, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p2': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p3': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
    }
    result = solve(people, slots, window_weeks=2, band=band, balances=balances,
                   coverage=({'p3': 0.5}))
    counts = {p: count_for(result, p) for p in people}
    assert counts == {'p1': 3, 'p2': 2, 'p3': 1}, (
        f"expected the unique zero-slack split (p1=3, p2=2, p3=1 - p3's band scaled to [1,1]) "
        f"under the default GELIJK mode, got {counts}"
    )


def test_coverage_factor_of_one_is_a_no_op():
    """
    Regression guard: a coverage_factor of 1.0 (full presence, the common
    case for anyone whose membership already spans the whole period) must
    produce an identical outcome to sending no coverage_factors entry at
    all - whatever that baseline outcome is (band [7,8] against only 3
    available slots is deliberately understaffed here, so both runs are
    expected to show the *same* band_limit violation - the point isn't
    that it's zero, it's that 1.0 changes nothing about it).
    """
    slots = make_slots(3)
    band = {'AVOND': [7, 8], 'WEEKEND': [7, 8], 'FEESTDAG': [7, 8]}

    baseline = solve(['p1'], slots, window_weeks=0, band=band)
    with_factor = solve(['p1'], slots, window_weeks=0, band=band, coverage={'p1': 1.0})

    assert len(with_factor['assignments']) == len(baseline['assignments']) == 3, (
        f"a 1.0 coverage factor must not change how many slots p1 takes: "
        f"baseline={baseline['assignments']}, with_factor={with_factor['assignments']}"
    )
    assert (
        with_factor['diagnostics']['violations'].get('band_limit', 0)
        == baseline['diagnostics']['violations'].get('band_limit', 0)
    ), (
        f"a 1.0 coverage factor must not change band_limit violations: "
        f"baseline={baseline['diagnostics']}, with_factor={with_factor['diagnostics']}"
    )


def test_coverage_factor_and_naar_rato_participation_factor_combine_multiplicatively():
    """
    A person can be both a manually-set part-timer (deelnamefactor, only
    applied under NAAR_RATO) AND a mid-period joiner (coverage_factor,
    always applied) at the same time - the two must multiply, not
    override each other. constraints.add_band_constraints applies
    coverage first, then NAAR_RATO's participation_factors on top of the
    already-scaled band.

    p1: full-time, full coverage - band stays [4,4].
    p2: deelnamefactor 0.5 AND coverage_factor 0.5 - band [4,4] -> coverage
        scales to [2,2] -> participation scales that to [1,1] (a quarter
        of the base, not a half).

    5 AVOND slots total = exactly p1's target (4) + p2's target (1), so
    the zero-slack split (p1=4, p2=1) is the unique cheapest solution -
    any other split must cost band slack on a tight width-1 band.
    """
    slots = make_slots(5)
    people = ['p1', 'p2']
    band = {'AVOND': [4, 4], 'WEEKEND': [4, 4], 'FEESTDAG': [4, 4]}

    def count_for(result, person):
        return sum(1 for a in result['assignments'] if a['person_id'] == person)

    result = solve(people, slots, window_weeks=0, band=band,
                    distribution_mode='NAAR_RATO',
                    participation_factors={'p2': 0.5},
                    coverage={'p2': 0.5})
    counts = {p: count_for(result, p) for p in people}
    assert counts == {'p1': 4, 'p2': 1}, (
        f"expected p2's band to be scaled by coverage (0.5) and participation (0.5) "
        f"multiplicatively to a quarter of the base [4,4] -> [1,1], got {counts}"
    )
    assert result['diagnostics']['violations'].get('band_limit', 0) == 0, (
        f"the 4/1 split exactly matches both scaled bands with zero slack: {result['diagnostics']}"
    )


# ---------------------------------------------------------------------------
# BAND DEVIATION: escalating, cumulative bandDeviationPenalty
# ---------------------------------------------------------------------------

def test_over_band_max_always_costs_more_than_an_unfilled_slot_by_default():
    """
    A period whose ruleset never set bandDeviationPenalty still gets the
    unconditional shortfall_weight floor on `over` - that guarantee isn't
    itself something a planner's tiers can opt out of by leaving them
    unset. band_deviation_penalty defaults to None, treated as the flat
    [5.0] tier; add_band_slack_objective prices the first unit of `over`
    at shortfall_weight(1000) + 5.0 = 1005.0 regardless.

    2 people, 1 slot, band [0,0] (nobody "should" take it). Leaving it
    unfilled costs exactly shortfall_weight (1000.0, no band or imbalance
    cost - both people already sit exactly on their band). Assigning it to
    either person would cost 1005.0 (over) + 0.5 (imbalance) = 1005.5 -
    strictly more. So the cheaper, and therefore correct, answer is to
    leave it unfilled.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    band = {'AVOND': [0, 0], 'WEEKEND': [0, 0], 'FEESTDAG': [0, 0]}
    result = solve(people, slots, window_weeks=1, band=band)

    assert result['success']
    assert len(result['assignments']) == 0
    assert len(result['diagnostics']['unfilled_slots']) == 1
    assert result['diagnostics']['total_cost'] == 1000.0


def test_band_deviation_penalty_spreads_a_shortage_instead_of_concentrating_it():
    """
    With an escalating, cumulative penalty ([10, 40, 160], ×4 beyond that),
    2 units of deviation cost 10+40=50 when concentrated on one person, but
    only 10+10=20 when spread one-each across two people - so the solver
    should never let one person absorb more than their fair share of a
    shortage when spreading it is an option.

    This has to be a *shortage below the minimum* (`under`), not an excess
    above the maximum: since exceeding anyone's band max now always costs
    more than an unfilled slot (see the over-vs-shortfall test above), a
    surplus-of-slots scenario would just leave the surplus unfilled
    instead of ever distributing it - it wouldn't exercise this tiering at
    all. Falling short of the minimum is unaffected by that change (there
    is no "leave it unfilled instead" alternative that helps someone reach
    their own minimum), so it still isolates the escalating-tier behaviour
    exactly as before.

    4 people, band [2,2] (everyone wants exactly 2 -> demand 8), but only 6
    slots - 2 short of that demand, so 2 units of under-band deviation are
    unavoidable somewhere (leaving any of the 6 slots unfilled instead
    would only add shortfall cost on top, never help). Concentrating both
    units on one person (leaving them at 0) costs 10+40=50; spreading them
    one-each across two people (each at 1, one short of 2) costs 10+10=20 -
    strictly cheaper, so the solver must spread them.
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3', 'p4']
    band = {'AVOND': [2, 2], 'WEEKEND': [2, 2], 'FEESTDAG': [2, 2]}

    result = solve(people, slots, window_weeks=1, band=band,
                    band_deviation_penalty=[10.0, 40.0, 160.0], band_deviation_multiplier=4.0)

    assert result['success']
    assert len(result['diagnostics']['unfilled_slots']) == 0, 'all 6 slots should still be filled'
    counts = {p: 0 for p in people}
    for a in result['assignments']:
        counts[a['person_id']] += 1

    assert min(counts.values()) >= 1, (
        f'no single person should absorb both units of shortage (ending up at 0) when spreading is cheaper: {counts}'
    )
    under_target = sum(1 for c in counts.values() if c < 2)
    assert under_target == 2, f'the 2-unit shortage should land on 2 different people, not concentrated: {counts}'


def test_band_deviation_penalty_keeps_growing_past_the_reified_tier_cap():
    """
    add_band_slack_objective only reifies max_tiers=8 "deviation >= N"
    booleans - deviation beyond that has no boolean of its own. If nothing
    prices the gap, a deviation of 10 costs exactly the same as a deviation
    of 8, which defeats the whole point of an *escalating* penalty right
    when a badly understaffed pool needs it most.

    This isolates `under` deviation specifically, via a *positive* ledger
    delta, not `over`: `over` now carries the extra shortfall_weight floor
    (see the asymmetric-pricing tests above), which would make this
    fixture's "shortfall always wins so the person takes all 8 regardless"
    assumption false - a large enough negative delta can make leaving
    slots unfilled cheaper than piling more `over` onto an already-over
    person. `under` has no such interaction (filling a slot always reduces
    *both* shortfall and under-deviation at once, never trades one against
    the other), so it stays exactly as straightforward as this test needs.

    1 person forced to take all 8 slots of a fixed-size period (nobody
    else exists, so the huge shortfall weight always wins over the
    unaffected `under` tier cost) isolates deviation via the ledger delta
    alone, not headcount: delta=+8 makes their effective band minimum 16
    (deviation=8, exactly at the tier cap); delta=+10 makes it 18
    (deviation=10, 2 past the cap). Both scenarios have identical
    assignment counts and slot counts, so the only things that can move
    are the band-slack term (this bug) and the band-imbalance term (a
    separate, already-correct term with a known fixed weight of 0.5) -
    both track the same 2-unit delta, so the total cost must rise by
    tier_cost(9)*2 + 0.5*2 = 5.0*2 + 1.0 = 11.0, not by just the
    imbalance term's 1.0 alone.
    """
    slots = make_slots(8)
    band = {'AVOND': [8, 8], 'WEEKEND': [8, 8], 'FEESTDAG': [8, 8]}

    at_tier_cap = solve(['p1'], slots, window_weeks=1, band=band,
                         balances={'p1': {'AVOND': 8, 'WEEKEND': 0, 'FEESTDAG': 0}})
    past_tier_cap = solve(['p1'], slots, window_weeks=1, band=band,
                           balances={'p1': {'AVOND': 10, 'WEEKEND': 0, 'FEESTDAG': 0}})

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


def test_holiday_spread_blocks_a_feestdag_slot_too_close_to_a_prior_period_feestdag_shift():
    """
    prior_assignments carries a FEESTDAG shift from just before this period
    started - without threading it into add_holiday_spread_constraints,
    someone who worked a FEESTDAG shift right at the end of the previous
    period could be handed another one at the very start of this one,
    since this rule otherwise only ever saw this period's own slots. This
    mirrors add_prior_assignment_constraints' carry-over for window_weeks,
    but scoped to FEESTDAG and holiday_spread_weeks. window_weeks=0 (off)
    isolates this from the general window rule.
    """
    slots = make_slots(1, teller='FEESTDAG', start_year=2027, start_week=3)  # week 3, 2027
    prior = [{'person_id': 'p1', 'datum': '2027-01-04', 'teller': 'FEESTDAG'}]  # p1 worked week 1, 2027

    result = solve(['p1'], slots, window_weeks=0, holiday_spread_weeks=4, prior=prior)

    assert result['assignments'] == [], (
        f"holiday spread ignored the previous period's FEESTDAG carry-over: {result['assignments']}"
    )


def test_holiday_spread_prior_carry_over_ignores_non_feestdag_shifts():
    """
    The prior-assignment carry-over above must stay FEESTDAG-specific too:
    a prior AVOND shift must never block a new period's FEESTDAG slot.
    """
    slots = make_slots(1, teller='FEESTDAG', start_year=2027, start_week=3)
    prior = [{'person_id': 'p1', 'datum': '2027-01-04', 'teller': 'AVOND'}]

    result = solve(['p1'], slots, window_weeks=0, holiday_spread_weeks=4, prior=prior)

    assert len(result['assignments']) == 1, (
        f'a prior AVOND shift must not block a FEESTDAG slot via holiday spread: {result["assignments"]}'
    )


def test_window_rule_respects_a_manual_assignment_within_this_period():
    """
    A planner can manually pre-fill a slot (e.g. a strong holiday
    preference) before the solver ever runs. generate-roster/route.ts
    excludes that slot from `slots` so the solver can't double-fill it,
    but the solver still has to know the person is already committed on
    that date for the window rule - otherwise it could hand them another
    shift right next to one they're already working. manual_assignments
    is exactly this: one slot a single week after a manual assignment,
    windowWeeks=2 - the only candidate must be left unassigned rather than
    double-booked within the window, the same way prior_assignments
    (the previous *period's* tail) already works.
    """
    slots = make_slots(1, start_year=2027, start_week=2)  # lone slot in week 2, 2027
    manual = [{'person_id': 'p1', 'datum': '2027-01-04', 'teller': 'AVOND'}]  # p1 already has a manual shift week 1

    result = solve(['p1'], slots, window_weeks=2, manual=manual)

    assert result['assignments'] == [], (
        f"window rule ignored a within-period manual assignment: {result['assignments']}"
    )
    assert len(result['diagnostics']['unfilled_slots']) == 1


def test_band_target_is_reduced_by_an_existing_manual_assignment():
    """
    If a person already has a manually-assigned AVOND shift this period
    before the solver runs, the solver's own decisions must target the
    *remaining* band, not the full one on top of it - otherwise it would
    independently chase the full target too, and the real total (manual +
    solver) would blow straight past the configured band without that ever
    showing up as a violation (the solver's own band-slack bookkeeping
    only ever sees its own decisions, never the manual one).

    Two people, base band [1,1], two AVOND slots. p1 has one manual AVOND
    shift already; p2 has a +1 AVOND ledger balance instead (same
    mechanism band-wise, just via the other existing input) so their
    *effective* targets become p1=[0,0] (1 base - 1 already assigned) and
    p2=[2,2] (1 base + 1 delta). With those targets, p1=0/p2=2 is the
    *unique* zero-slack split of the 2 slots (both other splits cost
    strictly more, see the arithmetic below), so this isn't a tie CP-SAT
    could break either way by chance - it's the one clearly cheapest
    answer, and only reachable if the manual assignment actually reduced
    p1's target the way it's meant to. The margin is large because p1
    going even 1 over their (already-met) target now also carries the
    shortfall_weight floor on top of the ordinary tier (see
    add_band_slack_objective) - it no longer takes a tie-break, just
    confirms the same winner as before by an even wider margin:
      - (p1=0, p2=2): p1 exact (0 slack), p2 exact (0 slack) -> cheapest
      - (p1=1, p2=1): p1 +1 over (>= 1000), p2 -1 under (a few units)
      - (p1=2, p2=0): p1 +2 over (>= 2000), p2 -2 under (a few units)
    """
    slots = make_slots(2, teller='AVOND', start_year=2027, start_week=3)
    # A full two ISO weeks before the earliest slot - well outside
    # window_weeks=1, so this only tests the band, not the window rule.
    manual = [{'person_id': 'p1', 'datum': '2027-01-04', 'teller': 'AVOND'}]
    balances = {
        'p1': {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0},
        'p2': {'AVOND': 1, 'WEEKEND': 0, 'FEESTDAG': 0},
    }

    result = solve(
        ['p1', 'p2'], slots, window_weeks=1,
        band={'AVOND': [1, 1], 'WEEKEND': [0, len(slots)], 'FEESTDAG': [0, len(slots)]},
        balances=balances, manual=manual,
    )

    counts = {p: sum(1 for a in result['assignments'] if a['person_id'] == p) for p in ['p1', 'p2']}
    assert counts == {'p1': 0, 'p2': 2}, (
        f"expected the unique zero-slack split (p1=0 - target already met by the manual "
        f"assignment, p2=2), got {counts}"
    )
    assert result['diagnostics']['violations']['band_limit'] == 0


# ---------------------------------------------------------------------------
# OBJECTIVE_MODE='lexicographic' ("Prioriteitenplanner"): strict phase
# priority instead of one weighted sum
# ---------------------------------------------------------------------------
#
# objective_mode defaulting to 'weighted' when omitted is already proven by
# every test above this point - none of them pass objective_mode, and all
# still pass unchanged, which is exactly the backward-compatibility
# guarantee that default exists for (see main.py's RuleSet.objective_mode
# docstring: an already-frozen period's ruleset predates this field
# entirely, and CLAUDE.md rules out retroactively changing its behaviour).

def test_lexicographic_minimizes_the_worst_individual_deviation_not_the_sum():
    """
    The structural bug 'weighted' can never fully close: add_band_imbalance_
    objective (and, for under-band shortage specifically, add_band_slack_
    objective under its default flat tier) sums each person's deviation, so
    one person 2 short costs exactly the same as two people 1 short each -
    the model has no preference between "concentrated on one person" and
    "spread across several" as long as the sum matches. That is exactly the
    real-world case this feature exists for: one person absorbing far more
    of a shortage than everyone else, with the weighted model unable to see
    anything wrong with it.

    4 people, band [2,2] (everyone wants exactly 2 -> demand 8), 6 slots -
    2 short of that demand, so *some* shortage is unavoidable once every
    slot is filled (phase 1 already guarantees all 6 are filled - leaving
    any unfilled instead would only add shortfall cost with nothing to
    show for it). The only question is how that 2-unit shortage lands:

    - Concentrated (one person at 0, deviation 2, the rest at 2): the worst
      deviation is 2.
    - Spread (two people at 1, deviation 1 each, two at 2): the worst
      deviation is 1.

    Phase 2 minimizes the *worst* deviation directly (AddMaxEquality, not a
    sum), so spreading strictly beats concentrating here - not a tie a
    solver could break either way, a genuinely lower objective value. Every
    split achieving worst-case 1 is an acceptable answer (there's more than
    one shape), so this checks the deviation bound itself rather than one
    specific distribution.
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3', 'p4']
    band = {'AVOND': [2, 2], 'WEEKEND': [2, 2], 'FEESTDAG': [2, 2]}

    result = solve(people, slots, window_weeks=1, band=band, objective_mode='lexicographic')

    assert result['success']
    assert len(result['diagnostics']['unfilled_slots']) == 0, 'all 6 slots should still be filled'
    counts = {p: 0 for p in people}
    for a in result['assignments']:
        counts[a['person_id']] += 1

    deviations = [abs(c - 2) for c in counts.values()]
    assert max(deviations) == 1, (
        f"expected the worst-case deviation minimized to exactly 1 (the true minimum possible "
        f"here, forcing the shortage to spread), got deviations={deviations} from counts={counts}"
    )


def test_lexicographic_still_fills_as_much_as_physically_possible_first():
    """
    Phase 1 (dekking) must still dominate everything else - a partial
    roster, not nothing, when there genuinely aren't enough people. Mirrors
    test_understaffed_period_returns_partial_roster_not_nothing, under
    'lexicographic' instead of the default 'weighted'.
    """
    slots = make_slots(10)
    result = solve(['p1'], slots, window_weeks=5, objective_mode='lexicographic')

    assert result['success'], 'solver should still succeed when short-staffed'
    assigned = len(result['assignments'])
    unfilled = len(result['diagnostics']['unfilled_slots'])

    assert assigned > 0, 'expected a partial roster, got nothing'
    assert unfilled > 0, 'expected reported gaps'
    assert assigned + unfilled == len(slots)


def test_lexicographic_never_violates_a_hard_rule_even_under_scarcity():
    """
    Hard rules (ABSOLUUT blocks, here) are built once by build_model
    regardless of objective_mode - constraints.py never sees which mode is
    active. Mirrors test_absoluut_block_is_never_violated_even_under_
    scarcity to prove that's actually true for 'lexicographic' too, not
    just assumed from shared code.
    """
    slots = make_slots(6)
    blocked = {('p1', s['id']) for s in slots}
    result = solve(['p1'], slots, window_weeks=1, blocked=blocked, objective_mode='lexicographic')

    assert result['success']
    assert result['assignments'] == [], 'solver violated an ABSOLUUT block'
    assert len(result['diagnostics']['unfilled_slots']) == 6


def test_lexicographic_avoids_a_lievernietslot_when_a_free_alternative_exists():
    """
    Phase 3 (liever-niet) must actually do something, not just exist as an
    empty pass-through. One slot, two otherwise-interchangeable people
    (same wide-open band, so phase 2 can't prefer either) - p1 has marked
    it LIEVER_NIET, p2 hasn't, so avoiding p1 costs nothing on any earlier
    phase. p2 must get it.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    soft = {('p1', slots[0]['id']): 1.0}

    result = solve(people, slots, window_weeks=1, soft=soft, objective_mode='lexicographic')

    assert result['success']
    assigned = [a['person_id'] for a in result['assignments']]
    assert assigned == ['p2'], f'expected p2 (no LIEVER_NIET mark) to get the slot, got {assigned}'


def test_lexicographic_honours_preference_when_choice_is_otherwise_tied():
    """
    Phase 4 (voorkeur) must actually do something too. Mirrors
    test_preference_is_honoured_when_choice_is_otherwise_tied under
    'lexicographic': one slot, two interchangeable people, only p1 has a
    VOORKEUR mark - nothing earlier in the phase order can prefer either of
    them, so phase 4 alone decides.
    """
    slots = make_slots(1)
    people = ['p1', 'p2']
    preferred = {('p1', slots[0]['id']): 1.0}

    result = solve(people, slots, window_weeks=1, preferred=preferred, objective_mode='lexicographic')

    assert result['success']
    assigned = [a['person_id'] for a in result['assignments']]
    assert assigned == ['p1'], f'expected the preferred person p1 to get the sole shift, got {assigned}'


# ---------------------------------------------------------------------------
# random_seed / diagnostics fields the "Herhaalplanner" multi-start loop
# (Next.js) relies on to rank repeated /solve calls against each other
# ---------------------------------------------------------------------------

def test_random_seed_does_not_change_correctness_of_the_result():
    """
    random_seed only ever steers CP-SAT's search, never the model or
    constraints - it must never let a hard rule slip, regardless of which
    seed happens to be passed. (Two solves of the *same* seed are not
    asserted to reproduce the exact same assignment: with the solver's
    default multi-worker search, several threads racing for an equally
    optimal solution means even a fixed seed doesn't pin down which one
    wins - true bit-for-bit reproducibility would additionally require
    forcing num_search_workers=1, which this app doesn't do, since the
    whole point of "Herhaalplanner" is to explore *different* solutions
    across attempts, not to reproduce one.)
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3', 'p4']
    band = {'AVOND': [1, 2], 'WEEKEND': [1, 2], 'FEESTDAG': [1, 2]}

    for seed in (1, 2, 3):
        result = solve(people, slots, window_weeks=1, band=band, objective_mode='lexicographic', random_seed=seed)
        assert result['success']
        assert len(result['diagnostics']['unfilled_slots']) == 0
        counts = {}
        for a in result['assignments']:
            counts[a['person_id']] = counts.get(a['person_id'], 0) + 1
        for p in people:
            assert 1 <= counts.get(p, 0) <= 2, f'seed {seed}: {p} fell outside the band'


def test_diagnostics_report_max_and_total_band_deviation():
    """
    generate_roster's diagnostics must expose the actual deviation
    magnitude, not just a violation count - the "Herhaalplanner" loop
    ranks attempts by how far the worst-off (and everyone combined) person
    strayed from their band, which a plain count can't distinguish (one
    person 4 off vs. four people 1 off each both count as "1 violation" or
    "4 violations" depending on what's counted, but differ hugely in
    max_band_deviation).
    """
    slots = make_slots(6)
    people = ['p1', 'p2', 'p3', 'p4']
    band = {'AVOND': [2, 2], 'WEEKEND': [2, 2], 'FEESTDAG': [2, 2]}

    result = solve(people, slots, window_weeks=1, band=band, objective_mode='lexicographic')

    assert result['success']
    diag = result['diagnostics']
    counts = {}
    for a in result['assignments']:
        counts[a['person_id']] = counts.get(a['person_id'], 0) + 1
    expected_deviations = [abs(counts.get(p, 0) - 2) for p in people]
    assert diag['max_band_deviation'] == max(expected_deviations)
    assert diag['total_band_deviation'] == sum(expected_deviations)


def test_diagnostics_report_soft_block_violations_and_preference_matches():
    """
    Both counts must reflect the actual final assignment, not the
    objective terms that pushed toward them - see generate_roster's
    assigned_pairs computation. Two independent slots so each mechanism can
    be checked without the other interfering: p1 is LIEVER_NIET on slot 0
    but forced onto it (sole candidate), p2 has a VOORKEUR mark on slot 1
    and is free to get it.
    """
    slots = make_slots(2)
    people = ['p1', 'p2']
    soft = {('p1', slots[0]['id']): 1.0}
    preferred = {('p2', slots[1]['id']): 1.0}
    blocked = {('p2', slots[0]['id']), ('p1', slots[1]['id'])}

    result = solve(
        people, slots, window_weeks=1, soft=soft, preferred=preferred, blocked=blocked,
        objective_mode='lexicographic'
    )

    assert result['success']
    diag = result['diagnostics']
    assert diag['soft_block_violations'] == 1, 'p1 had no alternative, so the LIEVER_NIET mark had to be violated'
    assert diag['preference_matches'] == 1, "p2's VOORKEUR slot should have been honoured"


# ---------------------------------------------------------------------------
# HARD RULE: per-teller windows (window_weeks_avond / window_weeks_weekend_feestdag)
# ---------------------------------------------------------------------------

def _mixed_avond_weekend_slots():
    """One AVOND slot in week 1, one WEEKEND slot in week 2 (1 week apart -
    within a window_weeks=2 gap), for the per-teller-window tests below."""
    monday_w1 = date.fromisocalendar(2027, 1, 1)
    monday_w2 = date.fromisocalendar(2027, 2, 1)
    return [
        {
            'id': 'avond-w1', 'datum': monday_w1.isoformat(),
            'iso_jaar': 2027, 'iso_week': 1, 'shift_type_id': 'st-avond',
            'shift_type_name': 'AVOND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
        {
            'id': 'weekend-w2', 'datum': monday_w2.isoformat(),
            'iso_jaar': 2027, 'iso_week': 2, 'shift_type_id': 'st-weekend',
            'shift_type_name': 'WEEKEND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
    ]


def test_pooled_window_blocks_across_teller_types():
    """
    Baseline / backward-compat: with window_weeks_avond and
    window_weeks_weekend_feestdag both unset (the only state a period
    frozen before per-teller windows existed can ever be in), the window
    rule must still pool every teller together exactly as before - one
    person, an AVOND shift in week 1 and a WEEKEND shift in week 2 (1 week
    apart, inside a window_weeks=2 gap), must not get both.
    """
    slots = _mixed_avond_weekend_slots()
    result = solve(['p1'], slots, window_weeks=2, objective_mode='lexicographic')

    assert result['success']
    assert len(result['assignments']) <= 1, (
        f"pooled window rule must block the second (cross-teller) assignment, got {result['assignments']}"
    )


def test_per_teller_windows_apply_the_smaller_one_as_a_cross_type_floor():
    """
    Hard rule, per the planner's own explicit correction: "een
    weekenddienst kan wel een avonddienst blokkeren en andersom... het
    minimum geldt dan voor alle diensten" - AVOND and WEEKEND are NOT fully
    independent under per-teller windows. The *smaller* of the two configured
    windows still applies as a floor between every pair of shifts regardless
    of type. window_weeks_avond=2, window_weeks_weekend_feestdag=4 -> floor
    is 2. An AVOND shift in week 1 and a WEEKEND shift in week 2 (1 week
    apart, below the floor of 2) must still not both be assigned.
    """
    slots = _mixed_avond_weekend_slots()
    result = solve(
        ['p1'], slots, objective_mode='lexicographic',
        window_weeks_avond=2, window_weeks_weekend_feestdag=4,
    )

    assert result['success']
    assert len(result['assignments']) <= 1, (
        f"cross-type gap (1 week) is below the floor min(2,4)=2, expected only one filled, got {result['assignments']}"
    )


def test_per_teller_windows_cross_type_only_needs_the_floor_not_the_larger_windows_own_value():
    """
    Counterpart to the floor test above: a cross-type gap that clears the
    *floor* must be allowed even if it's still below the larger group's own
    same-type window - window_weeks_avond=2, window_weeks_weekend_feestdag=4
    (floor=2). An AVOND shift in week 1 and a WEEKEND shift in week 3 (2
    weeks apart - meets the floor, but is less than WEEKEND's own 4-week
    same-type cap) must both be assignable, since that stricter 4-week rule
    only applies *between two WEEKEND/FEESTDAG shifts*, not across types.
    """
    monday_w1 = date.fromisocalendar(2027, 1, 1)
    monday_w3 = date.fromisocalendar(2027, 3, 1)
    slots = [
        {
            'id': 'avond-w1', 'datum': monday_w1.isoformat(),
            'iso_jaar': 2027, 'iso_week': 1, 'shift_type_id': 'st-avond',
            'shift_type_name': 'AVOND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
        {
            'id': 'weekend-w3', 'datum': monday_w3.isoformat(),
            'iso_jaar': 2027, 'iso_week': 3, 'shift_type_id': 'st-weekend',
            'shift_type_name': 'WEEKEND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
    ]
    result = solve(
        ['p1'], slots, objective_mode='lexicographic',
        window_weeks_avond=2, window_weeks_weekend_feestdag=4,
    )

    assert result['success']
    assert len(result['assignments']) == 2, (
        f"2-week cross-type gap clears the floor of 2, expected both filled, got {result['assignments']}"
    )


def test_per_teller_windows_still_enforce_the_larger_same_type_window():
    """
    The other half of the same scenario: two WEEKEND shifts 2 weeks apart
    (clearing the cross-type floor of 2) must still be blocked by WEEKEND's
    own, stricter 4-week same-type cap - the floor only ever loosens
    cross-type pairs, never the same-type rule itself.
    """
    monday_w1 = date.fromisocalendar(2027, 1, 1)
    monday_w3 = date.fromisocalendar(2027, 3, 1)
    slots = [
        {
            'id': 'weekend-w1', 'datum': monday_w1.isoformat(),
            'iso_jaar': 2027, 'iso_week': 1, 'shift_type_id': 'st-weekend',
            'shift_type_name': 'WEEKEND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
        {
            'id': 'weekend-w3', 'datum': monday_w3.isoformat(),
            'iso_jaar': 2027, 'iso_week': 3, 'shift_type_id': 'st-weekend',
            'shift_type_name': 'WEEKEND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
    ]
    result = solve(
        ['p1'], slots, objective_mode='lexicographic',
        window_weeks_avond=2, window_weeks_weekend_feestdag=4,
    )

    assert result['success']
    assert len(result['assignments']) <= 1, (
        f"2-week gap is below WEEKEND's own 4-week same-type cap, expected only one filled, got {result['assignments']}"
    )


def test_per_teller_windows_still_restrict_within_the_weekend_feestdag_group():
    """
    Hard rule: WEEKEND and FEESTDAG are pooled together as one group under
    per-teller windows (not each given their own window) - a WEEKEND shift
    in week 1 must still block a FEESTDAG shift in week 2 for the same
    person under window_weeks_weekend_feestdag=2, proving the grouping
    itself (not just the AVOND split) is enforced, not two more
    independent windows.
    """
    monday_w1 = date.fromisocalendar(2027, 1, 1)
    monday_w2 = date.fromisocalendar(2027, 2, 1)
    slots = [
        {
            'id': 'weekend-w1', 'datum': monday_w1.isoformat(),
            'iso_jaar': 2027, 'iso_week': 1, 'shift_type_id': 'st-weekend',
            'shift_type_name': 'WEEKEND', 'benodigd_aantal_personen': 1,
            'is_feestdag': False, 'feestdag_groep': None,
        },
        {
            'id': 'feestdag-w2', 'datum': monday_w2.isoformat(),
            'iso_jaar': 2027, 'iso_week': 2, 'shift_type_id': 'st-feestdag',
            'shift_type_name': 'FEESTDAG', 'benodigd_aantal_personen': 1,
            'is_feestdag': True, 'feestdag_groep': 'KERST',
        },
    ]
    result = solve(
        ['p1'], slots, objective_mode='lexicographic',
        window_weeks_avond=1, window_weeks_weekend_feestdag=2,
    )

    assert result['success']
    assert len(result['assignments']) <= 1, (
        f"WEEKEND and FEESTDAG share one window group, expected only one filled, got {result['assignments']}"
    )


# ---------------------------------------------------------------------------
# band_overrides: a fellow's weekend (lib/fellows.ts)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('objective_mode', ['weighted', 'lexicographic'])
def test_band_override_caps_a_fellows_weekend_at_the_days_they_released(objective_mode):
    """
    A fellow's WEEKEND band is replaced by [0, released days]: never more,
    even with slots left over, and being under it is no band violation.
    p1 (fellow, released 1) and p2 (band 2), four weekend slots: p1 takes
    exactly 1, p2 takes 2, one stays unfilled.
    """
    slots = make_slots(4, teller='WEEKEND')
    band = {'AVOND': [0, 0], 'WEEKEND': [2, 2], 'FEESTDAG': [0, 0]}
    result = solve(
        ['p1', 'p2'], slots, window_weeks=1, band=band, objective_mode=objective_mode,
        band_overrides={'p1': {'WEEKEND': (0, 1)}},
    )

    per_person = {p: len(w) for p, w in weeks_by_person(result, slots).items()}
    assert per_person.get('p1', 0) == 1
    assert per_person.get('p2', 0) == 2
    assert result['diagnostics']['violations']['band_limit'] == 0


def test_band_override_ignores_the_ledger_delta():
    """
    A weekend saldo waits while someone is a fellow: +3 in the ledger does
    not lift the override [0, 0], and nobody is counted as short.
    """
    slots = make_slots(3, teller='WEEKEND')
    band = {'AVOND': [0, 0], 'WEEKEND': [1, 1], 'FEESTDAG': [0, 0]}
    result = solve(
        ['p1'], slots, window_weeks=1, band=band,
        balances={'p1': {'AVOND': 0, 'WEEKEND': 3, 'FEESTDAG': 0}},
        band_overrides={'p1': {'WEEKEND': (0, 0)}},
    )

    assert result['assignments'] == []
    assert result['diagnostics']['violations']['band_limit'] == 0

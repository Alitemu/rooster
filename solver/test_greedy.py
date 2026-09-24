"""
Greedy construction ("Gerandomiseerde planner") rule tests.

Convention (CLAUDE.md): one hard rule = one test that proves it cannot be
broken - not an example of correct output, but proof of enforcement.

Run: pytest solver/ -v      (deps: pip install -r solver/requirements-dev.txt)
"""

from datetime import date, timedelta

import pytest
from greedy import run_greedy_construction


def make_slots(num_weeks, teller='AVOND', start_year=2027, start_week=1):
    """One slot per real calendar week - see test_solver.py's own copy."""
    base_monday = date.fromisocalendar(start_year, start_week, 1)
    slots = []
    for w in range(num_weeks):
        d = base_monday + timedelta(weeks=w)
        iso_year, iso_week, _ = d.isocalendar()
        slots.append({
            'id': f'slot-w{w + 1}',
            'datum': d.isoformat(),
            'iso_jaar': iso_year,
            'iso_week': iso_week,
            'shift_type_id': 'st-1',
            'shift_type_name': teller,
            'benodigd_aantal_personen': 1,
            'is_feestdag': teller == 'FEESTDAG',
            'feestdag_groep': 'KERST' if teller == 'FEESTDAG' else None,
        })
    return slots


def run(people, slots, window_weeks=2, band=None, blocked=None, soft=None, preferred=None,
        prior=None, manual=None, distribution_mode='GELIJK', participation_factors=None,
        coverage=None, holiday_spread_weeks=0, variant='medewerker', random_seed=1,
        window_weeks_avond=None, window_weeks_weekend_feestdag=None, band_overrides=None):
    wide = {'AVOND': (0, len(slots)), 'WEEKEND': (0, len(slots)), 'FEESTDAG': (0, len(slots))}
    return run_greedy_construction(
        people=people,
        slots=slots,
        blocked_slots=blocked or set(),
        soft_slots=soft or {},
        band_ranges=band or wide,
        balances={p: {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0} for p in people},
        window_weeks=window_weeks,
        preferred_slots=preferred or {},
        prior_assignments=prior or [],
        manual_assignments=manual or [],
        distribution_mode=distribution_mode,
        participation_factors=participation_factors,
        coverage_factors=coverage,
        holiday_spread_weeks=holiday_spread_weeks,
        variant=variant,
        random_seed=random_seed,
        window_weeks_avond=window_weeks_avond,
        window_weeks_weekend_feestdag=window_weeks_weekend_feestdag,
        band_overrides=band_overrides,
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_absoluut_block_is_never_violated(variant):
    """
    Hard rule: a person with an ABSOLUUT mark on a slot must never be
    assigned to it, however scarce the alternatives - even when they're
    the only person in the pool, so the slot must be left unfilled rather
    than break the block.
    """
    slots = make_slots(6)
    blocked = {('p1', s['id']) for s in slots}

    result = run(['p1'], slots, window_weeks=1, blocked=blocked, variant=variant)

    assert result['assignments'] == [], 'greedy construction violated an ABSOLUUT block'
    assert len(result['diagnostics']['unfilled_slots']) == 6


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_window_rule_holds(variant):
    """
    Hard rule: with only one person able to work every slot, window_weeks=2
    must space their assignments at least 2 weeks apart - proves the
    per-slot eligibility check (not just a "try to" heuristic) actually
    excludes a too-soon candidate rather than merely preferring against it.
    """
    slots = make_slots(6)

    result = run(['p1'], slots, window_weeks=2, variant=variant)

    assigned_weeks = sorted(
        int(a['slot_id'].removeprefix('slot-w')) for a in result['assignments']
    )
    for i in range(len(assigned_weeks) - 1):
        assert assigned_weeks[i + 1] - assigned_weeks[i] >= 2, (
            f'window rule violated: {assigned_weeks}'
        )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_holiday_spread_holds(variant):
    """
    Hard rule: holiday_spread_weeks must keep this one person's FEESTDAG
    assignments at least that many weeks apart, independent of window_weeks
    (set to 0/no-restriction here so only the holiday-spread check itself
    can be responsible for any gap enforced).
    """
    slots = make_slots(6, teller='FEESTDAG')

    result = run(['p1'], slots, window_weeks=0, holiday_spread_weeks=3, variant=variant)

    assigned_weeks = sorted(
        int(a['slot_id'].removeprefix('slot-w')) for a in result['assignments']
    )
    for i in range(len(assigned_weeks) - 1):
        assert assigned_weeks[i + 1] - assigned_weeks[i] >= 3, (
            f'holiday spread violated: {assigned_weeks}'
        )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_never_pushes_anyone_over_their_band_maximum(variant):
    """
    "Eerlijk verdelen, koste wat kost" (this session's explicit policy,
    already enforced structurally in the CP-SAT objective - see
    objective.add_band_slack_objective): with more slots than the combined
    pool can absorb inside their band, greedy construction must leave the
    surplus slots unfilled rather than assign anyone past their own
    streefwaarde-maximum. Two people, band max 2 each, 6 slots (needs 6,
    room for only 4) - proves has_room() actually blocks a pick, not just
    discourages one.
    """
    slots = make_slots(6)
    band = {'AVOND': (0, 2), 'WEEKEND': (0, 2), 'FEESTDAG': (0, 2)}

    result = run(['p1', 'p2'], slots, window_weeks=1, band=band, variant=variant)

    counts = {'p1': 0, 'p2': 0}
    for a in result['assignments']:
        counts[a['person_id']] += 1
    assert counts['p1'] <= 2 and counts['p2'] <= 2, f'band maximum exceeded: {counts}'
    assert len(result['diagnostics']['unfilled_slots']) == 2, (
        'expected exactly the 2 slots neither person had band room for to stay open'
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_preference_is_honoured_when_eligible(variant):
    """
    VOORKEUR must actually steer the pick, not just exist as an unused
    field - one slot, two otherwise-interchangeable people, only p1 has a
    VOORKEUR mark, so p1 must get it regardless of random shuffle order
    (tier 1 in assign_for_slot always wins over tier 2).
    """
    slots = make_slots(1)
    preferred = {('p1', slots[0]['id']): 1.0}

    for seed in range(10):
        result = run(['p1', 'p2'], slots, window_weeks=1, preferred=preferred, variant=variant, random_seed=seed)
        assigned = [a['person_id'] for a in result['assignments']]
        assert assigned == ['p1'], f'seed {seed}: expected preferred p1, got {assigned}'


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_liever_niet_is_avoided_when_a_free_alternative_exists(variant):
    """
    LIEVER_NIET must be avoided whenever an alternative is eligible - one
    slot, two interchangeable people, only p1 marked LIEVER_NIET, so p2
    must get it regardless of shuffle order (tier 2 skips p1 in favor of
    p2 whenever p2 is present in the randomized list).
    """
    slots = make_slots(1)
    soft = {('p1', slots[0]['id']): 1.0}

    for seed in range(10):
        result = run(['p1', 'p2'], slots, window_weeks=1, soft=soft, variant=variant, random_seed=seed)
        assigned = [a['person_id'] for a in result['assignments']]
        assert assigned == ['p2'], f'seed {seed}: expected p2 (no LIEVER_NIET mark), got {assigned}'


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_best_effort_under_scarcity(variant):
    """
    Not enough people for full coverage must still produce a partial
    roster (every slot that *can* be filled without breaking a hard rule
    is), not an all-or-nothing failure - mirrors
    test_solver.py's test_capacity_shortfall_reports_a_partial_roster.
    """
    slots = make_slots(6)

    result = run(['p1'], slots, window_weeks=2, variant=variant)

    assigned = len(result['assignments'])
    unfilled = len(result['diagnostics']['unfilled_slots'])
    assert assigned > 0, 'expected a partial roster, got nothing'
    assert unfilled > 0, 'expected reported gaps (one person, window_weeks=2, 6 weekly slots)'
    assert assigned + unfilled == 6


def test_dagen_variant_actually_randomizes_day_order():
    """
    The one real behavioural difference between the two variants: 'dagen'
    must process days in something other than pure chronological order for
    at least some seeds, or it's just 'medewerker' with a different label.
    Not a hard rule - a probabilistic sanity check with enough slots and
    seeds that a false failure is vanishingly unlikely.
    """
    slots = make_slots(20)
    people = [f'p{i}' for i in range(10)]

    saw_non_chronological = False
    for seed in range(15):
        result = run(people, slots, window_weeks=1, variant='dagen', random_seed=seed)
        order = [a['slot_id'] for a in result['assignments']]
        if order != sorted(order):
            saw_non_chronological = True
            break

    assert saw_non_chronological, "'dagen' variant never produced a non-chronological fill order across 15 seeds"


def test_random_seed_is_reproducible():
    """
    Unlike CP-SAT's multi-worker search (see test_solver.py's
    test_random_seed_does_not_change_correctness_of_the_result), greedy
    construction is a single-threaded, purely sequential walk with no
    parallel search to race - the same seed on the same input must
    reproduce the exact same assignment every time, which is what makes
    "beste van N pogingen" a meaningful, stable comparison rather than
    noise.
    """
    slots = make_slots(10)
    people = [f'p{i}' for i in range(5)]

    first = run(people, slots, window_weeks=1, random_seed=7)
    second = run(people, slots, window_weeks=1, random_seed=7)

    assert sorted(first['assignments'], key=lambda a: a['slot_id']) == sorted(
        second['assignments'], key=lambda a: a['slot_id']
    )


def test_naar_rato_scales_the_band_the_same_way_constraints_py_does():
    """
    distribution_mode='NAAR_RATO' must proportionally shrink a part-timer's
    band the same way constraints.add_band_constraints does (floor/ceil,
    not round, so width never collapses to 0) - a half-time person with
    band [0,4] gets [0,2], so with unlimited slots and only that one
    person, they must be capped at 2, not 4.
    """
    slots = make_slots(6)
    band = {'AVOND': (0, 4), 'WEEKEND': (0, 4), 'FEESTDAG': (0, 4)}

    result = run(
        ['p1'], slots, window_weeks=1, band=band,
        distribution_mode='NAAR_RATO', participation_factors={'p1': 0.5},
    )

    assert len(result['assignments']) <= 2, (
        f"expected NAAR_RATO to cap a 0.5-factor person's band at 2, got {len(result['assignments'])}"
    )


# ---------------------------------------------------------------------------
# HARD RULE: per-teller windows (window_weeks_avond / window_weeks_weekend_feestdag)
# ---------------------------------------------------------------------------

def _mixed_avond_weekend_slots():
    """One AVOND slot in week 1, one WEEKEND slot in week 2 - see
    test_solver.py's identical fixture for why (1 week apart, inside a
    window_weeks=2 gap)."""
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


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_pooled_window_blocks_across_teller_types(variant):
    """
    Baseline / backward-compat: with window_weeks_avond and
    window_weeks_weekend_feestdag both unset, the window rule must still
    pool every teller together exactly as before - one person, an AVOND
    shift in week 1 and a WEEKEND shift in week 2, must not get both.
    """
    slots = _mixed_avond_weekend_slots()
    result = run(['p1'], slots, window_weeks=2, variant=variant)

    assert len(result['assignments']) <= 1, (
        f"pooled window rule must block the second (cross-teller) assignment, got {result['assignments']}"
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_per_teller_windows_apply_the_smaller_one_as_a_cross_type_floor(variant):
    """
    Hard rule, per the planner's own explicit correction: "een
    weekenddienst kan wel een avonddienst blokkeren en andersom... het
    minimum geldt dan voor alle diensten" - AVOND and WEEKEND are NOT fully
    independent under per-teller windows. The *smaller* of the two
    configured windows still applies as a floor between every pair of
    shifts regardless of type. window_weeks_avond=2,
    window_weeks_weekend_feestdag=4 -> floor is 2. An AVOND shift in week 1
    and a WEEKEND shift in week 2 (1 week apart, below the floor) must not
    both be assigned.
    """
    slots = _mixed_avond_weekend_slots()
    result = run(
        ['p1'], slots, variant=variant,
        window_weeks_avond=2, window_weeks_weekend_feestdag=4,
    )

    assert len(result['assignments']) <= 1, (
        f"cross-type gap (1 week) is below the floor min(2,4)=2, expected only one filled, got {result['assignments']}"
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_per_teller_windows_cross_type_only_needs_the_floor(variant):
    """
    Counterpart: a cross-type gap that clears the floor must be allowed
    even if it's below the larger group's own same-type window -
    window_weeks_avond=2, window_weeks_weekend_feestdag=4 (floor=2). An
    AVOND shift in week 1 and a WEEKEND shift in week 3 (2 weeks apart)
    must both be assignable, since WEEKEND's stricter 4-week cap only
    applies between two WEEKEND/FEESTDAG shifts, not across types.
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
    result = run(
        ['p1'], slots, variant=variant,
        window_weeks_avond=2, window_weeks_weekend_feestdag=4,
    )

    assert len(result['assignments']) == 2, (
        f"2-week cross-type gap clears the floor of 2, expected both filled, got {result['assignments']}"
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_per_teller_windows_still_enforce_the_larger_same_type_window(variant):
    """
    The other half of the same scenario: two WEEKEND shifts 2 weeks apart
    (clearing the cross-type floor) must still be blocked by WEEKEND's own,
    stricter 4-week same-type cap.
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
    result = run(
        ['p1'], slots, variant=variant,
        window_weeks_avond=2, window_weeks_weekend_feestdag=4,
    )

    assert len(result['assignments']) <= 1, (
        f"2-week gap is below WEEKEND's own 4-week same-type cap, expected only one filled, got {result['assignments']}"
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_per_teller_windows_still_restrict_within_the_weekend_feestdag_group(variant):
    """
    Hard rule: WEEKEND and FEESTDAG are pooled together as one group under
    per-teller windows, not each given their own window - a WEEKEND shift
    in week 1 must still block a FEESTDAG shift in week 2 for the same
    person under window_weeks_weekend_feestdag=2.
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
    result = run(
        ['p1'], slots, variant=variant,
        window_weeks_avond=1, window_weeks_weekend_feestdag=2,
    )

    assert len(result['assignments']) <= 1, (
        f"WEEKEND and FEESTDAG share one window group, expected only one filled, got {result['assignments']}"
    )


@pytest.mark.parametrize('variant', ['medewerker', 'dagen'])
def test_band_override_caps_a_fellows_weekend(variant):
    """Same rule as the CP-SAT solver: a fellow's WEEKEND override [0, 1]
    is a hard ceiling, and being under it is no band violation."""
    slots = make_slots(4, teller='WEEKEND')
    band = {'AVOND': (0, 0), 'WEEKEND': (2, 2), 'FEESTDAG': (0, 0)}
    result = run(['p1', 'p2'], slots, window_weeks=1, band=band, variant=variant,
                 band_overrides={'p1': {'WEEKEND': (0, 1)}})

    per_person = {}
    for a in result['assignments']:
        per_person[a['person_id']] = per_person.get(a['person_id'], 0) + 1
    assert per_person.get('p1', 0) == 1
    assert per_person.get('p2', 0) == 2
    assert result['diagnostics']['violations']['band_limit'] == 0

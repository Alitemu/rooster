"""
The solver's hard rules on generated periods, not hand-picked ones.

test_solver.py proves each rule with a small, purpose-built case. This file
throws a few hundred random periods at the full pipeline - mixed avond,
weekend and feestdag slots, blocks, soft markings, carry-over from the
previous period, shifts filled in beforehand, ledger deltas, part-time and
mid-period members, both objective modes, scarce and plentiful - and checks
every result against the rules the way an outsider would, from the output
alone:

- a slot gets at most one person, and only one the slot exists for;
- nobody lands on a day they blocked (ABSOLUUT);
- nobody gets two shifts within window_weeks of each other, counting the
  previous period's tail and the shifts filled in beforehand;
- nobody ends above their streefbereik maximum (MAX_BAND_OVERSHOOT = 0),
  computed here independently from the same inputs;
- a slot the solver leaves empty is reported as unfilled, and the other
  way round.

Seeded, so a failure names the seed that reproduces it.
"""

import math
import random
from datetime import date, timedelta

import pytest

from constraints import MAX_BAND_OVERSHOOT
from test_solver import solve

TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG']


def week_ordinal(datum: str) -> int:
    d = date.fromisoformat(datum)
    return (d - timedelta(days=d.isoweekday() - 1)).toordinal() // 7


def random_period(rng: random.Random):
    weeks = rng.randint(2, 10)
    start = date.fromisocalendar(rng.choice([2026, 2027, 2028]), rng.randint(1, 50), 1)
    people = [f'p{i}' for i in range(rng.randint(2, 12))]
    slots = []
    for day in range(weeks * 7):
        d = start + timedelta(days=day)
        if rng.random() < 0.08:
            teller = 'FEESTDAG'
        elif d.isoweekday() >= 6:
            teller = 'WEEKEND'
        else:
            teller = 'AVOND'
        if rng.random() < 0.7:
            iso_year, iso_week, _ = d.isocalendar()
            slots.append({
                'id': f's{day}',
                'datum': d.isoformat(),
                'iso_jaar': iso_year,
                'iso_week': iso_week,
                'shift_type_id': f'st-{teller}',
                'shift_type_name': teller,
                'benodigd_aantal_personen': 1,
                'is_feestdag': teller == 'FEESTDAG',
                'feestdag_groep': 'KERST' if teller == 'FEESTDAG' else None,
            })

    blocked = {(p, s['id']) for p in people for s in slots if rng.random() < rng.choice([0.0, 0.1, 0.4])}
    soft = {
        (p, s['id']): 1.0
        for p in people
        for s in slots
        if (p, s['id']) not in blocked and rng.random() < 0.1
    }

    window = rng.choice([0, 1, 2, 2, 3, 4])
    prior = []
    for p in people:
        if rng.random() < 0.3:
            back = rng.randint(1, 3)
            prior.append({'person_id': p, 'datum': (start - timedelta(weeks=back)).isoformat()})

    # A few slots filled in beforehand: taken out of `slots`, passed as manual.
    manual = []
    for s in list(slots):
        if rng.random() < 0.05:
            p = rng.choice(people)
            manual.append({'person_id': p, 'datum': s['datum'], 'teller': s['shift_type_name']})
            slots.remove(s)

    def band():
        lo = rng.randint(0, 4)
        return [lo, lo + rng.randint(0, 3)]

    bands = {t: band() for t in TELLERS}
    balances = {p: {t: rng.choice([0, 0, 0, -1, 1, -2, 2]) for t in TELLERS} for p in people}
    coverage = {p: rng.choice([1.0, 1.0, 0.5, 0.25]) for p in people}
    mode = rng.choice(['GELIJK', 'NAAR_RATO'])
    factors = {p: rng.choice([1.0, 1.0, 0.8, 0.5]) for p in people}
    objective = rng.choice(['weighted', 'lexicographic'])
    return dict(
        people=people, slots=slots, blocked=blocked, soft=soft, window=window, prior=prior, manual=manual,
        bands=bands, balances=balances, coverage=coverage, mode=mode, factors=factors, objective=objective,
    )


def band_max(case, person, teller):
    """The streefbereik maximum, worked out here from the inputs, the way the documentation describes it."""
    base_min, base_max = case['bands'][teller]
    c = case['coverage'][person]
    base_min = math.floor(base_min * c)
    base_max = max(base_min, math.ceil(base_max * c))
    if case['mode'] == 'NAAR_RATO':
        f = case['factors'][person]
        base_min = math.floor(base_min * f)
        base_max = max(base_min, math.ceil(base_max * f))
    already = sum(1 for m in case['manual'] if m['person_id'] == person and m['teller'] == teller)
    return base_max + case['balances'][person][teller] - already


@pytest.mark.parametrize('seed', range(150))
def test_hard_rules_hold_on_a_random_period(seed):
    rng = random.Random(seed)
    case = random_period(rng)
    result = solve(
        case['people'],
        case['slots'],
        window_weeks=case['window'],
        band=case['bands'],
        blocked=case['blocked'],
        soft=case['soft'],
        balances=case['balances'],
        prior=case['prior'],
        manual=case['manual'],
        distribution_mode=case['mode'],
        participation_factors=case['factors'],
        coverage=case['coverage'],
        objective_mode=case['objective'],
        random_seed=seed,
    )
    # Audit 6: in lexicographic mode a later phase that found nothing in its
    # slice of the time used to throw away the roster the phases before it
    # had found, and return none at all (seeds 129 and 130 here).
    assert result['success'], f"seed {seed}: {result['diagnostics'].get('solver_status')}"
    slot_by_id = {s['id']: s for s in case['slots']}
    assignments = result['assignments']

    # One person per slot, only real slots and real people.
    taken = [a['slot_id'] for a in assignments]
    assert len(taken) == len(set(taken)), f'seed {seed}: a slot got two people'
    for a in assignments:
        assert a['slot_id'] in slot_by_id and a['person_id'] in case['people'], f'seed {seed}: unknown {a}'

    # Never on a blocked day.
    for a in assignments:
        assert (a['person_id'], a['slot_id']) not in case['blocked'], f'seed {seed}: ABSOLUUT broken {a}'

    # Window rule, with the previous period's tail and the shifts filled in
    # beforehand. 0 switches it off; 1 is one shift a week.
    if case['window'] >= 1:
        weeks = {p: [] for p in case['people']}
        for a in assignments:
            weeks[a['person_id']].append(week_ordinal(slot_by_id[a['slot_id']]['datum']))
        for fixed in case['prior'] + case['manual']:
            weeks[fixed['person_id']].append(week_ordinal(fixed['datum']))
        for p, ws in weeks.items():
            ws.sort()
            solver_weeks = {week_ordinal(slot_by_id[a['slot_id']]['datum']) for a in assignments if a['person_id'] == p}
            for x, y in zip(ws, ws[1:]):
                # Two fixed shifts too close together are the planner's own doing, not the solver's.
                if x in solver_weeks or y in solver_weeks:
                    assert y - x >= case['window'], f'seed {seed}: {p} has shifts {y - x} week(s) apart, window {case["window"]}'

    # Never above the maximum.
    for p in case['people']:
        for t in TELLERS:
            count = sum(1 for a in assignments if a['person_id'] == p and slot_by_id[a['slot_id']]['shift_type_name'] == t)
            if count:
                limit = max(band_max(case, p, t), 0) + MAX_BAND_OVERSHOOT
                assert count <= limit, f'seed {seed}: {p} has {count} {t}, maximum {limit}'

    # Empty slots are reported, and only those.
    unfilled = {u['slot_id'] for u in result['diagnostics']['unfilled_slots']}
    assert unfilled == set(slot_by_id) - set(taken), f'seed {seed}: unfilled report does not match'


# Audit 6: window_weeks = 1 used to switch the rule off (constraints.py,
# lib/windowRule.ts), while the capacity check and the constraint's own
# docstring read it as one shift a week - the random test above found three
# avonddiensten on three days in one week (seed 2).
def test_a_window_of_one_week_means_at_most_one_shift_a_week():
    slots = []
    for i, d in enumerate(['2027-01-04', '2027-01-05', '2027-01-06']):
        slots.append({
            'id': f's{i}', 'datum': d, 'iso_jaar': 2027, 'iso_week': 1, 'shift_type_id': 'st',
            'shift_type_name': 'AVOND', 'benodigd_aantal_personen': 1, 'is_feestdag': False, 'feestdag_groep': None,
        })
    result = solve(['p1'], slots, window_weeks=1)
    assert len(result['assignments']) <= 1

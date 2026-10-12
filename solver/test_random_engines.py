"""
Both engines, the same random periods, the same hard rules.

test_random_invariants.py throws random periods at CP-SAT with a single
pooled window. The planner can also pick the randomized planner
("Gerandomiseerde planner", greedy.py) and can set separate windows for
avond- and weekend/feestdagdiensten, a holiday spread and fellows (a fixed
weekend band, band_overrides). This file generates periods with all of
those and checks both engines' output against the rules from the outside:

- a slot gets at most one person, and only one it exists for;
- nobody lands on a day they blocked;
- the pooled window, or with per-teller windows the smaller of the two
  between any two shifts and each group's own window within the group,
  counting the previous period's tail and shifts filled in beforehand;
- no two feestdagdiensten within the holiday spread;
- nobody ends above their streefbereik maximum (a fellow's override
  included);
- the unfilled report matches what is really empty.

And one comparison between them: CP-SAT weighs an empty slot far above
anything else, so when it proves its answer optimal it never leaves more
slots empty than the randomized planner managed on the same input.

Seeded, so a failure names the seed that reproduces it.
"""

import math
import random
from datetime import date, timedelta

import pytest

from greedy import run_greedy_construction
from test_solver import solve

TELLERS = ['AVOND', 'WEEKEND', 'FEESTDAG']


def week_ordinal(datum: str) -> int:
    d = date.fromisoformat(datum)
    return (d - timedelta(days=d.isoweekday() - 1)).toordinal() // 7


def random_case(rng: random.Random):
    weeks = rng.randint(2, 9)
    # Every start week of the year, the turn of the year included.
    start = date.fromisocalendar(rng.choice([2026, 2027, 2030]), rng.randint(1, 52), 1)
    people = [f'p{i}' for i in range(rng.randint(2, 10))]
    slots = []
    for day in range(weeks * 7):
        d = start + timedelta(days=day)
        if rng.random() < 0.1:
            teller = 'FEESTDAG'
        elif d.isoweekday() >= 6:
            teller = 'WEEKEND'
        else:
            teller = 'AVOND'
        if rng.random() < 0.6:
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

    blocked = {(p, s['id']) for p in people for s in slots if rng.random() < rng.choice([0.0, 0.1, 0.3])}

    per_teller = rng.random() < 0.5
    window = rng.choice([0, 1, 2, 3])
    window_avond = rng.choice([0, 1, 2, 3]) if per_teller else None
    window_wf = rng.choice([0, 1, 2, 4]) if per_teller else None
    spread = rng.choice([0, 0, 2, 3])

    prior = []
    for p in people:
        if rng.random() < 0.3:
            prior.append({
                'person_id': p,
                'datum': (start - timedelta(weeks=rng.randint(1, 3))).isoformat(),
                'teller': rng.choice(TELLERS),
            })
    manual = []
    for s in list(slots):
        if rng.random() < 0.05:
            manual.append({'person_id': rng.choice(people), 'datum': s['datum'], 'teller': s['shift_type_name']})
            slots.remove(s)

    def band():
        lo = rng.randint(0, 3)
        return [lo, lo + rng.randint(0, 3)]

    bands = {t: band() for t in TELLERS}
    balances = {p: {t: rng.choice([0, 0, 0, -1, 1]) for t in TELLERS} for p in people}
    coverage = {p: rng.choice([1.0, 1.0, 0.5]) for p in people}
    factors = {p: rng.choice([1.0, 1.0, 0.5]) for p in people}
    mode = rng.choice(['GELIJK', 'NAAR_RATO'])
    overrides = {}
    for p in people:
        if rng.random() < 0.15:
            overrides[p] = {'WEEKEND': (0, rng.randint(0, 3))}
    return dict(
        people=people, slots=slots, blocked=blocked, window=window, window_avond=window_avond,
        window_wf=window_wf, spread=spread, prior=prior, manual=manual, bands=bands, balances=balances,
        coverage=coverage, factors=factors, mode=mode, overrides=overrides,
    )


def band_max(case, person, teller):
    """The total maximum, worked out from the inputs as the documentation describes it."""
    override = case['overrides'].get(person, {}).get(teller)
    if override is not None:
        return override[1]
    lo, hi = case['bands'][teller]
    c = case['coverage'][person]
    lo, hi = math.floor(lo * c), max(math.floor(lo * c), math.ceil(hi * c))
    if case['mode'] == 'NAAR_RATO':
        f = case['factors'][person]
        lo, hi = math.floor(lo * f), max(math.floor(lo * f), math.ceil(hi * f))
    return hi + case['balances'][person][teller]


def group(teller):
    return 'AVOND' if teller == 'AVOND' else 'WF'


def check(case, result, label):
    slot_by_id = {s['id']: s for s in case['slots']}
    assignments = result['assignments']
    taken = [a['slot_id'] for a in assignments]
    assert len(taken) == len(set(taken)), f'{label}: a slot got two people'
    for a in assignments:
        assert a['slot_id'] in slot_by_id and a['person_id'] in case['people'], f'{label}: unknown {a}'
        assert (a['person_id'], a['slot_id']) not in case['blocked'], f'{label}: ABSOLUUT broken {a}'

    # Every shift of a person: (week, teller, made by the engine?)
    shifts = {p: [] for p in case['people']}
    for a in assignments:
        s = slot_by_id[a['slot_id']]
        shifts[a['person_id']].append((week_ordinal(s['datum']), s['shift_type_name'], True))
    for fixed in case['prior'] + case['manual']:
        shifts[fixed['person_id']].append((week_ordinal(fixed['datum']), fixed['teller'], False))

    def required_gap(t1, t2):
        if case['window_avond'] is None and case['window_wf'] is None:
            return case['window']
        own = {'AVOND': case['window_avond'] or 0, 'WF': case['window_wf'] or 0}
        floor = min(own['AVOND'], own['WF'])
        return max(floor, own[group(t1)]) if group(t1) == group(t2) else floor

    for p, items in shifts.items():
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                (w1, t1, e1), (w2, t2, e2) = items[i], items[j]
                if not (e1 or e2):
                    continue  # two fixed facts: the planner's own doing
                gap = required_gap(t1, t2)
                if gap >= 1:
                    assert abs(w1 - w2) >= gap, f'{label}: {p} has {t1}/{t2} {abs(w1 - w2)} week(s) apart, window {gap}'
                if case['spread'] > 1 and t1 == 'FEESTDAG' and t2 == 'FEESTDAG':
                    assert abs(w1 - w2) >= case['spread'], f'{label}: {p} has two feestdagdiensten {abs(w1 - w2)} week(s) apart'

    for p in case['people']:
        for t in TELLERS:
            mine = sum(1 for a in assignments if a['person_id'] == p and slot_by_id[a['slot_id']]['shift_type_name'] == t)
            if mine:
                fixed = sum(1 for m in case['manual'] if m['person_id'] == p and m['teller'] == t)
                assert mine + fixed <= max(band_max(case, p, t), fixed), f'{label}: {p} has {mine + fixed} {t}, maximum {band_max(case, p, t)}'

    unfilled = {u['slot_id'] for u in result['diagnostics']['unfilled_slots']}
    assert unfilled == set(slot_by_id) - set(taken), f'{label}: unfilled report does not match'


def run_cpsat(case, seed):
    return solve(
        case['people'], case['slots'], window_weeks=case['window'], band=case['bands'], blocked=case['blocked'],
        balances=case['balances'], prior=case['prior'], manual=case['manual'], distribution_mode=case['mode'],
        participation_factors=case['factors'], coverage=case['coverage'], holiday_spread_weeks=case['spread'],
        objective_mode='weighted', random_seed=seed, window_weeks_avond=case['window_avond'],
        window_weeks_weekend_feestdag=case['window_wf'], band_overrides=case['overrides'],
    )


def run_greedy(case, seed, variant):
    return run_greedy_construction(
        people=case['people'], slots=case['slots'], blocked_slots=case['blocked'], soft_slots={},
        band_ranges={t: tuple(b) for t, b in case['bands'].items()}, balances=case['balances'],
        window_weeks=case['window'], prior_assignments=case['prior'], manual_assignments=case['manual'],
        distribution_mode=case['mode'], participation_factors=case['factors'], coverage_factors=case['coverage'],
        band_overrides=case['overrides'], holiday_spread_weeks=case['spread'], variant=variant,
        random_seed=seed, window_weeks_avond=case['window_avond'], window_weeks_weekend_feestdag=case['window_wf'],
    )


@pytest.mark.parametrize('seed', range(120))
def test_greedy_keeps_every_hard_rule(seed):
    case = random_case(random.Random(seed))
    for variant in ('medewerker', 'dagen'):
        check(case, run_greedy(case, seed, variant), f'seed {seed} greedy/{variant}')


@pytest.mark.parametrize('seed', range(120))
def test_cpsat_keeps_every_hard_rule_and_fills_at_least_as_much(seed):
    case = random_case(random.Random(seed))
    result = run_cpsat(case, seed)
    assert result['success'], f"seed {seed}: {result['diagnostics'].get('solver_status')}"
    check(case, result, f'seed {seed} cp-sat')
    if result['diagnostics'].get('solver_status') == 'OPTIMAL':
        greedy_empty = min(
            len(run_greedy(case, seed, v)['diagnostics']['unfilled_slots']) for v in ('medewerker', 'dagen')
        )
        assert len(result['diagnostics']['unfilled_slots']) <= greedy_empty, (
            f'seed {seed}: cp-sat left {len(result["diagnostics"]["unfilled_slots"])} empty, greedy {greedy_empty}'
        )

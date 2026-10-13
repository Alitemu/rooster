"""
Feestdagdiensten over the years.

The rule: what matters is how many feestdagdiensten everyone gets over
the years, not which feestdag (the planner's words). A period has few of
them, so everyone's band is 0 or 1, and the overloop only books what falls
outside a band: who got the one and who got none was forgotten. The app
now sends each person's target for this period - their fair share plus
what they are behind from every period before (lib/feestdagHistory.ts) -
and every planner gives the feestdagen to whoever is furthest behind,
within the bands, never on a blocked day, and before liever-niet.

Run: pytest solver/ -v
"""

from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from greedy import run_greedy_construction
from main import RuleSet, SolverInput
from solver import RosterSolver

PEOPLE = ['A', 'B', 'C', 'D']
ENGINES = ['weighted', 'lexicographic', 'greedy']
SEEDS = [1, 2, 3, 4, 5]


def feestdagen(n):
    """n feestdag slots, one per week, so no window or spread rule is in play."""
    base = date.fromisocalendar(2027, 10, 1)
    slots = []
    for i in range(n):
        d = base + timedelta(weeks=3 * i)
        iso_year, iso_week, _ = d.isocalendar()
        slots.append({
            'id': f'feestdag-{i + 1}',
            'datum': d.isoformat(),
            'iso_jaar': iso_year,
            'iso_week': iso_week,
            'shift_type_id': 'st-f',
            'shift_type_name': 'FEESTDAG',
            'benodigd_aantal_personen': 1,
            'is_feestdag': True,
            'feestdag_groep': 'PASEN',
        })
    return slots


def run(engine, slots, targets, band=(0, 1), blocked=None, soft=None, manual=None, seed=1):
    bands = {'AVOND': (0, 9), 'WEEKEND': (0, 9), 'FEESTDAG': band}
    balances = {p: {'AVOND': 0, 'WEEKEND': 0, 'FEESTDAG': 0} for p in PEOPLE}
    if engine == 'greedy':
        result = run_greedy_construction(
            people=PEOPLE, slots=slots, blocked_slots=blocked or set(), soft_slots=soft or {},
            band_ranges=bands, balances=balances, window_weeks=0, manual_assignments=manual or [],
            random_seed=seed, feestdag_targets=targets,
        )
    else:
        result = RosterSolver(time_limit_seconds=10).generate_roster(
            period_id='feestdag', people=PEOPLE, slots=slots, blocked_slots=blocked or set(),
            soft_slots=soft or {}, band_ranges=bands, balances=balances, window_weeks=0,
            manual_assignments=manual or [], objective_mode=engine, random_seed=seed,
            feestdag_targets=targets,
        )
    assert result['success']
    return {a['slot_id']: a['person_id'] for a in result['assignments']}


def counts(roster):
    return {p: sum(1 for who in roster.values() if who == p) for p in PEOPLE}


@pytest.mark.parametrize('engine', ENGINES)
@pytest.mark.parametrize('seed', SEEDS)
def test_the_ones_furthest_behind_get_the_feestdagen(engine, seed):
    # C and D are about a shift behind, A and B about even.
    roster = run(engine, feestdagen(2), {'A': 0.2, 'B': 0.4, 'C': 1.2, 'D': 0.6}, seed=seed)
    assert counts(roster) == {'A': 0, 'B': 0, 'C': 1, 'D': 1}


@pytest.mark.parametrize('engine', ENGINES)
def test_never_on_a_blocked_day(engine):
    slots = feestdagen(2)
    blocked = {('C', s['id']) for s in slots}
    roster = run(engine, slots, {'A': 0.0, 'B': 0.4, 'C': 2.0, 'D': 0.6}, blocked=blocked)
    assert 'C' not in roster.values()
    assert len(roster) == 2


@pytest.mark.parametrize('engine', ENGINES)
def test_never_past_a_band(engine):
    # C is three behind, but the band allows one this period.
    roster = run(engine, feestdagen(3), {'A': 0.0, 'B': 0.6, 'C': 3.0, 'D': 0.7})
    assert counts(roster)['C'] == 1
    assert len(roster) == 3


@pytest.mark.parametrize('engine', ['weighted', 'lexicographic'])
def test_before_liever_niet_and_liever_niet_among_equals(engine):
    # C is behind and marked the first one liever niet: C still gets a
    # feestdag (else marking every one liever niet keeps them off one's
    # count for years), just the other one.
    slots = feestdagen(2)
    roster = run(engine, slots, {'A': 0.0, 'B': 0.0, 'C': 1.0, 'D': 1.0}, soft={('C', 'feestdag-1'): 1.0})
    assert roster == {'feestdag-1': 'D', 'feestdag-2': 'C'}


@pytest.mark.parametrize('engine', ENGINES)
def test_a_feestdag_filled_in_by_hand_counts(engine):
    # C had one filled in by hand this period: that pays off C's one, so
    # the remaining feestdag goes to D.
    slots = feestdagen(2)
    manual = [{'person_id': 'C', 'datum': slots[0]['datum'], 'teller': 'FEESTDAG'}]
    roster = run(engine, slots[1:], {'A': 0.0, 'B': 0.0, 'C': 1.0, 'D': 0.8}, manual=manual)
    assert roster == {'feestdag-2': 'D'}


def _input(**extra):
    return SolverInput(period_id='p1', slots=[], person_preferences={}, people=['a'], rules=RuleSet(), balances={}, **extra)


def test_a_target_must_be_a_number_of_shifts():
    with pytest.raises(ValidationError):
        _input(feestdag_targets={'a': 1e9})
    _input(feestdag_targets={'a': -1.5})  # ahead: must not raise
    assert _input().feestdag_targets == {}  # a caller that predates it

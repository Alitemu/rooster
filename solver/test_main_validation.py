"""
Pydantic validation tests for main.py's request models.

Convention (CLAUDE.md): one hard rule = one test that proves it cannot be
broken. These input models are the solver's HTTP API boundary, so malformed
input must be rejected there (422) rather than reaching the CP-SAT model and
either crashing into a generic 'ERROR' status or silently solving the wrong
problem (e.g. a penalty that should discourage something instead rewarding
it).

Run: pytest solver/ -v
"""

import pytest
from pydantic import ValidationError

from main import RuleSet, Slot, SolverInput


def test_reversed_band_is_rejected():
    """band min must be <= band max - a reversed tuple used to be accepted
    silently and gave everyone simultaneous under- and over-band slack."""
    with pytest.raises(ValidationError):
        RuleSet(band_avond=(9, 7))


def test_negative_band_is_rejected():
    with pytest.raises(ValidationError):
        RuleSet(band_weekend=(-1, 5))


def test_ordered_band_is_accepted():
    RuleSet(band_feestdag=(1, 3))  # must not raise


def test_negative_soft_block_penalty_is_rejected():
    """A negative penalty would turn LIEVER_NIET into a reward."""
    with pytest.raises(ValidationError):
        RuleSet(soft_block_penalty=-1.0)


def test_negative_band_deviation_penalty_tier_is_rejected():
    """A negative tier would turn band-slack cost into a reward for some
    deviation levels while staying a cost for others."""
    with pytest.raises(ValidationError):
        RuleSet(band_deviation_penalty=[5.0, -1.0])


def test_zero_band_deviation_penalty_tier_is_rejected():
    """A tier of exactly 0 (not just negative) would make that unit of band
    deviation free - and since tier_cost() extrapolates every tier beyond
    the configured list from the last one, a trailing 0 makes ALL further
    deviation free too, silently disabling the fairness enforcement the
    solver exists for while VOORKEUR's hardcoded 0.3 reward stays active -
    inverting the documented shortfall > band_slack > soft > preferred
    weight hierarchy via ruleset config alone, no code change needed."""
    with pytest.raises(ValidationError):
        RuleSet(band_deviation_penalty=[0.0])


def test_empty_band_deviation_penalty_is_rejected():
    """An empty list used to be silently replaced by the [5.0] default
    deeper in objective.py's `penalty_tiers or [5.0]` - accepted here but
    not doing what was explicitly asked for."""
    with pytest.raises(ValidationError):
        RuleSet(band_deviation_penalty=[])


def test_duplicate_slot_id_is_rejected():
    """
    constraints.py/objective.py key every assignment variable and
    capacity/band constraint on slot.id - two slot records sharing an id
    (e.g. a caller-side query bug) would otherwise silently overwrite each
    other's assignment variable and double-count that assignment in
    capacity/band totals, instead of erroring cleanly at the boundary.
    """
    duplicate = Slot(id='slot-1', datum='2027-01-04', iso_jaar=2027, iso_week=1,
                      shift_type_id='st-1', shift_type_name='AVOND')
    with pytest.raises(ValidationError):
        SolverInput(
            period_id='p1',
            slots=[duplicate, duplicate.model_copy()],
            person_preferences={},
            people=['person-1'],
            rules=RuleSet(),
            balances={},
        )


def test_band_deviation_multiplier_below_one_is_rejected():
    """multiplier<1 makes tiers beyond the configured list de-escalate
    instead of escalate, undoing the tiered pricing's whole point."""
    with pytest.raises(ValidationError):
        RuleSet(band_deviation_multiplier=0.5)


def test_band_deviation_multiplier_of_exactly_one_is_accepted():
    RuleSet(band_deviation_multiplier=1.0)  # must not raise - flat pricing


def test_negative_window_weeks_is_rejected():
    with pytest.raises(ValidationError):
        RuleSet(window_weeks=-1)


def test_negative_holiday_spread_weeks_is_rejected():
    with pytest.raises(ValidationError):
        RuleSet(holiday_spread_weeks=-1)


def _slot_kwargs(**overrides):
    base = dict(
        id='s1', datum='2027-01-04', iso_jaar=2027, iso_week=1,
        shift_type_id='st-1', shift_type_name='AVOND',
    )
    base.update(overrides)
    return base


def test_zero_benodigd_aantal_personen_is_rejected():
    """0 (or negative) reaches NewIntVar(0, required, ...) with an invalid
    domain in constraints.add_capacity_constraints - previously raised
    inside CP-SAT and was swallowed into a generic ERROR status."""
    with pytest.raises(ValidationError):
        Slot(**_slot_kwargs(benodigd_aantal_personen=0))


def test_positive_benodigd_aantal_personen_is_accepted():
    Slot(**_slot_kwargs(benodigd_aantal_personen=2))  # must not raise

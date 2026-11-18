"""
The independent check (controle.py) itself: a roster made wrong on purpose
is caught, per rule. Without this a check that misses a rule would let the
other tests pass however the model breaks it.
"""

import pytest

import controle
import main
from test_hulp import aios, blok, dag, dienst, markeer, weken


def _fouten(inp, toewijzingen):
    slots, blok_vorm, mensen, feestdagen = main.naar_model(main.SolveInput(**inp))
    return {r for r, _, _ in controle.controleer(slots, blok_vorm, mensen, feestdagen, toewijzingen)}


def _aan(ids, wie='x'):
    return {i: wie for i in ids}


def test_a_good_roster_passes():
    inp = weken(2)
    aios(inp, 'x')
    assert _fouten(inp, _aan(blok(inp, 'NACHT', 'ZO_DI', dag(4)) + [dienst('UD', dag(9))])) == set()


@pytest.mark.parametrize(
    'naam, maak, regel',
    [
        ('half a block', lambda i: _aan(blok(i, 'AVOND', 'ZO_DI', dag(4))[:2]), '2_BLOK_HEEL'),
        ('two the same day', lambda i: _aan([dienst('UD', dag(0)), dienst('ND', dag(0))]), '3_TWEE_OP_EEN_DAG'),
        ('the Wednesday after an evening block', lambda i: _aan(blok(i, 'AVOND', 'ZO_DI', dag(4)) + [dienst('UD', dag(7))]), '7_COMPENSATIEDAG'),
        ('the Thursday after a night block', lambda i: _aan(blok(i, 'NACHT', 'ZO_DI', dag(4)) + [dienst('UD', dag(8))]), '7_COMPENSATIEDAG'),
        ('the Friday before a Saturday dagdienst', lambda i: _aan([dienst('UD', dag(2)), dienst('DD', dag(3))]), '7_COMPENSATIEDAG'),
        ('the Monday after a Sunday dagdienst', lambda i: _aan([dienst('DD', dag(4)), dienst('UD', dag(5))]), '7_COMPENSATIEDAG'),
        ('two loose weekend diensten', lambda i: _aan([dienst('DD', dag(3)), dienst('DD', dag(4))]), 'TWEE_DD_ZONDER_WENS'),
        ('a Saturday evening and the Sunday dagdienst', lambda i: _aan(blok(i, 'AVOND', 'ZA', dag(3)) + [dienst('DD', dag(4))]), 'WEEKEND_TWEE_LOSSE_DIENSTEN'),
        ('a block of four not asked for', lambda i: _aan(blok(i, 'AVOND', 'WO_VR', dag(0)) + blok(i, 'AVOND', 'ZA', dag(3))), 'VIER_ZONDER_WENS'),
    ],
)
def test_a_broken_rule_is_caught(naam, maak, regel):
    inp = weken(2)
    aios(inp, 'x')
    assert regel in _fouten(inp, maak(inp)), naam


def test_rest_14_hours_and_46_after_a_night_block():
    feestdag = dag(1)
    inp = weken(2, {feestdag, dag(7)})
    aios(inp, 'x')
    # An uitloopdienst until 20:00, the feestdag's dagdienst at 08:30.
    assert '9_RUST' in _fouten(inp, _aan([dienst('UD', dag(0)), dienst('DD', feestdag)]))
    # A night block ending on a feestdag Wednesday, its dagdienst that morning.
    assert '9_RUST' in _fouten(inp, _aan(blok(inp, 'NACHT', 'ZO_DI', dag(4)) + [dienst('DD', dag(7))]))


def test_per_aios_rules_are_caught():
    inp = weken(1)
    aios(
        inp,
        'x',
        fte=1.0,
        beschikbaar=[{'van': dag(0).isoformat(), 'tot': dag(4).isoformat()}],
        parttime_dagen=[dag(0).isoformat()],
        inwerken={'van': dag(1).isoformat(), 'tot': dag(1).isoformat()},
        onderbreking={'van': dag(2).isoformat(), 'tot': dag(2).isoformat()},
    )
    assert '4_PARTTIMEDAG' in _fouten(inp, _aan([dienst('UD', dag(0))]))
    assert '6_INWERKEN' in _fouten(inp, _aan(blok(inp, 'NACHT', 'WO_VR', dag(0))))
    assert '1_ONDERBREKING' in _fouten(inp, _aan([dienst('UD', dag(2))]))
    assert '1_BUITEN_LIDMAATSCHAP' in _fouten(inp, _aan([dienst('UD', dag(5))]))
    assert '5_FULLTIME_NACHTBLOK' in _fouten(inp, _aan(blok(inp, 'NACHT', 'ZO_DI', dag(4))))


def test_rule_5_from_0_9_fte():
    inp = weken(1)
    x = aios(inp, 'x')
    nacht = _aan(blok(inp, 'NACHT', 'ZO_DI', dag(4)))
    for fte, fout in ((1.0, True), (0.9, True), (0.89, False), (0.8, False)):
        x['fte'] = fte
        assert ('5_FULLTIME_NACHTBLOK' in _fouten(inp, nacht)) is fout, fte


def test_blocks_by_hand_and_the_part_above_half():
    inp = weken(2)
    x = aios(inp, 'x', erboven={'NACHTBLOKKEN': 1})
    een, twee = blok(inp, 'NACHT', 'WO_VR', dag(0)), blok(inp, 'NACHT', 'WO_VR', dag(7))
    markeer(x, een + twee, 'ABSOLUUT')
    markeer(x, [dienst('UD', dag(5))], 'ABSOLUUT', 'ABSENCE')
    assert _fouten(inp, _aan(een)) == set(), 'one from the part above half'
    assert '1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT' in _fouten(inp, _aan(een + twee))
    assert '1_AFWEZIG_OF_PARTTIME' in _fouten(inp, _aan([dienst('UD', dag(5))]))

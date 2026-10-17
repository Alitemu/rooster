"""
The soft rules of the AIOS roster (docs/aios-rooster.md, "Eerlijkheid" and
"Blokken"): the same dienstpercentage for everyone (points to fte and the
werkdagen someone can do diensten on), the nights, evenings and
dagdiensten each to their share, the feestdagen over the years, liever
niet and voorkeur where fairness leaves the choice (the planner's choice:
as the achterwacht's, fairness first), and one block in four weeks.
"""

from test_hulp import aios, blok, dag, los_op, markeer, van, weken


def _per(uit, aios_id):
    return next(p for p in uit.per_aios if p.aios_id == aios_id)


def _meer(inp, n):
    """Enough AIOS to fill everything, so fairness and the wishes have room."""
    for i in range(n):
        aios(inp, f'a{i:02d}')
    # Not proven best within this, but good: the tests check what matters.
    inp['tijdslimiet_seconden'] = 8


def test_everyone_the_same_percentage_to_their_fte():
    inp = weken(2)
    aios(inp, 'x', fte=1.0)
    aios(inp, 'y', fte=0.5)
    aios(inp, 'z', fte=1.0)
    _meer(inp, 9)
    uit, _ = los_op(inp)
    assert not uit.leeg
    x, y, z = (_per(uit, n) for n in 'xyz')
    # 1.0 and 0.5 fte: twice the points, give or take one dienst.
    assert abs(x.punten - z.punten) <= 1.0
    assert abs(x.punten - 2 * y.punten) <= 2.0
    # 0.1 itself counts: 0.35 - 0.25 comes out as 0.10000000000000003.
    assert abs(x.dienstpercentage - y.dienstpercentage) <= 0.1 + 1e-9


def test_an_onderbreking_lowers_the_share():
    inp = weken(2)
    aios(inp, 'x')
    aios(inp, 'y', onderbreking={'van': dag(7).isoformat(), 'tot': dag(13).isoformat()})
    uit, _ = los_op(inp)
    x, y = _per(uit, 'x'), _per(uit, 'y')
    assert y.werkdagen < x.werkdagen
    assert y.doel_punten < x.doel_punten


def test_a_saldo_carries_over():
    # y did more last quarter (a delta below zero: fewer now).
    inp = weken(2)
    aios(inp, 'x')
    aios(inp, 'y', saldo_punten=-2)
    _meer(inp, 8)
    uit, _ = los_op(inp)
    x, y = _per(uit, 'x'), _per(uit, 'y')
    assert y.doel_punten == round(x.doel_punten - 2, 2)
    assert y.punten < x.punten


def _twee_gelijke_blokken(niveau, welke):
    # x and y alike, two night blocks alike: fairness gives each one, and
    # which one is the mark's to decide. Once for either block, so a tie
    # broken the same way without the mark can't pass both.
    inp = weken(3)
    blokken = [blok(inp, 'NACHT', 'ZO_DI', dag(4)), blok(inp, 'NACHT', 'ZO_DI', dag(18))]
    alle = blokken[0] + blokken[1]
    x, y = aios(inp, 'x'), aios(inp, 'y')
    for a in (x, y):
        markeer(a, [d['id'] for d in inp['diensten'] if d['id'] not in alle], 'ABSOLUUT', 'ABSENCE')
    markeer(x, blokken[welke], niveau)
    _, t = los_op(inp)
    return van(t, 'x'), blokken


def test_liever_niet_decides_where_fairness_leaves_the_choice():
    for welke in (0, 1):
        mijn, blokken = _twee_gelijke_blokken('LIEVER_NIET', welke)
        assert mijn == set(blokken[1 - welke])


def test_voorkeur_decides_where_fairness_leaves_the_choice():
    for welke in (0, 1):
        mijn, blokken = _twee_gelijke_blokken('VOORKEUR', welke)
        assert mijn == set(blokken[welke])


def test_feestdagen_go_to_who_had_fewer_over_the_years():
    # Once each way round, so a tie broken the same way can't pass both.
    for meer, minder in (('x', 'y'), ('y', 'x')):
        feestdag = dag(1)
        inp = weken(1, {feestdag})
        aios(inp, 'x', feestdag_achterstand=2 if meer == 'x' else -2)
        aios(inp, 'y', feestdag_achterstand=2 if meer == 'y' else -2)
        uit, _ = los_op(inp)
        assert _per(uit, meer).doel_feestdagdiensten > _per(uit, minder).doel_feestdagdiensten
        assert _per(uit, meer).feestdagdiensten > _per(uit, minder).feestdagdiensten


def test_one_block_in_four_weeks_where_it_can():
    # Eight weekly evening blocks for two AIOS, each wanting four in a row:
    # spread out, every other week, not four or three in a row.
    inp = weken(8)
    blokken = [blok(inp, 'AVOND', 'WO_VR', dag(7 * w)) for w in range(8)]
    alle = [i for b in blokken for i in b]
    for naam, eigen in (('x', range(0, 4)), ('y', range(4, 8))):
        a = aios(inp, naam)
        markeer(a, [d['id'] for d in inp['diensten'] if d['id'] not in alle], 'ABSOLUUT', 'ABSENCE')
        markeer(a, [i for w in eigen for i in blokken[w]], 'VOORKEUR')
    _, t = los_op(inp)
    for naam in 'xy':
        weken_ = sorted({w for w, b in enumerate(blokken) if set(b) <= van(t, naam)})
        assert len(weken_) == 4, (naam, weken_)
        # Every other week, not two weeks running.
        assert all(b - a >= 2 for a, b in zip(weken_, weken_[1:])), (naam, weken_)


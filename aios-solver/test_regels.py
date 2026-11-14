"""
One test per hard rule of the AIOS roster (docs/aios-rooster.md, "Harde
regels"), each built so that breaking the rule would be worth it to the
solver: the AIOS it forbids is the only one who could fill the dienst, or
gains points by it. Every solve also goes through the independent check
(controle.py, in test_hulp.los_op). scripts/mutation-check.mjs breaks each
rule in model.py and expects one of these to fail.
"""

import time
from datetime import date

import pytest

import kalender
import main
import model
from test_hulp import START, aios, blok, dag, dienst, los_op, markeer, van, weken


def _datum(dienst_id: str) -> date:
    return date.fromisoformat(dienst_id.split('-', 1)[1])


def _alleen(inp: dict, a: dict, ids: list[str]) -> None:
    """Away (leave, never to be taken) on everything but these diensten."""
    markeer(a, [d['id'] for d in inp['diensten'] if d['id'] not in ids], 'ABSOLUUT', 'ABSENCE')


def _model(inp: dict) -> model.Uitkomst:
    slots, blok_vorm, mensen, feestdagen = main.naar_model(main.SolveInput(**inp))
    return model.oplossen(slots, blok_vorm, mensen, START, date.fromisoformat(inp['periode']['tot']), feestdagen, tijdslimiet=20)


# ---- rule 1 -----------------------------------------------------------------


def test_regel_1_nothing_outside_geldig_vanaf_tot():
    inp = weken(1)
    aios(inp, 'x', beschikbaar=[{'van': dag(0).isoformat(), 'tot': dag(2).isoformat()}])
    uit, t = los_op(inp)
    assert van(t, 'x'), 'x should still get the days they are there'
    assert all(_datum(d) <= dag(2) for d in van(t, 'x'))
    assert any('BUITEN_LIDMAATSCHAP' in leeg.redenen for leeg in uit.leeg)


def test_regel_1_nothing_during_an_onderbreking():
    inp = weken(1)
    aios(inp, 'x', onderbreking={'van': dag(3).isoformat(), 'tot': dag(6).isoformat()})
    _, t = los_op(inp)
    assert van(t, 'x')
    assert all(not (dag(3) <= _datum(d) <= dag(6)) for d in van(t, 'x'))


def test_regel_1_leave_is_never_taken_not_even_above_half():
    inp = weken(1)
    x = aios(inp, 'x', erboven={'NACHTBLOKKEN': 3})
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    markeer(x, nacht, 'ABSOLUUT', 'ABSENCE')
    _alleen(inp, x, nacht)
    uit, t = los_op(inp)
    assert not van(t, 'x') & set(nacht)
    assert uit.per_aios[0].boven_de_helft == 0


def test_regel_1_a_block_by_hand_holds_when_not_above_half():
    inp = weken(1)
    x = aios(inp, 'x')
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    markeer(x, nacht, 'ABSOLUUT')
    _alleen(inp, x, nacht)
    uit, t = los_op(inp)
    assert not van(t, 'x') & set(nacht)
    assert uit.leeg and all(leeg.redenen == {'GEBLOKKEERD': 1} for leeg in uit.leeg if leeg.dienst_id in nacht)


def test_regel_1_above_half_at_most_the_part_above_half_is_taken():
    # Four blocked night blocks, the only thing x could do; one may go.
    inp = weken(2)
    x = aios(inp, 'x', fte=0.8, erboven={'NACHTBLOKKEN': 1})
    nachten = [i for vorm, d in (('WO_VR', 0), ('ZO_DI', 4), ('WO_VR', 7), ('ZO_DI', 11)) for i in blok(inp, 'NACHT', vorm, dag(d))]
    markeer(x, nachten, 'ABSOLUUT')
    _alleen(inp, x, nachten)
    uit, t = los_op(inp)
    assert len(van(t, 'x')) == 3, 'one block of three nights, from the part above half'
    assert uit.per_aios[0].boven_de_helft == 1


# ---- rule 2 -----------------------------------------------------------------


def test_regel_2_every_dienst_at_most_one_aios():
    inp = weken(1)
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    for naam in ('x', 'y'):
        _alleen(inp, aios(inp, naam), nacht)
    u = _model(inp)
    gekregen = [s.id for opties in u.opties.values() for o in opties for s in o.slots]
    assert sorted(gekregen) == sorted(nacht), 'the block once, to one of them'


def test_regel_2_a_block_stays_whole():
    # x can't do the Monday, y can't do the Sunday: whole, neither can.
    inp = weken(1)
    avond = blok(inp, 'AVOND', 'ZO_DI', dag(4))
    x, y = aios(inp, 'x'), aios(inp, 'y')
    _alleen(inp, x, [i for i in avond if _datum(i) != dag(5)])
    _alleen(inp, y, [i for i in avond if _datum(i) != dag(4)])
    uit, t = los_op(inp)
    assert not set(t) & set(avond)
    assert {leeg.dienst_id for leeg in uit.leeg} >= set(avond)


# ---- rule 3 -----------------------------------------------------------------


def test_regel_3_one_dienst_a_day():
    inp = weken(1)
    aios(inp, 'x')
    _, t = los_op(inp)
    dagen = [_datum(d) for d in van(t, 'x')]
    assert len(dagen) == len(set(dagen))


# ---- rule 4 -----------------------------------------------------------------


def test_regel_4_no_uitloopdienst_on_a_part_time_day():
    inp = weken(1)
    x = aios(inp, 'x', parttime_dagen=[dag(5).isoformat()])  # a Monday
    _alleen(inp, x, [dienst('UD', dag(5)), dienst('UD', dag(6))])
    uit, t = los_op(inp)
    assert t == {dienst('UD', dag(6)): 'x'}, 'the Tuesday, never the Monday'
    assert next(leeg for leeg in uit.leeg if leeg.dienst_id == dienst('UD', dag(5))).redenen == {'PARTTIMEDAG': 1}


def test_regel_4_the_evening_block_over_a_part_time_day_may_as_liever_niet():
    # Since 0.82.0 (the planner's choice): the app marks the evening of a
    # part-time day liever niet. The solver may take it, as a last resort:
    # another AIOS first.
    inp = weken(1)
    avond = blok(inp, 'AVOND', 'ZO_DI', dag(4))
    x = aios(inp, 'x', parttime_dagen=[dag(5).isoformat()])
    markeer(x, [dienst('AD', dag(5))], 'LIEVER_NIET', 'PARTTIME')
    _alleen(inp, x, avond)
    _, t = los_op(inp)
    assert van(t, 'x') == set(avond), 'only x can: then x'
    y = aios(inp, 'y')
    _alleen(inp, y, avond)
    _, t = los_op(inp)
    assert van(t, 'y') == set(avond), 'y can too: y, not x on a part-time day'


def test_regel_4_the_night_block_over_a_part_time_day_may():
    inp = weken(1)
    x = aios(inp, 'x', parttime_dagen=[dag(5).isoformat()])
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    _alleen(inp, x, nacht)
    _, t = los_op(inp)
    assert van(t, 'x') == set(nacht)


# ---- rule 5 -----------------------------------------------------------------


def test_regel_5_from_0_9_fte_never_in_the_night_block_sunday_to_tuesday():
    inp = weken(1)
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    _alleen(inp, aios(inp, 'x', fte=1.0), nacht)
    for fte in (1.0, 0.9):
        inp['aios'][0]['fte'] = fte
        _, t = los_op(inp)
        assert not t, fte
    for fte in (0.89, 0.8):
        inp['aios'][0]['fte'] = fte
        _, t = los_op(inp)
        assert set(t) == set(nacht), fte


def test_regel_5_a_night_block_cut_up_is_single_nights_0_9_fte_may_do():
    # Around feestdagen in a row the planner may cut the block up
    # (docs/aios-rooster.md, "Blokken rond feestdagen"): then each night is
    # a single dienst with one compensation day, no longer the block.
    inp = weken(1)
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    next(b for b in inp['blokken'] if b['id'] == f'NZO_DI-{dag(4).isoformat()}')['vorm'] = 'LOS'
    _alleen(inp, aios(inp, 'x', fte=1.0), nacht[:1])
    _, t = los_op(inp)
    assert t == {nacht[0]: 'x'}


# ---- rule 6 -----------------------------------------------------------------


def test_regel_6_inwerken_only_uitloopdiensten_and_weekend_dagdiensten():
    feestdag = dag(1)  # a Thursday: its dagdienst is not for who inwerkt
    inp = weken(1, {feestdag})
    aios(inp, 'x', inwerken={'van': dag(0).isoformat(), 'tot': dag(6).isoformat()})
    _, t = los_op(inp)
    mijn = van(t, 'x')
    assert mijn, 'x does get uitloop- and weekend dagdiensten'
    for d in mijn:
        code, datum = d.split('-', 1)[0], _datum(d)
        assert code == 'UD' or (code == 'DD' and datum.weekday() >= 5), d
    assert dienst('DD', feestdag) not in mijn


def test_regel_6_inwerken_not_the_dagdienst_of_a_feestdag_in_the_week():
    feestdag = dag(1)
    inp = weken(1, {feestdag})
    x = aios(inp, 'x', inwerken={'van': dag(0).isoformat(), 'tot': dag(6).isoformat()})
    _alleen(inp, x, [dienst('DD', feestdag), dienst('DD', dag(3))])
    _, t = los_op(inp)
    assert van(t, 'x') == {dienst('DD', dag(3))}


# ---- rules 7 and 8 ------------------------------------------------------------


def test_regel_7_nothing_on_a_compensation_day():
    inp = weken(2)
    aios(inp, 'x')
    los_op(inp)  # controle checks every compensation day


def test_regel_7_the_evening_block_sunday_to_tuesday_keeps_its_wednesday():
    # Only the compensation day stops x: the rest after 23:12 would allow 17:36.
    inp = weken(2)
    x = aios(inp, 'x')
    avond = blok(inp, 'AVOND', 'ZO_DI', dag(4))
    _alleen(inp, x, avond + [dienst('UD', dag(7))])
    _, t = los_op(inp)
    assert len(van(t, 'x') & (set(avond) | {dienst('UD', dag(7))})) == 3, 'the block, not the Wednesday next to it'


@pytest.mark.parametrize(
    'soort, vorm, eerste, laatste, feestdag, verwacht',
    [
        # The design's own examples (docs/aios-rooster.md, rule 8).
        ('DAG', 'ENKEL', 'za', 'za', 'vr', ['do', 'ma']),  # Koningsdag on the Friday before
        ('DAG', 'ENKEL', 'zo', 'zo', 'ma', ['vr', 'di']),  # Tweede Paasdag on the Monday after
        ('NACHT', 'ZO_DI', 'zo', 'di', 'do+', ['wo+', 'vr+']),  # Hemelvaart on the Thursday after
        ('NACHT', 'ZO_DI', 'zo', 'di', 'wo+', ['do+', 'vr+']),  # the block ends on a feestdag Wednesday
        ('NACHT', 'ZO_DI', 'zo', 'di', None, ['wo+', 'do+']),
        ('AVOND', 'ZO_DI', 'zo', 'di', None, ['wo+']),
        ('AVOND', 'WO_VR', 'wo', 'vr', None, ['za', 'zo']),
        ('AVOND', 'VIER', 'wo', 'za', None, ['zo']),
        ('NACHT', 'VIER', 'wo', 'za', None, ['zo', 'ma']),
        ('NACHT', 'ZA', 'za', 'za', None, ['vr', 'zo', 'ma']),
        ('AVOND', 'ZA', 'za', 'za', None, ['vr', 'ma']),
        ('DAG', 'TWEE_DD', 'za', 'zo', None, ['vr', 'ma']),
        ('DAG', 'ENKEL', 'do', 'do', None, ['wo', 'vr']),  # a dagdienst on a feestdag in the week
        ('AVOND', 'LOS', 'ma', 'ma', None, ['di']),
        ('NACHT', 'ENKEL', 'ma', 'ma', None, ['di']),  # the second AIOS on New Year's Eve
        ('UITLOOP', 'ENKEL', 'ma', 'ma', None, []),
    ],
)
def test_regel_7_en_8_compensation_days(soort, vorm, eerste, laatste, feestdag, verwacht):
    # The days of the first week from Wednesday dag(0) to Tuesday dag(6); a + is the week after.
    namen = {'wo': 0, 'do': 1, 'vr': 2, 'za': 3, 'zo': 4, 'ma': 5, 'di': 6}
    d = lambda n: dag(namen[n.rstrip('+')] + (7 if n.endswith('+') else 0))  # noqa: E731
    feestdagen = {d(feestdag)} if feestdag else set()
    assert kalender.compensatiedagen(soort, vorm, d(eerste), d(laatste), feestdagen) == {d(n) for n in verwacht}


def test_regel_8_a_compensation_day_moves_off_a_feestdag_in_the_model_too():
    # The Thursday after the night block is a feestdag: the Friday is the compensation day.
    feestdag = dag(8)
    inp = weken(2, {feestdag})
    x = aios(inp, 'x')
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    _alleen(inp, x, nacht + [dienst('UD', dag(9))])
    _, t = los_op(inp)
    assert len(van(t, 'x')) == 3 and set(nacht) <= van(t, 'x')


# ---- rule 9 -----------------------------------------------------------------


def test_regel_9_46_hours_after_a_night_block_also_when_rule_8_frees_the_day():
    # The night block ends on a feestdag Wednesday: no compensation day, but no dagdienst that morning either.
    feestdag = dag(7)
    inp = weken(2, {feestdag})
    x = aios(inp, 'x')
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    _alleen(inp, x, nacht + [dienst('DD', feestdag)])
    _, t = los_op(inp)
    assert len(van(t, 'x')) == 3 and set(nacht) <= van(t, 'x')


def test_regel_9_46_hours_after_a_night_block_where_only_the_rest_holds_it():
    # The Thursday after the night block is a feestdag, so rule 8 moves its
    # compensation day to Friday; its dagdienst starts 24 hours after the
    # last night: allowed by 14 hours, not by 46.
    feestdag = dag(8)
    inp = weken(2, {feestdag})
    x = aios(inp, 'x')
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    _alleen(inp, x, nacht + [dienst('DD', feestdag)])
    _, t = los_op(inp)
    assert van(t, 'x') == set(nacht)


def _optie(soort, vorm, *diensten):
    slots = []
    for code, d, begin, eind in diensten:
        b, e = kalender.begin_en_eind(d, begin, eind)
        slots.append(model.Slot(id=f'{code}-{d}', datum=d, code=code, begin=b, eind=e, tienden=10, blok_id=None, feestdag=False))
    return model.Optie(id=vorm, soort=soort, vorm=vorm, slots=slots)


def test_regel_9_14_hours_between_two_diensten():
    # With these times the compensation days (rule 7) already keep 14 hours
    # almost everywhere ("volgt dat bijna altijd al uit regel 7"); the rule
    # stands on its own all the same, for any times.
    avond = _optie('AVOND', 'LOS', ('AD', dag(0), '17:36', '23:12'))
    vroeg = _optie('DAG', 'ENKEL', ('DD', dag(1), '08:30', '18:12'))
    laat = _optie('UITLOOP', 'ENKEL', ('UD', dag(1), '17:36', '20:00'))
    assert model.regel_9_rust(avond, vroeg), '9 hours 18'
    assert model.regel_9_rust(vroeg, avond), 'either way round'
    assert not model.regel_9_rust(avond, laat), '18 hours 24'


def test_regel_9_46_hours_after_three_nights_14_after_one():
    drie = _optie('NACHT', 'ZO_DI', *[('ND', dag(k), '22:30', '08:30') for k in (4, 5, 6)])
    een = _optie('NACHT', 'LOS', ('ND', dag(6), '22:30', '08:30'))
    donderdag = _optie('DAG', 'ENKEL', ('DD', dag(8), '08:30', '18:12'))  # 24 hours after
    assert model.regel_9_rust(drie, donderdag)
    assert not model.regel_9_rust(een, donderdag)


def _nachtblok_voor_het_kwartaal() -> list[dict]:
    """The nights Sunday to Tuesday just before START: the quarter before, as the app sends them (0.111.0)."""
    return [
        {
            'id': f'ND-{dag(k).isoformat()}',
            'datum': dag(k).isoformat(),
            'code': 'ND',
            'start_tijd': '22:30',
            'eind_tijd': '08:30',
            'blok_id': 'oud-1',
            'blok_soort': 'NACHT',
            'blok_vorm': 'ZO_DI',
        }
        for k in (-3, -2, -1)
    ]


def test_regel_7_9_the_rest_and_compensation_days_run_on_over_the_quarter_boundary():
    """Nights Sunday to Tuesday before the quarter: Wednesday and Thursday are off, and 46 hours of rest after the last night."""

    def uitkomst(eerder: list[dict]) -> set[str]:
        inp = weken(1)
        x = aios(inp, 'x', eerdere_diensten=eerder)
        # x is the only one, and only for the first two days.
        _alleen(inp, x, [dienst('UD', dag(0)), dienst('UD', dag(1)), dienst('UD', dag(2))])
        uit, t = los_op(inp)  # the check knows the quarter before too
        return van(t, 'x')

    assert uitkomst([]) == {dienst('UD', dag(0)), dienst('UD', dag(1)), dienst('UD', dag(2))}
    # With the block before: Wednesday and Thursday are compensation days; Friday's uitloopdienst is 57 hours later.
    assert uitkomst(_nachtblok_voor_het_kwartaal()) == {dienst('UD', dag(2))}


def test_regel_7_9_the_check_names_a_dienst_on_a_compensation_day_of_the_quarter_before():
    import controle

    inp = weken(1)
    aios(inp, 'x', eerdere_diensten=_nachtblok_voor_het_kwartaal())
    slots, blok_vorm, mensen, feestdagen = main.naar_model(main.SolveInput(**inp))
    woensdag = dienst('UD', dag(0))
    fouten = controle.controleer(slots, blok_vorm, mensen, feestdagen, {woensdag: 'x'})
    regels = {r for r, _, _ in fouten}
    assert '7_COMPENSATIEDAG' in regels and '9_RUST' in regels
    # Without a dienst of this quarter there is nothing to judge: what lies wholly before it is not.
    assert controle.controleer(slots, blok_vorm, mensen, feestdagen, {}) == []


def test_regel_9_the_check_finds_more_than_seven_nights_in_a_row():
    import controle

    inp = weken(2)
    inp['blokken'] = []
    for d in inp['diensten']:
        d['blok_id'] = None
    aios(inp, 'x')
    request = main.SolveInput(**inp)
    slots, blok_vorm, mensen, feestdagen = main.naar_model(request)
    acht = {f'ND-{dag(k).isoformat()}': 'x' for k in range(8)}
    regels = {r for r, _, _ in controle.controleer(slots, blok_vorm, mensen, feestdagen, acht)}
    assert '9_MEER_DAN_7_NACHTEN' in regels


# ---- the weekend and the wishes ---------------------------------------------


def test_one_loose_weekend_dienst_unless_two_dagdiensten_were_asked_for():
    inp = weken(1)
    weekend = [dienst('DD', dag(3)), dienst('DD', dag(4))]
    _alleen(inp, aios(inp, 'x'), weekend)
    _, t = los_op(inp)
    assert len(t) == 1
    inp['aios'][0]['twee_dagdiensten'] = True
    _, t = los_op(inp)
    assert set(t) == set(weekend)


def test_the_block_of_four_only_for_who_asks_for_it():
    inp = weken(1)
    vier = blok(inp, 'AVOND', 'WO_VR', dag(0)) + blok(inp, 'AVOND', 'ZA', dag(3))
    _alleen(inp, aios(inp, 'x'), vier)
    _, t = los_op(inp)
    assert len(t) == 3, 'without the wish: the block, not the Saturday after it'
    inp['aios'][0]['vier_avonden'] = True
    _, t = los_op(inp)
    assert set(t) == set(vier)


def test_the_second_aios_on_new_years_eve():
    # A second night on a weekday, without a block: another AIOS than the
    # block's, and the day after is that one's compensation day.
    inp = weken(2)
    oudjaar = dag(5)  # a Monday, in the night block zo t/m di
    inp['diensten'].append(
        {'id': 'ND2-oudjaar', 'datum': oudjaar.isoformat(), 'code': 'ND', 'start_tijd': '22:30', 'eind_tijd': '08:30', 'punten': 1.0, 'blok_id': None}
    )
    nacht = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    x, y = aios(inp, 'x'), aios(inp, 'y')
    _alleen(inp, x, nacht + ['ND2-oudjaar'])
    _alleen(inp, y, ['ND2-oudjaar', dienst('UD', dag(6))])
    uit, t = los_op(inp)
    assert set(nacht) <= van(t, 'x'), 'the night stays in the block of one AIOS'
    assert t.get('ND2-oudjaar') == 'y', 'the second night to another AIOS'
    assert dienst('UD', dag(6)) not in t, 'the day after the loose night is its compensation day'


# ---- the voortgangstoets ------------------------------------------------------


def test_the_night_before_the_voortgangstoets_left_out_the_rest_one_block():
    # The app leaves that night out of the quarter: a fellow does it
    # (lib/aiosVoortgangstoets.ts). The other nights stay one block for one
    # AIOS, with the compensation days on the two days after the last of
    # them: zo and ma give di and wo, so the Thursday is free again.
    inp = weken(2)
    inp['diensten'] = [d for d in inp['diensten'] if d['id'] != dienst('ND', dag(6))]
    rest = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    assert rest == [dienst('ND', dag(4)), dienst('ND', dag(5))]
    _alleen(inp, aios(inp, 'x'), rest + [dienst('UD', dag(6)), dienst('UD', dag(8))])
    _, t = los_op(inp)
    assert set(rest) <= van(t, 'x')
    assert dienst('UD', dag(6)) not in t, 'the Tuesday: the first compensation day'
    assert t.get(dienst('UD', dag(8))) == 'x', 'the Thursday: no compensation day any more'


def test_the_night_before_the_voortgangstoets_in_the_middle_of_a_block():
    # Toets on a Tuesday: the fellow does the Monday night, zo and di stay
    # one block for one AIOS (the planner's choice), then wo and do are free.
    inp = weken(2)
    inp['diensten'] = [d for d in inp['diensten'] if d['id'] != dienst('ND', dag(5))]
    rest = blok(inp, 'NACHT', 'ZO_DI', dag(4))
    x, y = aios(inp, 'x'), aios(inp, 'y')
    _alleen(inp, x, rest + [dienst('UD', dag(8))])
    _alleen(inp, y, rest)
    _, t = los_op(inp)
    houder = t[rest[0]]
    assert t[rest[1]] == houder, 'one AIOS for both nights'
    if houder == 'x':
        assert dienst('UD', dag(8)) not in t, 'the Thursday: its second compensation day'
    assert kalender.compensatiedagen('NACHT', 'ZO_DI', dag(4), dag(6), set()) == {dag(7), dag(8)}


# ---- 0.112.0: a large carry-over is a large difference, not an impossible model ----


def _basis_leeg(**kw) -> int:
    inp = weken(2, kw.pop('feestdagen', frozenset()))
    for i in range(4):
        aios(inp, f'a{i}')
    inp['tijdslimiet_seconden'] = 10
    return len(los_op(inp)[0].leeg)


@pytest.mark.parametrize('saldo', [100, -100, 400, -400])
def test_a_large_saldo_still_gives_a_roster(saldo):
    inp = weken(2)
    aios(inp, 'a0', saldo_punten=saldo)
    for i in range(1, 4):
        aios(inp, f'a{i}')
    inp['tijdslimiet_seconden'] = 10
    uit, toegewezen = los_op(inp)
    # Before 0.112.0 the answer was "ONMOGELIJK" with every dienst empty from about 100 points.
    assert uit.status in ('OPTIMAAL', 'HAALBAAR')
    assert toegewezen
    assert len(uit.leeg) == _basis_leeg()


@pytest.mark.parametrize('achterstand', [100, -100, 200])
def test_a_large_feestdag_debt_still_gives_a_roster(achterstand):
    feest = {dag(3)}
    inp = weken(2, feest)
    aios(inp, 'a0', feestdag_achterstand=achterstand)
    for i in range(1, 4):
        aios(inp, f'a{i}')
    inp['tijdslimiet_seconden'] = 10
    uit, toegewezen = los_op(inp)
    assert uit.status in ('OPTIMAAL', 'HAALBAAR')
    assert toegewezen
    assert len(uit.leeg) == _basis_leeg(feestdagen=feest)


def test_a_stop_asked_before_the_search_ends_it_at_once_and_says_nothing_was_solved():
    inp = weken(2)
    aios(inp, 'x')
    aios(inp, 'y')
    inp['tijdslimiet_seconden'] = 60
    request = main.SolveInput(**inp)
    stop = model.Stop()
    stop.vraag()
    begin = time.monotonic()
    uit = main.los_op(request, stop)
    assert time.monotonic() - begin < 10
    assert uit.status in ('GEEN_OPLOSSING', 'HAALBAAR')


def test_the_empty_roster_is_the_first_answer_when_time_is_short():
    # No solution found is not the same as nothing to solve: the hint of the empty roster means that a
    # short time ends in HAALBAAR (the best found), not in GEEN_OPLOSSING.
    inp = weken(6)
    for i in range(12):
        aios(inp, f'a{i}')
    inp['tijdslimiet_seconden'] = 1
    request = main.SolveInput(**inp)
    uit = main.los_op(request)
    assert uit.status in ('OPTIMAAL', 'HAALBAAR')


def test_the_time_limit_is_for_the_whole_job_including_the_model_building():
    inp = weken(13)
    for i in range(30):
        aios(inp, f'a{i}')
    inp['tijdslimiet_seconden'] = 3
    request = main.SolveInput(**inp)
    begin = time.monotonic()
    main.los_op(request)
    # Building the model took part of the 3 seconds: the whole stays near the limit, not building plus the limit.
    assert time.monotonic() - begin < 3 + 12


class _Verbinding:
    """A request whose caller hangs up after a while: what main.solve polls."""

    def __init__(self, na_seconden: float | None) -> None:
        self.begin = time.monotonic()
        self.na = na_seconden
        self.gevraagd = 0

    async def is_disconnected(self) -> bool:
        self.gevraagd += 1
        return self.na is not None and time.monotonic() - self.begin >= self.na


def test_a_caller_who_hangs_up_stops_the_search_and_frees_the_solver():
    import asyncio

    inp = weken(13)
    for i in range(30):
        aios(inp, f'a{i}')
    inp['tijdslimiet_seconden'] = 120
    request = main.SolveInput(**inp)
    verbinding = _Verbinding(na_seconden=2)
    begin = time.monotonic()
    uit = asyncio.run(main.solve(request, verbinding))
    duur = time.monotonic() - begin
    # Far under the 120 seconds the search was allowed: it stopped within a poll or two of the hang-up.
    assert duur < 20
    assert verbinding.gevraagd >= 2
    assert uit.status in ('HAALBAAR', 'GEEN_OPLOSSING')
    # The next request is not turned away with a 429.
    assert main._loopt is False


def test_a_caller_who_stays_gets_the_whole_search():
    import asyncio

    inp = weken(1)
    aios(inp, 'x')
    inp['tijdslimiet_seconden'] = 20
    uit = asyncio.run(main.solve(main.SolveInput(**inp), _Verbinding(na_seconden=None)))
    assert uit.status in ('OPTIMAAL', 'HAALBAAR')
    assert main._loopt is False

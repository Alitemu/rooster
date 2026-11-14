"""
The contract with the app (main.py): what does not fit is refused at the
door (422), before it reaches the model.
"""

import pytest
from pydantic import ValidationError

import main
from test_hulp import aios, dag, weken


def _invoer(**pas_aan):
    inp = weken(1)
    aios(inp, 'x')
    for k, v in pas_aan.items():
        inp[k] = v
    return inp


def test_a_valid_request_is_taken():
    main.SolveInput(**_invoer())


@pytest.mark.parametrize(
    'breek',
    [
        lambda i: i['diensten'][0].update(blok_id='bestaat-niet'),
        lambda i: i['diensten'].append(dict(i['diensten'][0])),
        lambda i: i['aios'].append(dict(i['aios'][0])),
        lambda i: i['aios'][0].update(markeringen=[{'dienst_id': 'bestaat-niet', 'niveau': 'ABSOLUUT'}]),
        lambda i: i['aios'][0].update(fte=0),
        lambda i: i['aios'][0].update(fte=1.2),
        lambda i: i['aios'][0].update(erboven={'NACHTBLOKKEN': -1}),
        lambda i: i['aios'][0].update(erboven={'ONBEKEND': 1}),
        lambda i: i['diensten'][0].update(datum=dag(30).isoformat()),
        lambda i: i['diensten'][0].update(datum='2097-02-30'),
        lambda i: i['diensten'][0].update(code='XX'),
        lambda i: i['diensten'][0].update(start_tijd='8:30'),
        lambda i: i.update(periode={'van': dag(6).isoformat(), 'tot': dag(0).isoformat()}),
        lambda i: i.update(tijdslimiet_seconden=0),
        lambda i: i.update(tijdslimiet_seconden=3601),
        lambda i: i.update(aios=[]),
        lambda i: i['aios'][0].update(markeringen=[{'dienst_id': i['diensten'][0]['id'], 'niveau': 'ABSOLUUT', 'bron': 'ANDERS'}]),
        # 0.112.0: numbers and times the model could only answer with "impossible", an overflow or a 500.
        lambda i: i['aios'][0].update(saldo_punten=1e300),
        lambda i: i['aios'][0].update(saldo_punten=float('inf')),
        lambda i: i['aios'][0].update(saldo_punten=float('nan')),
        lambda i: i['aios'][0].update(saldo_punten=-1e6),
        lambda i: i['aios'][0].update(feestdag_achterstand=5e16),
        lambda i: i['aios'][0].update(feestdag_achterstand=float('nan')),
        lambda i: i['diensten'][0].update(start_tijd='99:99'),
        lambda i: i['diensten'][0].update(eind_tijd='24:60'),
        lambda i: i['diensten'][0].update(eind_tijd='23:60'),
        lambda i: i.update(periode={'van': '0001-01-01', 'tot': '9999-12-31'}),
        lambda i: i.update(periode={'van': i['periode']['van'], 'tot': dag(401).isoformat()}),
        lambda i: i['blokken'].append(dict(i['blokken'][0])),
        lambda i: i['aios'][0].update(
            eerdere_diensten=[{'id': 'e1', 'datum': dag(1).isoformat(), 'code': 'AD', 'start_tijd': '17:36', 'eind_tijd': '23:12'}]
        ),
        lambda i: i['aios'][0].update(
            eerdere_diensten=[
                {'id': 'e1', 'datum': dag(-2).isoformat(), 'code': 'AD', 'start_tijd': '17:36', 'eind_tijd': '23:12'},
                {'id': 'e1', 'datum': dag(-1).isoformat(), 'code': 'AD', 'start_tijd': '17:36', 'eind_tijd': '23:12'},
            ]
        ),
    ],
)
def test_what_does_not_fit_is_refused(breek):
    inp = _invoer()
    breek(inp)
    with pytest.raises(ValidationError):
        main.SolveInput(**inp)


def test_the_edges_of_what_fits_are_taken():
    inp = _invoer()
    inp['aios'][0].update(saldo_punten=500, feestdag_achterstand=-200, saldo_nachten=-200)
    inp['diensten'][0].update(start_tijd='00:00', eind_tijd='23:59')
    inp['aios'][0]['eerdere_diensten'] = [
        {'id': 'e1', 'datum': dag(-1).isoformat(), 'code': 'AD', 'start_tijd': '17:36', 'eind_tijd': '23:12'}
    ]
    main.SolveInput(**inp)
    inp['periode'] = {'van': inp['periode']['van'], 'tot': dag(400).isoformat()}
    main.SolveInput(**inp)


def test_a_second_solve_beside_the_first_is_told_to_wait():
    from fastapi.testclient import TestClient

    client = TestClient(main.app)
    main._loopt = True
    try:
        res = client.post('/solve', json=_invoer())
    finally:
        main._loopt = False
    assert res.status_code == 429
    assert 'loopt al' in res.json()['detail']
    # The flag is let go when the solve is done: the next one is taken.
    inp = _invoer()
    inp['tijdslimiet_seconden'] = 5
    assert client.post('/solve', json=inp).status_code == 200
    assert main._loopt is False


def test_an_hour_is_the_longest_search():
    """0.902.0: the planner may let the solver look up to an hour; more is refused before anything is built."""
    from main import SolveInput

    inp = _invoer()
    inp['tijdslimiet_seconden'] = 3600
    assert SolveInput(**inp).tijdslimiet_seconden == 3600
    inp['tijdslimiet_seconden'] = 3601
    with pytest.raises(Exception):
        SolveInput(**inp)

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
        lambda i: i.update(aios=[]),
        lambda i: i['aios'][0].update(markeringen=[{'dienst_id': i['diensten'][0]['id'], 'niveau': 'ABSOLUUT', 'bron': 'ANDERS'}]),
    ],
)
def test_what_does_not_fit_is_refused(breek):
    inp = _invoer()
    breek(inp)
    with pytest.raises(ValidationError):
        main.SolveInput(**inp)

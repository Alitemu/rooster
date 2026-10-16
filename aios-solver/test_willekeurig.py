"""
Random quarters, every solution through the independent check
(controle.py): whatever the AIOS marked or asked, no hard rule is broken.
Small enough to solve in seconds: weeks with feestdagen, part-timers and
fulltimers, inwerken, an onderbreking, leave, blocks by hand with and
without the part above half, liever niet, voorkeur and the wishes.
"""

import random
from datetime import date

import pytest

from test_hulp import aios, dag, los_op, markeer, weken


@pytest.mark.parametrize('seed', range(12))
def test_no_hard_rule_broken(seed):
    rnd = random.Random(seed)
    n_weken = rnd.choice([2, 3])
    feestdagen = {dag(rnd.randrange(7 * n_weken)) for _ in range(rnd.randrange(3))}
    inp = weken(n_weken, feestdagen)
    inp['tijdslimiet_seconden'] = 5
    ids = [d['id'] for d in inp['diensten']]
    groepen = ['UITLOOPDIENSTEN', 'DAGDIENSTEN', 'ZATERDAG_AVOND', 'ZATERDAG_NACHT', 'AVONDBLOKKEN', 'NACHTBLOKKEN']
    for i in range(rnd.randrange(3, 8)):
        kw = {
            'fte': rnd.choice([0.6, 0.8, 0.9, 1.0]),
            'vier_avonden': rnd.random() < 0.3,
            'vier_nachten': rnd.random() < 0.3,
            'twee_dagdiensten': rnd.random() < 0.3,
            'erboven': {g: rnd.randrange(3) for g in groepen if rnd.random() < 0.4},
        }
        if rnd.random() < 0.5:
            kw['parttime_dagen'] = [dag(7 * w + rnd.choice([0, 1, 2, 5, 6])).isoformat() for w in range(n_weken)]
        if rnd.random() < 0.3:
            s = rnd.randrange(7 * n_weken)
            kw['inwerken'] = {'van': dag(s).isoformat(), 'tot': dag(min(s + rnd.randrange(10), 7 * n_weken - 1)).isoformat()}
        if rnd.random() < 0.2:
            s = rnd.randrange(7 * n_weken)
            kw['onderbreking'] = {'van': dag(s).isoformat(), 'tot': dag(min(s + rnd.randrange(10), 7 * n_weken - 1)).isoformat()}
        if rnd.random() < 0.2:
            kw['beschikbaar'] = [{'van': dag(rnd.randrange(7)).isoformat(), 'tot': dag(7 * n_weken - 1 - rnd.randrange(7)).isoformat()}]
        a = aios(inp, f'r{i}', **kw)
        if rnd.random() < 0.4:
            s = rnd.randrange(7 * n_weken)
            markeer(a, [d for d in ids if dag(s) <= date.fromisoformat(d.split('-', 1)[1]) <= dag(s + 4)], 'ABSOLUUT', 'ABSENCE')
        for niveau, deel in (('ABSOLUUT', 4), ('LIEVER_NIET', 6), ('VOORKEUR', 8)):
            markeer(a, rnd.sample(ids, len(ids) // deel), niveau)
    los_op(inp)

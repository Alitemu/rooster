"""
Writes tests/fixtures/aios-regels.json: rosters with the violations
controle.py finds in them. The app keeps its own copy of the hard rules
(lib/aiosRegels.ts, the planner's choice in October 2026), and both
test_gedeeld.py here and lib/aiosRegels.test.ts there check every roster
in the file, so the two copies can't drift apart unnoticed.

Run it again (`python regelgevallen.py` in ./aios-solver) only when a rule
changes on purpose, and then change the other copy until both tests pass.
Random quarters like test_willekeurig.py's, with rosters made at random (a
block now and then split up, a block cut up, a second night without a
block, a block without the night before a voortgangstoets), a few on
purpose for the rarer rules, and the solver's own solutions, which break
nothing.
"""

from __future__ import annotations

import json
import random
from datetime import date, timedelta
from pathlib import Path

import controle
import main
from test_hulp import aios, dag, dienst, markeer, weken

UIT = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'aios-regels.json'
GROEPEN = ['UITLOOPDIENSTEN', 'DAGDIENSTEN', 'ZATERDAG_AVOND', 'ZATERDAG_NACHT', 'AVONDBLOKKEN', 'NACHTBLOKKEN']


def kwartaal(rnd: random.Random) -> dict:
    n_weken = rnd.choice([2, 3])
    feestdagen = {dag(rnd.randrange(7 * n_weken)) for _ in range(rnd.randrange(4))}
    inp = weken(n_weken, feestdagen)
    # A block cut up now and then, and now and then a second night without a block.
    for b in inp['blokken']:
        if b['vorm'] != 'ZA' and rnd.random() < 0.1:
            b['vorm'] = 'LOS'
    # Now and then the night before a voortgangstoets left out, as the app
    # does (lib/aiosVoortgangstoets.ts): a block with a night less.
    if rnd.random() < 0.3:
        inp['diensten'].remove(rnd.choice([d for d in inp['diensten'] if d['code'] == 'ND' and d['blok_id']]))
    if rnd.random() < 0.5:
        d = dag(rnd.randrange(7 * n_weken)).isoformat()
        inp['diensten'].append(
            {'id': f'ND2-{d}', 'datum': d, 'code': 'ND', 'start_tijd': '22:30', 'eind_tijd': '08:30', 'punten': 1.0, 'blok_id': None}
        )
    ids = [d['id'] for d in inp['diensten']]
    for i in range(rnd.randrange(3, 7)):
        kw = {
            'fte': rnd.choice([0.6, 0.8, 0.9, 1.0]),
            'vier_avonden': rnd.random() < 0.3,
            'vier_nachten': rnd.random() < 0.3,
            'twee_dagdiensten': rnd.random() < 0.3,
            'erboven': {g: rnd.randrange(3) for g in GROEPEN if rnd.random() < 0.4},
        }
        if rnd.random() < 0.5:
            kw['parttime_dagen'] = [dag(7 * w + rnd.choice([0, 1, 2, 5, 6])).isoformat() for w in range(n_weken)]
        if rnd.random() < 0.3:
            s = rnd.randrange(7 * n_weken)
            kw['inwerken'] = {'van': dag(s).isoformat(), 'tot': dag(min(s + rnd.randrange(10), 7 * n_weken - 1)).isoformat()}
        if rnd.random() < 0.3:
            s = rnd.randrange(7 * n_weken)
            kw['onderbreking'] = {'van': dag(s).isoformat(), 'tot': dag(min(s + rnd.randrange(10), 7 * n_weken - 1)).isoformat()}
        if rnd.random() < 0.3:
            kw['beschikbaar'] = [{'van': dag(rnd.randrange(7)).isoformat(), 'tot': dag(7 * n_weken - 1 - rnd.randrange(7)).isoformat()}]
        a = aios(inp, f'r{i}', **kw)
        if rnd.random() < 0.5:
            s = rnd.randrange(7 * n_weken)
            bron = rnd.choice(['ABSENCE', 'PARTTIME'])
            markeer(a, [d for d in ids if dag(s) <= date.fromisoformat(d.split('-', 1)[1]) <= dag(s + 3)], 'ABSOLUUT', bron)
        for niveau, deel in (('ABSOLUUT', 4), ('LIEVER_NIET', 6), ('VOORKEUR', 8)):
            markeer(a, rnd.sample(ids, len(ids) // deel), niveau)
    return inp


def willekeurig_rooster(inp: dict, rnd: random.Random) -> list[list[str]]:
    """Every block to one AIOS (now and then split up), every single dienst to one; some left empty."""
    mensen = [a['id'] for a in inp['aios']]
    vorm = {b['id']: b['vorm'] for b in inp['blokken']}
    per_blok: dict[str, list[str]] = {}
    los: list[str] = []
    for d in inp['diensten']:
        if d['blok_id'] and vorm[d['blok_id']] != 'LOS':
            per_blok.setdefault(d['blok_id'], []).append(d['id'])
        else:
            los.append(d['id'])
    uit: list[list[str]] = []
    for ids in per_blok.values():
        if rnd.random() < 0.15:
            continue
        if rnd.random() < 0.1:
            uit.extend([i, rnd.choice(mensen)] for i in ids if rnd.random() < 0.8)
        else:
            wie = rnd.choice(mensen)
            uit.extend([i, wie] for i in ids)
    for i in los:
        if rnd.random() < 0.85:
            uit.append([i, rnd.choice(mensen)])
    rnd.shuffle(uit)
    return uit


def fouten(inp: dict, toewijzingen: list[list[str]]) -> list:
    slots, blok_vorm, mensen, feestdagen = main.naar_model(main.SolveInput(**inp))
    return sorted([regel, wie, ids] for regel, wie, ids in controle.controleer(slots, blok_vorm, mensen, feestdagen, dict(toewijzingen)))


def alle_nachten_aan(inp: dict, wie: str) -> list[list[str]]:
    """The rarer rules: more than seven nights in a row, the rest after a night block."""
    return [[d['id'], wie] for d in inp['diensten'] if d['code'] == 'ND']


def vier_en_twee_dd(inp: dict, wie: str) -> list[list[str]]:
    """A wo t/m za block and both dagdiensten of a weekend, without the wishes."""
    za = dag(3)
    nacht = [d['id'] for d in inp['diensten'] if d['blok_id'] in (f'NWO_VR-{dag(0).isoformat()}', f'NZA-{za.isoformat()}')]
    return [[i, wie] for i in nacht] + [[dienst('DD', dag(10)), wie], [dienst('DD', dag(11)), wie]]


def main_() -> None:
    rnd = random.Random(2026)
    gevallen = []
    for n in range(14):
        inp = kwartaal(rnd)
        roosters = [willekeurig_rooster(inp, rnd) for _ in range(4)]
        if n == 0:
            roosters.append(alle_nachten_aan(inp, inp['aios'][0]['id']))
        if n == 1:
            for a in inp['aios'][:2]:
                a.update(vier_avonden=False, vier_nachten=False, twee_dagdiensten=False)
            roosters.append(vier_en_twee_dd(inp, inp['aios'][0]['id']))
        if n < 3:
            # The solver's own: nothing broken.
            inp['tijdslimiet_seconden'] = 5
            uit = main.los_op(main.SolveInput(**inp))
            roosters.append([[t.dienst_id, t.aios_id] for t in uit.toewijzingen])
        volledig = main.SolveInput(**inp).model_dump(mode='json')
        invoer = {k: volledig[k] for k in ('periode', 'feestdagen', 'diensten', 'blokken', 'aios')}
        gevallen.append(
            {
                'naam': f'kwartaal {n + 1}',
                'invoer': invoer,
                'roosters': [{'toewijzingen': r, 'fouten': fouten(inp, r)} for r in roosters],
            }
        )
    UIT.write_text(json.dumps({'gevallen': gevallen}, ensure_ascii=False, separators=(',', ':')) + '\n')
    gezien = {f[0] for g in gevallen for r in g['roosters'] for f in r['fouten']}
    print(f'{UIT}: {sum(len(g["roosters"]) for g in gevallen)} roosters, regels {sorted(gezien)}')


if __name__ == '__main__':
    main_()

"""
For the tests: a quarter (or a few weeks of one) built the way the app
builds it (lib/aiosDiensten.ts aiosRooster), as the request the app sends,
and a solve that runs every result through the independent check
(controle.py). Named test_*.py so the image leaves it out (.dockerignore);
it holds no tests itself.
"""

from __future__ import annotations

from datetime import date, timedelta

import controle
import main

TIJDEN = {
    'DD': ('08:30', '18:12', 1.0),
    'ADW': ('13:30', '23:12', 1.0),
    'UD': ('17:36', '20:00', 0.2),
    'AD': ('17:36', '23:12', 0.6),
    'ND': ('22:30', '08:30', 1.0),
}

# A Wednesday, far from any real roster.
START = date(2097, 1, 2)


def dag(n: int) -> date:
    return START + timedelta(days=n)


def weken(n: int, feestdagen: set[date] = frozenset(), start: date = START) -> dict:
    """`n` weeks from a Wednesday: the diensten and blocks of aiosRooster."""
    assert start.weekday() == 2
    blokken, diensten = [], []
    blok_van: dict[tuple[str, date], str] = {}
    for w in range(n):
        wo = start + timedelta(days=7 * w)
        for soort in ('AVOND', 'NACHT'):
            for vorm, van, lengte in (('WO_VR', wo, 3), ('ZA', wo + timedelta(days=3), 1), ('ZO_DI', wo + timedelta(days=4), 3)):
                bid = f'{soort[0]}{vorm}-{van.isoformat()}'
                blokken.append({'id': bid, 'soort': soort, 'vorm': vorm})
                for k in range(lengte):
                    blok_van[soort, van + timedelta(days=k)] = bid
    eind = start + timedelta(days=7 * n - 1)
    d = start
    while d <= eind:
        weekend_of_feest = d.weekday() >= 5 or d in feestdagen
        codes = ['DD', 'ADW', 'ND'] if weekend_of_feest else ['UD', 'AD', 'ND']
        for code in codes:
            begin, einde, punten = TIJDEN[code]
            soort = 'AVOND' if code in ('AD', 'ADW') else 'NACHT' if code == 'ND' else None
            diensten.append(
                {
                    'id': f'{code}-{d.isoformat()}',
                    'datum': d.isoformat(),
                    'code': code,
                    'start_tijd': begin,
                    'eind_tijd': einde,
                    'punten': punten,
                    'blok_id': blok_van[soort, d] if soort else None,
                }
            )
        d += timedelta(days=1)
    return {
        'periode': {'van': start.isoformat(), 'tot': eind.isoformat()},
        'feestdagen': sorted(f.isoformat() for f in feestdagen),
        'diensten': diensten,
        'blokken': blokken,
        'aios': [],
        'tijdslimiet_seconden': 20,
    }


def aios(inp: dict, id: str, **kw) -> dict:
    a = {'id': id, 'fte': 0.8, 'beschikbaar': [dict(inp['periode'])], **kw}
    inp['aios'].append(a)
    return a


def dienst(code: str, d: date) -> str:
    return f'{code}-{d.isoformat()}'


def blok(inp: dict, soort: str, vorm: str, van: date) -> list[str]:
    """The dienst ids of the block of this soort and vorm starting on `van`."""
    bid = f'{soort[0]}{vorm}-{van.isoformat()}'
    return [d['id'] for d in inp['diensten'] if d['blok_id'] == bid]


def markeer(a: dict, ids: list[str], niveau: str, bron: str = 'MANUAL') -> None:
    a.setdefault('markeringen', []).extend({'dienst_id': i, 'niveau': niveau, 'bron': bron} for i in ids)


def los_op(inp: dict, *, controleren: bool = True) -> tuple[main.SolveOutput, dict[str, str]]:
    """Solves and checks: no hard rule broken (controle.py). Returns the output and dienst -> aios."""
    request = main.SolveInput(**inp)
    uit = main.los_op(request)
    toegewezen = {t.dienst_id: t.aios_id for t in uit.toewijzingen}
    if controleren:
        slots, blok_vorm, mensen, feestdagen = main.naar_model(request)
        fouten = controle.controleer(slots, blok_vorm, mensen, feestdagen, toegewezen)
        assert fouten == [], fouten
    return uit, toegewezen


def van(toegewezen: dict[str, str], aios_id: str) -> set[str]:
    return {d for d, a in toegewezen.items() if a == aios_id}

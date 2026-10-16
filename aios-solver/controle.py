"""
An independent check of an AIOS roster against the hard rules
(docs/aios-rooster.md), written apart from model.py on purpose: the tests
run every solution through it, so a rule the model gets wrong is not
hidden by the same mistake in the check. It works from the roster alone
(dienst -> AIOS), not from the model's options, and words the
compensation days its own way.

Returns the violations as (regel, aios id, [dienst ids]).
"""

from __future__ import annotations

from datetime import date, timedelta

MAANDAG, VRIJDAG, ZATERDAG, ZONDAG = 0, 4, 5, 6


def _dag(d: date, n: int) -> date:
    return d + timedelta(days=n)


def _vrij_op_feestdag(d: date, stap: int, feestdagen: set[date], al: set[date]) -> date:
    # Rule 8: off a feestdag on Monday to Friday, away from the dienst; also
    # off a day that is already a compensation day of the same dienst.
    while (d.weekday() <= VRIJDAG and d in feestdagen) or d in al:
        d = _dag(d, stap)
    return d


def _compensatie(eenheid: dict, feestdagen: set[date]) -> set[date]:
    """Rule 7's table, per kind of eenheid (see _eenheden)."""
    soort, soortnaam, van, tot = eenheid['soort'], eenheid['naam'], eenheid['van'], eenheid['tot']
    voor: list[date] = []
    na: list[date] = []
    tabel_na = {
        ('NACHT', 'zo-di'): [1, 2],
        ('AVOND', 'zo-di'): [1],
        ('NACHT', 'wo-vr'): [1, 2],
        ('AVOND', 'wo-vr'): [1, 2],
        ('AVOND', 'wo-za'): [1],
        ('NACHT', 'wo-za'): [1, 2],
        ('NACHT', 'za'): [1, 2],
        ('AVOND', 'los'): [1],
        ('NACHT', 'los'): [1],
    }
    if (soort, soortnaam) in tabel_na:
        na = [_dag(tot, n) for n in tabel_na[(soort, soortnaam)]]
        if (soort, soortnaam) == ('NACHT', 'za'):
            voor = [_dag(van, -1)]
    elif soortnaam in ('za', 'weekend-dd', 'twee-dd'):
        za = van if van.weekday() == ZATERDAG else _dag(van, -1)
        voor = [_dag(za, -1)]
        na = [_dag(za, 2)]
    elif soortnaam == 'feestdag-dd':
        voor = [_dag(van, -1)]
        na = [_dag(tot, 1)]
    uit: set[date] = set()
    for d in voor:
        uit.add(_vrij_op_feestdag(d, -1, feestdagen, uit))
    for d in sorted(na):
        uit.add(_vrij_op_feestdag(d, 1, feestdagen, uit))
    return uit


def _eenheden(per_aios: dict[str, list], blok_vorm: dict[str, tuple[str, str]]) -> dict[str, list[dict]]:
    """What each AIOS does, in eenheden: blocks, a 4-block, two dagdiensten, single diensten."""
    uit: dict[str, list[dict]] = {}
    for aios_id, slots in per_aios.items():
        blokken: dict[str, list] = {}
        los = []
        for s in slots:
            if s.blok_id and blok_vorm[s.blok_id][1] != 'LOS':
                blokken.setdefault(s.blok_id, []).append(s)
            else:
                los.append(s)
        eenheden = []
        for blok_id, bs in blokken.items():
            soort, vorm = blok_vorm[blok_id]
            bs.sort(key=lambda s: s.begin)
            naam = {'ZO_DI': 'zo-di', 'WO_VR': 'wo-vr', 'ZA': 'za'}[vorm]
            eenheden.append({'soort': soort, 'naam': naam, 'van': bs[0].datum, 'tot': bs[-1].datum, 'slots': bs, 'vorm': vorm})
        for s in los:
            if s.code == 'DD':
                naam = 'weekend-dd' if s.datum.weekday() >= ZATERDAG else 'feestdag-dd'
                soort = 'DAG'
            elif s.code == 'UD':
                naam, soort = 'ud', 'UITLOOP'
            else:
                naam, soort = 'los', ('NACHT' if s.code == 'ND' else 'AVOND')
            eenheden.append({'soort': soort, 'naam': naam, 'van': s.datum, 'tot': s.datum, 'slots': [s], 'vorm': 'LOS' if s.blok_id else 'ENKEL'})
        # A wo t/m vr block with the Saturday of the same soort right after: wo t/m za.
        for e in list(eenheden):
            if e['naam'] == 'wo-vr':
                za = next((z for z in eenheden if z['naam'] == 'za' and z['soort'] == e['soort'] and z['van'] == _dag(e['tot'], 1)), None)
                if za:
                    eenheden.remove(e)
                    eenheden.remove(za)
                    eenheden.append({'soort': e['soort'], 'naam': 'wo-za', 'van': e['van'], 'tot': za['tot'], 'slots': e['slots'] + za['slots'], 'vorm': 'VIER'})
        # Both dagdiensten of one weekend.
        for e in list(eenheden):
            if e['naam'] == 'weekend-dd' and e['van'].weekday() == ZATERDAG:
                zo = next((z for z in eenheden if z['naam'] == 'weekend-dd' and z['van'] == _dag(e['van'], 1)), None)
                if zo:
                    eenheden.remove(e)
                    eenheden.remove(zo)
                    eenheden.append({'soort': 'DAG', 'naam': 'twee-dd', 'van': e['van'], 'tot': zo['tot'], 'slots': e['slots'] + zo['slots'], 'vorm': 'TWEE_DD'})
        uit[aios_id] = eenheden
    return uit


def _groep_van(e: dict) -> str | None:
    """The 50% counter the eenheid falls under (lib/aiosVoorkeur.ts), None for what can't be blocked."""
    if any(s.feestdag for s in e['slots']):
        return None
    return {
        'ud': 'UITLOOPDIENSTEN',
        'weekend-dd': 'DAGDIENSTEN',
        'zo-di': 'AVONDBLOKKEN' if e['soort'] == 'AVOND' else 'NACHTBLOKKEN',
        'wo-vr': 'AVONDBLOKKEN' if e['soort'] == 'AVOND' else 'NACHTBLOKKEN',
        'za': 'ZATERDAG_AVOND' if e['soort'] == 'AVOND' else 'ZATERDAG_NACHT',
    }.get(e['naam'])


def controleer(slots, blok_vorm, aios, feestdagen: set[date], toewijzingen: dict[str, str]) -> list[tuple[str, str, list[str]]]:
    fout: list[tuple[str, str, list[str]]] = []
    per_id = {s.id: s for s in slots}
    wie = {a.id: a for a in aios}

    # Rule 2: a block whole, or not at all.
    per_blok: dict[str, list] = {}
    for s in slots:
        if s.blok_id and blok_vorm[s.blok_id][1] != 'LOS':
            per_blok.setdefault(s.blok_id, []).append(s)
    for blok_id, bs in per_blok.items():
        mensen = {toewijzingen.get(s.id) for s in bs}
        if len(mensen) > 1:
            fout.append(('2_BLOK_HEEL', ','.join(sorted(m or '-' for m in mensen)), [s.id for s in bs]))

    per_aios: dict[str, list] = {}
    for dienst_id, aios_id in toewijzingen.items():
        per_aios.setdefault(aios_id, []).append(per_id[dienst_id])
    for lijst in per_aios.values():
        lijst.sort(key=lambda s: s.begin)
    eenheden = _eenheden(per_aios, blok_vorm)

    for aios_id, lijst in per_aios.items():
        a = wie[aios_id]
        boven: dict[str, int] = {}
        for e in eenheden[aios_id]:
            ids = [s.id for s in e['slots']]
            if e['vorm'] == 'VIER' and not (a.vier_avonden if e['soort'] == 'AVOND' else a.vier_nachten):
                fout.append(('VIER_ZONDER_WENS', aios_id, ids))
            if e['vorm'] == 'TWEE_DD' and not a.twee_dagdiensten:
                fout.append(('TWEE_DD_ZONDER_WENS', aios_id, ids))
            blok_hand = False
            for s in e['slots']:
                # Rule 1.
                if not any(v <= s.datum <= t for v, t in a.beschikbaar):
                    fout.append(('1_BUITEN_LIDMAATSCHAP', aios_id, [s.id]))
                if a.onderbreking and a.onderbreking[0] <= s.datum <= a.onderbreking[1]:
                    fout.append(('1_ONDERBREKING', aios_id, [s.id]))
                niveau, bron = a.markeringen.get(s.id, ('', ''))
                if niveau == 'ABSOLUUT':
                    if bron != 'MANUAL':
                        fout.append(('1_AFWEZIG_OF_PARTTIME', aios_id, [s.id]))
                    else:
                        blok_hand = True
                # Rule 4: the uitloopdienst only; an evening or night there is liever niet.
                if s.datum in a.parttime_dagen and s.code == 'UD':
                    fout.append(('4_PARTTIMEDAG', aios_id, [s.id]))
                # Rule 6.
                if a.inwerken and a.inwerken[0] <= s.datum <= a.inwerken[1]:
                    if not (s.code == 'UD' or (s.code == 'DD' and s.datum.weekday() >= ZATERDAG)):
                        fout.append(('6_INWERKEN', aios_id, [s.id]))
            if blok_hand:
                groep = _groep_van(e) if e['vorm'] not in ('VIER', 'TWEE_DD') else None
                if groep is None:
                    fout.append(('1_GEBLOKKEERD', aios_id, ids))
                else:
                    boven[groep] = boven.get(groep, 0) + 1
            # Rule 5.
            if a.fte >= 1 and e['soort'] == 'NACHT' and e['naam'] == 'zo-di':
                fout.append(('5_FULLTIME_NACHTBLOK', aios_id, ids))
        for groep, n in boven.items():
            if n > a.erboven.get(groep, 0):
                fout.append(('1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT', aios_id, [groep]))

        # Rule 3: one dienst a day.
        dagen: dict[date, list[str]] = {}
        for s in lijst:
            dagen.setdefault(s.datum, []).append(s.id)
        for ids in dagen.values():
            if len(ids) > 1:
                fout.append(('3_TWEE_OP_EEN_DAG', aios_id, ids))

        # Rules 7 and 8: nothing on another eenheid's compensation day.
        for e in eenheden[aios_id]:
            comp = _compensatie(e, feestdagen)
            for f in eenheden[aios_id]:
                if f is e:
                    continue
                for s in f['slots']:
                    if s.datum in comp:
                        fout.append(('7_COMPENSATIEDAG', aios_id, [e['slots'][0].id, s.id]))

        # Rule 9: rest, and at most seven nights in a row.
        eenheid_van = {s.id: i for i, e in enumerate(eenheden[aios_id]) for s in e['slots']}
        laatste_nacht = set()
        for e in eenheden[aios_id]:
            nachten = [s for s in e['slots'] if s.code == 'ND']
            if len(nachten) >= 3:
                laatste_nacht.add(nachten[-1].id)
        for i, s in enumerate(lijst):
            for t in lijst[i + 1 :]:
                if eenheid_van[s.id] == eenheid_van[t.id] or s.datum == t.datum:
                    continue
                nodig = timedelta(hours=46 if s.id in laatste_nacht else 14)
                if t.begin - s.eind < nodig:
                    fout.append(('9_RUST', aios_id, [s.id, t.id]))
        nachtdagen = sorted({s.datum for s in lijst if s.code == 'ND'})
        reeks = 1
        for vorige, d in zip(nachtdagen, nachtdagen[1:]):
            reeks = reeks + 1 if d - vorige == timedelta(days=1) else 1
            if reeks > 7:
                fout.append(('9_MEER_DAN_7_NACHTEN', aios_id, [str(d)]))

        # One loose weekend dienst per weekend.
        per_weekend: dict[date, int] = {}
        for e in eenheden[aios_id]:
            if e['naam'] in ('za', 'weekend-dd', 'twee-dd', 'wo-za'):
                za = e['tot'] if e['naam'] == 'wo-za' else (e['van'] if e['van'].weekday() == ZATERDAG else _dag(e['van'], -1))
                per_weekend[za] = per_weekend.get(za, 0) + 1
        for za, n in per_weekend.items():
            if n > 1:
                fout.append(('WEEKEND_TWEE_LOSSE_DIENSTEN', aios_id, [str(za)]))
    return fout

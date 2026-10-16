"""
The rosters of tests/fixtures/aios-regels.json, shared with the app's
copy of the hard rules (lib/aiosRegels.ts, lib/aiosRegels.test.ts): each
with the violations controle.py found when the file was written
(regelgevallen.py). A rule of controle.py changed without the app's copy,
or the other way round, fails one of the two tests.
"""

import json
from pathlib import Path

import pytest

import controle
import main

GEVALLEN = json.loads((Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'aios-regels.json').read_text())['gevallen']

ALLE_REGELS = {
    '1_AFWEZIG_OF_PARTTIME',
    '1_BUITEN_LIDMAATSCHAP',
    '1_GEBLOKKEERD',
    '1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT',
    '1_ONDERBREKING',
    '2_BLOK_HEEL',
    '3_TWEE_OP_EEN_DAG',
    '4_PARTTIMEDAG',
    '5_FULLTIME_NACHTBLOK',
    '6_INWERKEN',
    '7_COMPENSATIEDAG',
    '9_MEER_DAN_7_NACHTEN',
    '9_RUST',
    'TWEE_DD_ZONDER_WENS',
    'VIER_ZONDER_WENS',
    'WEEKEND_TWEE_LOSSE_DIENSTEN',
}


def test_every_rule_is_in_the_file():
    gezien = {f[0] for g in GEVALLEN for r in g['roosters'] for f in r['fouten']}
    assert gezien == ALLE_REGELS
    assert any(r['fouten'] == [] for g in GEVALLEN for r in g['roosters']), 'a roster without violations too'


@pytest.mark.parametrize('geval', GEVALLEN, ids=lambda g: g['naam'])
def test_controle_finds_what_the_file_says(geval):
    inp = main.SolveInput(**geval['invoer'])
    slots, blok_vorm, mensen, feestdagen = main.naar_model(inp)
    for rooster in geval['roosters']:
        gevonden = controle.controleer(slots, blok_vorm, mensen, feestdagen, dict(rooster['toewijzingen']))
        assert sorted([r, w, ids] for r, w, ids in gevonden) == rooster['fouten']

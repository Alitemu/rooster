"""
The AIOS's solver (docs/aios-rooster.md, step 3): a service of its own, in
a container of its own, apart from the achterwacht's (./solver), which
stays as it is (docs/development/diensten.md, "Copied, not changed").

  GET  /health
  POST /solve   one quarter: its diensten and blocks, the AIOS taking part
                with what they marked and asked, and back the roster, who
                got what and why a dienst stayed empty.

The contract (docs/development/aios-solver.md) is the AIOS's own; the app
calls it from step 4 on. Only the web container calls it: docker-compose.yml
exposes the port on the internal network only.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

import kalender
import model

_log_level = getattr(logging, os.environ.get('LOG_LEVEL', 'INFO').upper(), logging.INFO)
logging.basicConfig(level=_log_level, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('aios-solver')

VERSIE = '1.0.0'

TellerGroep = Literal['UITLOOPDIENSTEN', 'DAGDIENSTEN', 'ZATERDAG_AVOND', 'ZATERDAG_NACHT', 'AVONDBLOKKEN', 'NACHTBLOKKEN']


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info('AIOS-solver %s: GET /health, POST /solve', VERSIE)
    yield


app = FastAPI(title='Dienstrooster AIOS-solver', version=VERSIE, lifespan=lifespan)


def _iso(v: str) -> str:
    date.fromisoformat(v)
    return v


class Periode(BaseModel):
    van: str
    tot: str

    _check = field_validator('van', 'tot')(classmethod(lambda cls, v: _iso(v)))

    @model_validator(mode='after')
    def _volgorde(self):
        if self.tot < self.van:
            raise ValueError('tot ligt voor van')
        return self


class Dienst(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    datum: str
    code: Literal['UD', 'DD', 'AD', 'ADW', 'ND']
    start_tijd: str = Field(pattern=r'^\d{2}:\d{2}$')
    eind_tijd: str = Field(pattern=r'^\d{2}:\d{2}$')
    punten: float = Field(ge=0, le=10)
    blok_id: Optional[str] = None

    _check = field_validator('datum')(classmethod(lambda cls, v: _iso(v)))


class Blok(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    soort: Literal['AVOND', 'NACHT']
    vorm: Literal['ZO_DI', 'WO_VR', 'ZA', 'LOS']


class EerdereDienst(BaseModel):
    """
    A dienst the AIOS did in the quarter before (its last days): rest after it and the compensation days of its block
    run on over the quarter boundary, so the new quarter may not break them (0.111.0). With its block's soort and
    vorm, when it was part of one.
    """

    id: str = Field(min_length=1, max_length=64)
    datum: str
    code: Literal['UD', 'DD', 'AD', 'ADW', 'ND']
    start_tijd: str = Field(pattern=r'^\d{2}:\d{2}$')
    eind_tijd: str = Field(pattern=r'^\d{2}:\d{2}$')
    blok_id: Optional[str] = None
    blok_soort: Optional[Literal['AVOND', 'NACHT']] = None
    blok_vorm: Optional[Literal['ZO_DI', 'WO_VR', 'ZA', 'LOS']] = None

    _check = field_validator('datum')(classmethod(lambda cls, v: _iso(v)))

    @model_validator(mode='after')
    def _blok(self):
        if self.blok_id and not (self.blok_soort and self.blok_vorm):
            raise ValueError('een blok heeft een soort en een vorm nodig')
        return self


class Markering(BaseModel):
    dienst_id: str
    niveau: Literal['ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR']
    # Where it came from: the AIOS by hand, a part-time day or leave
    # (lib/aiosSync.ts). Only MANUAL may fall in the part above half.
    bron: Literal['MANUAL', 'PARTTIME', 'ABSENCE'] = 'MANUAL'


class Aios(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    fte: float = Field(gt=0, le=1)
    # Geldig vanaf/tot, as periods within the quarter.
    beschikbaar: list[Periode]
    onderbreking: Optional[Periode] = None
    inwerken: Optional[Periode] = None
    parttime_dagen: list[str] = Field(default_factory=list)
    vier_avonden: bool = False
    vier_nachten: bool = False
    twee_dagdiensten: bool = False
    markeringen: list[Markering] = Field(default_factory=list, max_length=5000)
    # Per 50% counter, how many blocked by hand may still be rostered: the
    # part above half, as lib/aiosVoorkeur.ts blokkadeTellers counts it.
    erboven: dict[TellerGroep, int] = Field(default_factory=dict)
    # Carry-over in points; a delta: negative = fewer this quarter.
    saldo_punten: float = 0
    # Feestdagdiensten short of a fair share over the years; negative = had more.
    feestdag_achterstand: float = 0
    # Nights short of a fair share so far; a delta as saldo_punten: negative = had more.
    saldo_nachten: float = Field(default=0, ge=-200, le=200)
    # The same for the dagdiensten and the avonddiensten in the weekend (0.108.0).
    saldo_dagen: float = Field(default=0, ge=-200, le=200)
    saldo_weekendavonden: float = Field(default=0, ge=-200, le=200)
    # What the AIOS did in the last days of the quarter before (0.111.0), for the rest and compensation days.
    eerdere_diensten: list[EerdereDienst] = Field(default_factory=list, max_length=60)

    _check = field_validator('parttime_dagen')(classmethod(lambda cls, v: [_iso(d) for d in v]))

    @field_validator('erboven')
    @classmethod
    def _niet_negatief(cls, v):
        if any(n < 0 for n in v.values()):
            raise ValueError('erboven kan niet negatief zijn')
        return v


class SolveInput(BaseModel):
    periode: Periode
    # Every feestdag from a week before the quarter to a week after it: a
    # compensation day may fall just outside it (hard rule 8).
    feestdagen: list[str] = Field(default_factory=list)
    diensten: list[Dienst] = Field(min_length=1, max_length=2000)
    blokken: list[Blok] = Field(default_factory=list, max_length=1000)
    aios: list[Aios] = Field(min_length=1, max_length=150)
    tijdslimiet_seconden: float = Field(default=60, ge=1, le=600)
    seed: int = Field(default=0, ge=0, le=2**31 - 1)

    _check = field_validator('feestdagen')(classmethod(lambda cls, v: [_iso(d) for d in v]))

    @model_validator(mode='after')
    def _verwijzingen(self):
        blokken = {b.id for b in self.blokken}
        diensten = {d.id for d in self.diensten}
        if len(diensten) != len(self.diensten):
            raise ValueError('een dienst-id komt twee keer voor')
        if len({a.id for a in self.aios}) != len(self.aios):
            raise ValueError('een aios-id komt twee keer voor')
        for d in self.diensten:
            if d.blok_id is not None and d.blok_id not in blokken:
                raise ValueError(f'dienst {d.id} hoort bij een onbekend blok')
            if not (self.periode.van <= d.datum <= self.periode.tot):
                raise ValueError(f'dienst {d.id} valt buiten de periode')
        for a in self.aios:
            for m in a.markeringen:
                if m.dienst_id not in diensten:
                    raise ValueError(f'een markering van {a.id} hoort bij een onbekende dienst')
        return self


class Toewijzing(BaseModel):
    dienst_id: str
    aios_id: str


class Leeg(BaseModel):
    dienst_id: str
    # Per reason, how many AIOS it ruled out (BEZET: could, but has a dienst near it).
    redenen: dict[str, int]


class PerAios(BaseModel):
    aios_id: str
    punten: float
    doel_punten: float
    werkdagen: int
    # punten / (werkdagen x fte), as a fraction: 0.2 is 20%.
    dienstpercentage: Optional[float]
    nachten: int
    avonden: int
    dagdiensten: int
    uitloopdiensten: int
    feestdagdiensten: int
    # The fair number of feestdagdiensten this quarter, the years before included.
    doel_feestdagdiensten: float
    # The fair number of nights this quarter, the saldo of the years before included (0.107.0).
    doel_nachten: float
    # Likewise the fair number of dagdiensten and of avonddiensten in the weekend (0.108.0).
    doel_dagen: float
    doel_weekendavonden: float
    blokken: int
    liever_niet: int
    voorkeur: int
    boven_de_helft: int


class SolveOutput(BaseModel):
    status: Literal['OPTIMAAL', 'HAALBAAR', 'ONMOGELIJK', 'ONGELDIG', 'GEEN_OPLOSSING']
    toewijzingen: list[Toewijzing]
    leeg: list[Leeg]
    per_aios: list[PerAios]
    tijd_seconden: float
    versie: str = VERSIE


class Health(BaseModel):
    status: str = 'ok'
    service: str = 'aios-solver'
    version: str = VERSIE
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


def naar_model(inp: SolveInput):
    feestdagen = {kalender.datum(d) for d in inp.feestdagen}
    slots = []
    for d in inp.diensten:
        dag = kalender.datum(d.datum)
        begin, eind = kalender.begin_en_eind(dag, d.start_tijd, d.eind_tijd)
        slots.append(
            model.Slot(
                id=d.id,
                datum=dag,
                code=d.code,
                begin=begin,
                eind=eind,
                tienden=round(d.punten * 10),
                blok_id=d.blok_id,
                feestdag=dag in feestdagen,
            )
        )
    blok_vorm = {b.id: (b.soort, b.vorm) for b in inp.blokken}
    # The quarter before: its diensten and blocks get an id of their own, so they never meet this quarter's.
    eerder: dict[str, list[model.Slot]] = {}
    for a in inp.aios:
        lijst = []
        for d in a.eerdere_diensten:
            dag = kalender.datum(d.datum)
            begin, eind = kalender.begin_en_eind(dag, d.start_tijd, d.eind_tijd)
            blok = f'eerder:{d.blok_id}' if d.blok_id else None
            if blok:
                blok_vorm[blok] = (d.blok_soort, d.blok_vorm)
            lijst.append(model.Slot(id=f'eerder:{d.id}', datum=dag, code=d.code, begin=begin, eind=eind, tienden=0, blok_id=blok, feestdag=dag in feestdagen))
        eerder[a.id] = lijst
    periode = lambda p: (kalender.datum(p.van), kalender.datum(p.tot)) if p else None  # noqa: E731
    aios = [
        model.Aios(
            id=a.id,
            fte=a.fte,
            beschikbaar=[periode(p) for p in a.beschikbaar],
            onderbreking=periode(a.onderbreking),
            inwerken=periode(a.inwerken),
            parttime_dagen={kalender.datum(d) for d in a.parttime_dagen},
            vier_avonden=a.vier_avonden,
            vier_nachten=a.vier_nachten,
            twee_dagdiensten=a.twee_dagdiensten,
            markeringen={m.dienst_id: (m.niveau, m.bron) for m in a.markeringen},
            erboven=dict(a.erboven),
            saldo_tienden=round(a.saldo_punten * 10),
            feestdag_achterstand=a.feestdag_achterstand,
            saldo_nachten=a.saldo_nachten,
            saldo_dagen=a.saldo_dagen,
            saldo_weekendavonden=a.saldo_weekendavonden,
            eerder=eerder[a.id],
        )
        for a in inp.aios
    ]
    for a in aios:
        a.eerdere_opties = model.eerdere_opties(a.eerder, blok_vorm, feestdagen)
    return slots, blok_vorm, aios, feestdagen


def los_op(inp: SolveInput) -> SolveOutput:
    slots, blok_vorm, aios, feestdagen = naar_model(inp)
    u = model.oplossen(
        slots,
        blok_vorm,
        aios,
        kalender.datum(inp.periode.van),
        kalender.datum(inp.periode.tot),
        feestdagen,
        tijdslimiet=inp.tijdslimiet_seconden,
        seed=inp.seed,
    )
    per_id = {s.id: s for s in slots}
    per_aios = []
    for a in aios:
        mijn = [per_id[d] for d, wie in u.toewijzingen.items() if wie == a.id]
        tienden = sum(s.tienden for s in mijn)
        gekregen = u.opties[a.id]
        niveau = lambda o, n: any(a.markeringen.get(s.id, ('', ''))[0] == n for s in o.slots)  # noqa: E731
        noemer = u.werkdagen[a.id] * a.fte
        per_aios.append(
            PerAios(
                aios_id=a.id,
                punten=tienden / 10,
                doel_punten=round(u.doel_tienden[a.id] / 10, 2),
                werkdagen=u.werkdagen[a.id],
                dienstpercentage=round(tienden / 10 / noemer, 4) if noemer else None,
                nachten=sum(1 for s in mijn if s.code == 'ND'),
                avonden=sum(1 for s in mijn if s.code in ('AD', 'ADW')),
                dagdiensten=sum(1 for s in mijn if s.code == 'DD'),
                uitloopdiensten=sum(1 for s in mijn if s.code == 'UD'),
                feestdagdiensten=sum(1 for s in mijn if s.feestdag),
                doel_feestdagdiensten=round(u.doel_feestdagen[a.id], 2),
                doel_nachten=round(u.doel_soort[a.id]['NACHT'], 2),
                doel_dagen=round(u.doel_soort[a.id]['DAG'], 2),
                doel_weekendavonden=round(u.doel_soort[a.id]['AVOND_WEEKEND'], 2),
                blokken=sum(1 for o in gekregen if o.is_blok),
                liever_niet=sum(1 for o in gekregen if niveau(o, 'LIEVER_NIET')),
                voorkeur=sum(1 for o in gekregen if niveau(o, 'VOORKEUR')),
                boven_de_helft=u.boven_helft[a.id],
            )
        )
    return SolveOutput(
        status=u.status,
        toewijzingen=[Toewijzing(dienst_id=d, aios_id=a) for d, a in sorted(u.toewijzingen.items())],
        leeg=[Leeg(dienst_id=s.id, redenen=u.redenen_leeg[s.id]) for s in u.leeg],
        per_aios=per_aios,
        tijd_seconden=round(u.tijd_s, 2),
    )


@app.get('/health', response_model=Health)
async def health():
    return Health()


@app.post('/solve', response_model=SolveOutput)
async def solve(inp: SolveInput):
    logger.info('solve: %d diensten, %d aios, %ss', len(inp.diensten), len(inp.aios), inp.tijdslimiet_seconden)
    try:
        # CP-SAT holds the GIL little; a thread keeps /health answering meanwhile.
        return await asyncio.get_running_loop().run_in_executor(None, functools.partial(los_op, inp))
    except Exception:
        logger.exception('solve failed')
        raise HTTPException(status_code=500, detail='De AIOS-solver kon dit rooster niet maken.')


if __name__ == '__main__':
    import uvicorn

    # Outside Docker: loopback only (the container binds 0.0.0.0, see Dockerfile).
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('PORT', '8001')))

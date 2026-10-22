"""
The AIOS roster as a CP-SAT model (docs/aios-rooster.md, step 3): one
decision per block instead of per day.

An option is what one AIOS takes in one go: a whole block (avond or nacht,
zo t/m di, wo t/m vr, or the Saturday on its own), a single dienst (an
uitloopdienst, a dagdienst, a day of a block the planner cut up), and for
who asks for it a block of four (wo t/m vr with the Saturday after it, of
the same soort) or the two dagdiensten of one weekend. Every dienst goes to
at most one AIOS; one left empty costs the most, and the planner fills it
by hand (D2).

The hard rules (numbers as in the design), each in a function of its own so
a test and a mutation can hold each one:
  1. no dienst outside Geldig vanaf/tot, during an onderbreking, or on a day
     the AIOS blocked or is away, except the part above half (50%-regel);
  2. blocks whole, every dienst one AIOS;
  3. one dienst a day;
  4. on a part-time day no uitloopdienst and no avondblok with that day in it;
  5. from 0,9 fte on never in the nachtblok zo t/m di (kalender.py);
  6. inwerken: only uitloopdiensten and the weekend's dagdiensten;
  7. no dienst on a compensation day (kalender.py), 8. moved off a feestdag;
  9. rest: 14 hours, 46 after a night block of three or four nights, at most
     seven nights in a row.
Besides: one loose weekend dienst per AIOS per weekend (the two dagdiensten
for who asks for them), and the 4-block only for who asks for it.

Soft, in this order of weight (the planner's choice, October 2026: as the
achterwacht's, fairness before liever niet): an empty dienst, a blocked day
above half, the points per AIOS to its share, the nights, evenings and
dagdiensten each to their share, the feestdagen over the years, liever niet,
more than one block in four weeks, the wishes for a 4-block or two
dagdiensten, voorkeur.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from ortools.sat.python import cp_model

import kalender
from kalender import ZA, ZO

# Weights of the soft rules (integers: CP-SAT works in whole numbers).
W_LEEG = 1_000_000  # per dienst left empty
W_BOVEN_HELFT = 20_000  # per blocked option taken from the part above half
W_PUNT = 100  # per tenth of a point off the share, per AIOS
W_PUNT_MAX = 200  # per tenth of a point of the largest such difference
# Per dienst off the share of that soort. The planner's order of what must be shared fairly, most important first
# (0.103.0): nights, dagdiensten, evenings at the weekend, evenings in the week, uitloopdiensten. Counted apart from the
# points: a night is a point like a dagdienst, and an uitloopdienst (0,2) used to make up for a night someone did not
# do (the measurement of October 2026: 1 to 8 nights between 20 AIOS, one with 3 nights and 16 uitloopdiensten).
W_SOORT = {'NACHT': 1500, 'DAG': 600, 'AVOND_WEEKEND': 300, 'AVOND': 200, 'UITLOOP': 100}
# The soort that fairness counts per code: the evening at the weekend (ADW) is its own, not the evening in the week.
EERLIJK_VAN_CODE = {'ND': 'NACHT', 'DD': 'DAG', 'ADW': 'AVOND_WEEKEND', 'AD': 'AVOND', 'UD': 'UITLOOP'}
# Who inwerkt does evenings and nights only after the inwerkperiode: their share of these is pro rata (the others: all werkdagen).
NA_INWERKEN = ('NACHT', 'AVOND_WEEKEND', 'AVOND')
W_FEESTDAG = 300  # per feestdagdienst off the share over the years
W_LIEVER_NIET = 500
W_SPREIDING = 400  # per block more than one in four weeks, and again per block more than one in two
W_WENS = 300  # a granted 4-block or the two dagdiensten of a weekend
W_VOORKEUR = 150

# The planner's choice: one block in four weeks. Two weeks is counted
# too, so two blocks a week apart cost more than two a fortnight apart:
# with four weeks alone, three blocks in three weeks came out as cheap as
# one every other week.
SPREIDING_DAGEN = (14, 28)
SOORT_VAN_CODE = {'UD': 'UITLOOP', 'DD': 'DAG', 'AD': 'AVOND', 'ADW': 'AVOND', 'ND': 'NACHT'}


@dataclass
class Slot:
    id: str
    datum: date
    code: str
    begin: datetime
    eind: datetime
    tienden: int  # points x 10: 0,2 and 0,6 add up exactly
    blok_id: Optional[str]
    feestdag: bool

    @property
    def soort(self) -> str:
        return SOORT_VAN_CODE[self.code]

    @property
    def eerlijk_soort(self) -> str:
        """What fairness shares equally: nights, dagdiensten, evenings at the weekend, evenings in the week, uitloopdiensten."""
        return EERLIJK_VAN_CODE[self.code]


@dataclass
class Optie:
    id: str
    soort: str  # UITLOOP, DAG, AVOND, NACHT
    vorm: str  # ZO_DI, WO_VR, ZA, LOS, ENKEL, VIER, TWEE_DD
    slots: list[Slot]
    # The 50% counter it belongs to (lib/aiosVoorkeur.ts blokkadeTellers), or None.
    groep: Optional[str] = None
    compensatie: set[date] = field(default_factory=set)

    @property
    def eerste(self) -> date:
        return self.slots[0].datum

    @property
    def laatste(self) -> date:
        return self.slots[-1].datum

    @property
    def data(self) -> set[date]:
        return {s.datum for s in self.slots}

    @property
    def tienden(self) -> int:
        return sum(s.tienden for s in self.slots)

    @property
    def is_blok(self) -> bool:
        """What the spreading counts: evenings and nights, a block or a Saturday."""
        return self.soort in ('AVOND', 'NACHT')

    @property
    def los_in_weekend(self) -> bool:
        """A loose weekend dienst: one per AIOS per weekend."""
        if self.vorm in ('ZA', 'TWEE_DD', 'VIER'):
            return True
        return self.vorm == 'ENKEL' and self.soort == 'DAG' and self.eerste.weekday() in (ZA, ZO)


@dataclass
class Aios:
    id: str
    fte: float
    beschikbaar: list[tuple[date, date]]
    onderbreking: Optional[tuple[date, date]]
    inwerken: Optional[tuple[date, date]]
    parttime_dagen: set[date]
    vier_avonden: bool
    vier_nachten: bool
    twee_dagdiensten: bool
    # Per dienst id: (niveau, bron).
    markeringen: dict[str, tuple[str, str]]
    erboven: dict[str, int]
    saldo_tienden: int  # delta: < 0 = fewer points this quarter
    feestdag_achterstand: float  # > 0: had fewer feestdagen than fair so far
    # Nights short of the fair number so far (0.107.0); a delta as the points: < 0 = fewer nights this quarter.
    saldo_nachten: float = 0.0
    # The same for the dagdiensten and the avonddiensten in the weekend (0.108.0).
    saldo_dagen: float = 0.0
    saldo_weekendavonden: float = 0.0


def _groep(soort: str, vorm: str, slots: list[Slot]) -> Optional[str]:
    """The 50% counter, as lib/aiosVoorkeur.ts counts it: nothing with a feestdag in it."""
    if any(s.feestdag for s in slots):
        return None
    if vorm == 'ENKEL' and soort == 'UITLOOP':
        return 'UITLOOPDIENSTEN'
    if vorm == 'ENKEL' and soort == 'DAG' and slots[0].datum.weekday() in (ZA, ZO):
        return 'DAGDIENSTEN'
    if vorm == 'ZA':
        return 'ZATERDAG_AVOND' if soort == 'AVOND' else 'ZATERDAG_NACHT'
    if vorm in ('ZO_DI', 'WO_VR'):
        return 'AVONDBLOKKEN' if soort == 'AVOND' else 'NACHTBLOKKEN'
    return None


def opties_maken(slots: list[Slot], blok_vorm: dict[str, tuple[str, str]], feestdagen: set[date]) -> list[Optie]:
    """Every option of the quarter, the 4-blocks and the two dagdiensten included (who may take them is per AIOS)."""
    per_blok: dict[str, list[Slot]] = {}
    opties: list[Optie] = []
    for s in sorted(slots, key=lambda s: (s.begin, s.id)):
        if s.blok_id and blok_vorm[s.blok_id][1] != 'LOS':
            per_blok.setdefault(s.blok_id, []).append(s)
        else:
            vorm = 'LOS' if s.blok_id else 'ENKEL'
            opties.append(Optie(id=f'dienst:{s.id}', soort=s.soort, vorm=vorm, slots=[s]))
    for blok_id, blok_slots in per_blok.items():
        soort, vorm = blok_vorm[blok_id]
        opties.append(Optie(id=f'blok:{blok_id}', soort=soort, vorm=vorm, slots=blok_slots))

    # A block of four: a wo t/m vr block and the Saturday right after it, of the same soort.
    zaterdag = {(o.soort, o.eerste): o for o in opties if o.vorm == 'ZA'}
    for o in list(opties):
        if o.vorm == 'WO_VR':
            za = zaterdag.get((o.soort, o.laatste + timedelta(days=1)))
            if za:
                opties.append(Optie(id=f'vier:{o.id}', soort=o.soort, vorm='VIER', slots=o.slots + za.slots))
    # The two dagdiensten of one weekend.
    dd = {o.eerste: o for o in opties if o.vorm == 'ENKEL' and o.soort == 'DAG' and o.eerste.weekday() in (ZA, ZO)}
    for dag, o in dd.items():
        zo = dd.get(dag + timedelta(days=1)) if dag.weekday() == ZA else None
        if zo:
            opties.append(Optie(id=f'tweedd:{o.id}', soort='DAG', vorm='TWEE_DD', slots=o.slots + zo.slots))

    for o in opties:
        o.groep = _groep(o.soort, o.vorm, o.slots)
        o.compensatie = kalender.compensatiedagen(o.soort, o.vorm, o.eerste, o.laatste, feestdagen)
    return opties


# ---------------------------------------------------------------------------
# The hard rules that hold per AIOS and option alone. Each returns the
# reason it is not allowed, or None. A reason is a code; main.py words it.
# ---------------------------------------------------------------------------


def regel_wens(a: Aios, o: Optie) -> Optional[str]:
    """A 4-block or the two dagdiensten only for who asks for them."""
    if o.vorm == 'VIER' and not (a.vier_avonden if o.soort == 'AVOND' else a.vier_nachten):
        return 'GEEN_WENS'
    if o.vorm == 'TWEE_DD' and not a.twee_dagdiensten:
        return 'GEEN_WENS'
    return None


def regel_1_beschikbaar(a: Aios, o: Optie) -> Optional[str]:
    """Hard rule 1: within Geldig vanaf/tot, every day of the option."""
    for d in o.data:
        if not any(van <= d <= tot for van, tot in a.beschikbaar):
            return 'BUITEN_LIDMAATSCHAP'
    return None


def regel_1_onderbreking(a: Aios, o: Optie) -> Optional[str]:
    """Hard rule 1: nothing during an onderbreking of the opleiding."""
    if a.onderbreking and any(a.onderbreking[0] <= d <= a.onderbreking[1] for d in o.data):
        return 'ONDERBREKING'
    return None


def regel_1_blokkade(a: Aios, o: Optie) -> Optional[str]:
    """
    Hard rule 1: nothing on a day blocked or away. Only what the AIOS blocked
    by hand in a group they blocked more than half of may still be taken
    (boven_helft); leave and a part-time day never.
    """
    geblokkeerd = [a.markeringen[s.id] for s in o.slots if a.markeringen.get(s.id, ('', ''))[0] == 'ABSOLUUT']
    if not geblokkeerd:
        return None
    if any(bron != 'MANUAL' for _, bron in geblokkeerd):
        return 'AFWEZIG' if any(bron == 'ABSENCE' for _, bron in geblokkeerd) else 'PARTTIMEDAG'
    if o.groep and a.erboven.get(o.groep, 0) > 0:
        return None
    return 'GEBLOKKEERD'


def boven_helft(a: Aios, o: Optie) -> bool:
    """Taking this option breaks a block by hand, from the part above half."""
    return any(a.markeringen.get(s.id, ('', ''))[0] == 'ABSOLUUT' for s in o.slots)


def regel_4_parttime(a: Aios, o: Optie) -> Optional[str]:
    """
    Hard rule 4: on a part-time day no uitloopdienst. Its evening may be
    planned: the app marks it liever niet (lib/aiosSync.ts; the planner's
    choice in October 2026, until 0.82.0 it was a hard rule). Its night is
    any night (since 0.83.0).
    """
    if o.soort == 'UITLOOP' and o.data & a.parttime_dagen:
        return 'PARTTIMEDAG'
    return None


def regel_5_fulltime(a: Aios, o: Optie) -> Optional[str]:
    """Hard rule 5: the nachtblok zo t/m di is for who has less than 0,9 fte (F7)."""
    if a.fte >= kalender.GEEN_NACHTBLOK_VANAF_FTE and o.soort == 'NACHT' and o.vorm == 'ZO_DI':
        return 'FULLTIME_NACHTBLOK'
    return None


def regel_6_inwerken(a: Aios, o: Optie) -> Optional[str]:
    """Hard rule 6: while inwerken, only uitloopdiensten and dagdiensten on Saturday and Sunday."""
    if not a.inwerken:
        return None
    van, tot = a.inwerken
    for s in o.slots:
        if van <= s.datum <= tot and not (s.code == 'UD' or (s.code == 'DD' and s.datum.weekday() in (ZA, ZO))):
            return 'INWERKEN'
    return None


REGELS_PER_OPTIE = [
    regel_wens,
    regel_1_beschikbaar,
    regel_1_onderbreking,
    regel_1_blokkade,
    regel_4_parttime,
    regel_5_fulltime,
    regel_6_inwerken,
]


def waarom_niet(a: Aios, o: Optie) -> Optional[str]:
    for regel in REGELS_PER_OPTIE:
        reden = regel(a, o)
        if reden:
            return reden
    return None


# ---------------------------------------------------------------------------
# The hard rules between two options of one AIOS.
# ---------------------------------------------------------------------------


def regel_7_compensatie(o1: Optie, o2: Optie) -> bool:
    """Hard rules 7 and 8: neither has a dienst on a compensation day of the other."""
    return bool(o1.compensatie & o2.data or o2.compensatie & o1.data)


def _rust_na(o: Optie, s: Slot) -> timedelta:
    nachten = [x for x in o.slots if x.code == 'ND']
    if o.soort == 'NACHT' and len(nachten) >= 3 and s is nachten[-1]:
        return timedelta(hours=kalender.RUST_NA_NACHTBLOK_UREN)
    return timedelta(hours=kalender.RUST_UREN)


def regel_9_rust(o1: Optie, o2: Optie) -> bool:
    """Hard rule 9: too little rest between a dienst of the one and one of the other."""
    for a, b in ((o1, o2), (o2, o1)):
        for s in a.slots:
            for t in b.slots:
                if t.begin >= s.begin and t.begin - s.eind < _rust_na(a, s):
                    return True
    return False


def botsen(o1: Optie, o2: Optie) -> bool:
    return regel_7_compensatie(o1, o2) or regel_9_rust(o1, o2)


# ---------------------------------------------------------------------------
# Shares
# ---------------------------------------------------------------------------


def werkdagen(a: Aios, van: date, tot: date, feestdagen: set[date], na: Optional[date] = None) -> int:
    """
    The werkdagen (Mon to Fri, no feestdag) the AIOS can do diensten on:
    within Geldig vanaf/tot, not during an onderbreking. Leave counts as an
    ordinary werkdag (G5). With `na`, only the days after it (inwerken).
    """
    n = 0
    d = van
    while d <= tot:
        if (
            kalender.is_werkdag(d)
            and d not in feestdagen
            and any(v <= d <= t for v, t in a.beschikbaar)
            and not (a.onderbreking and a.onderbreking[0] <= d <= a.onderbreking[1])
            and (na is None or d > na)
        ):
            n += 1
        d += timedelta(days=1)
    return n


def aandeel(totaal: float, gewicht: dict[str, float]) -> dict[str, float]:
    som = sum(gewicht.values())
    return {k: (totaal * g / som if som else 0.0) for k, g in gewicht.items()}


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------


@dataclass
class Uitkomst:
    status: str
    toewijzingen: dict[str, str]  # dienst id -> aios id
    opties: dict[str, list[Optie]]  # aios id -> what they got
    leeg: list[Slot]
    doel_tienden: dict[str, float]
    doel_soort: dict[str, dict[str, float]]
    doel_feestdagen: dict[str, float]
    werkdagen: dict[str, int]
    boven_helft: dict[str, int]
    redenen_leeg: dict[str, dict[str, int]]
    tijd_s: float
    objectief: float


def oplossen(
    slots: list[Slot],
    blok_vorm: dict[str, tuple[str, str]],
    aios: list[Aios],
    van: date,
    tot: date,
    feestdagen: set[date],
    tijdslimiet: float = 60.0,
    seed: int = 0,
    workers: int = 0,
) -> Uitkomst:
    opties = opties_maken(slots, blok_vorm, feestdagen)
    m = cp_model.CpModel()

    # x[a, o]: AIOS a takes option o, only where the rules per option allow it.
    x: dict[tuple[str, str], cp_model.IntVar] = {}
    toegestaan: dict[str, list[Optie]] = {}
    for a in aios:
        toegestaan[a.id] = []
        for o in opties:
            if waarom_niet(a, o) is None:
                x[a.id, o.id] = m.NewBoolVar(f'x_{a.id}_{o.id}')
                toegestaan[a.id].append(o)

    # Hard rule 2: every dienst at most one AIOS (an empty one costs W_LEEG).
    gedekt: dict[str, list[cp_model.IntVar]] = {s.id: [] for s in slots}
    for a in aios:
        for o in toegestaan[a.id]:
            for s in o.slots:
                gedekt[s.id].append(x[a.id, o.id])
    gevuld = {}
    for s in slots:
        gevuld[s.id] = m.NewBoolVar(f'gevuld_{s.id}')
        m.Add(sum(gedekt[s.id]) == gevuld[s.id])

    for a in aios:
        eigen = toegestaan[a.id]
        # Hard rule 3: one dienst a day.
        per_dag: dict[date, list[cp_model.IntVar]] = {}
        for o in eigen:
            for d in o.data:
                per_dag.setdefault(d, []).append(x[a.id, o.id])
        for vars_ in per_dag.values():
            if len(vars_) > 1:
                m.Add(sum(vars_) <= 1)
        # Hard rules 7, 8 and 9 between two options of one AIOS.
        eigen_sorted = sorted(eigen, key=lambda o: o.eerste)
        for i, o1 in enumerate(eigen_sorted):
            for o2 in eigen_sorted[i + 1 :]:
                if o2.eerste - o1.laatste > timedelta(days=6):
                    break
                if o1.data & o2.data:
                    continue  # the same day: rule 3 already
                if botsen(o1, o2):
                    m.Add(x[a.id, o1.id] + x[a.id, o2.id] <= 1)
        # Hard rule 9: at most seven nights in a row.
        nacht_dagen: dict[date, list[cp_model.IntVar]] = {}
        for o in eigen:
            for s in o.slots:
                if s.code == 'ND':
                    nacht_dagen.setdefault(s.datum, []).append(x[a.id, o.id])
        d = van
        while d + timedelta(days=kalender.MAX_NACHTEN_ACHTEREEN) <= tot:
            venster = [v for k in range(kalender.MAX_NACHTEN_ACHTEREEN + 1) for v in nacht_dagen.get(d + timedelta(days=k), [])]
            if len(venster) > kalender.MAX_NACHTEN_ACHTEREEN:
                m.Add(sum(venster) <= kalender.MAX_NACHTEN_ACHTEREEN)
            d += timedelta(days=1)
        # One loose weekend dienst per weekend (the two dagdiensten count as one).
        per_weekend: dict[date, dict[str, cp_model.IntVar]] = {}
        for o in eigen:
            if o.los_in_weekend:
                for s in o.slots:
                    if s.datum.weekday() in (ZA, ZO):
                        zaterdag = s.datum if s.datum.weekday() == ZA else s.datum - timedelta(days=1)
                        per_weekend.setdefault(zaterdag, {})[o.id] = x[a.id, o.id]
        for vars_ in per_weekend.values():
            if len(vars_) > 1:
                m.Add(sum(vars_.values()) <= 1)
        # The 50% rule: from the part above half at most `erboven` per group.
        per_groep: dict[str, list[cp_model.IntVar]] = {}
        for o in eigen:
            if boven_helft(a, o):
                per_groep.setdefault(o.groep or '', []).append(x[a.id, o.id])
        for groep, vars_ in per_groep.items():
            m.Add(sum(vars_) <= a.erboven.get(groep, 0))

    # ---- shares ----
    wd = {a.id: werkdagen(a, van, tot, feestdagen) for a in aios}
    capaciteit = {a.id: a.fte * wd[a.id] for a in aios}
    totaal_tienden = sum(s.tienden for s in slots)
    doel = {k: v + next(a.saldo_tienden for a in aios if a.id == k) for k, v in aandeel(totaal_tienden, capaciteit).items()}
    doel_soort: dict[str, dict[str, float]] = {a.id: {} for a in aios}
    for soort in W_SOORT:
        n = sum(1 for s in slots if s.eerlijk_soort == soort)
        if soort in NA_INWERKEN:
            # Who inwerkt has evenings and nights only after it (pro rata).
            gew = {a.id: a.fte * werkdagen(a, van, tot, feestdagen, na=a.inwerken[1] if a.inwerken else None) for a in aios}
        else:
            gew = capaciteit
        for k, v in aandeel(n, gew).items():
            doel_soort[k][soort] = v
        if soort in ('NACHT', 'DAG', 'AVOND_WEEKEND'):
            # Who had fewer of this soort than fair before gets more now, who had more gets fewer; never below none.
            for a in aios:
                saldo = {'NACHT': a.saldo_nachten, 'DAG': a.saldo_dagen, 'AVOND_WEEKEND': a.saldo_weekendavonden}[soort]
                doel_soort[a.id][soort] = max(0.0, doel_soort[a.id][soort] + saldo)
    n_feest = sum(1 for s in slots if s.feestdag)
    doel_feest = {
        k: max(0.0, v + next(a.feestdag_achterstand for a in aios if a.id == k)) for k, v in aandeel(n_feest, capaciteit).items()
    }

    # ---- objective ----
    termen: list = []
    for s in slots:
        termen.append(W_LEEG * (1 - gevuld[s.id]))

    max_af = m.NewIntVar(0, max(1, totaal_tienden * 2), 'max_af')
    for a in aios:
        eigen = toegestaan[a.id]
        xs = [(o, x[a.id, o.id]) for o in eigen]
        punten = sum(o.tienden * v for o, v in xs)
        af = m.NewIntVar(0, max(1, totaal_tienden * 2), f'af_{a.id}')
        d = round(doel[a.id])
        m.Add(af >= punten - d)
        m.Add(af >= d - punten)
        m.Add(max_af >= af)
        termen.append(W_PUNT * af)
        for soort, w in W_SOORT.items():
            aantal = sum(sum(1 for t in o.slots if t.eerlijk_soort == soort) * v for o, v in xs)
            afs = m.NewIntVar(0, len(slots), f'afs_{a.id}_{soort}')
            ds = round(doel_soort[a.id][soort])
            m.Add(afs >= aantal - ds)
            m.Add(afs >= ds - aantal)
            termen.append(w * afs)
        feest = sum(sum(1 for t in o.slots if t.feestdag) * v for o, v in xs)
        aff = m.NewIntVar(0, len(slots), f'aff_{a.id}')
        df = round(doel_feest[a.id])
        m.Add(aff >= feest - df)
        m.Add(aff >= df - feest)
        termen.append(W_FEESTDAG * aff)
        for o, v in xs:
            niveaus = {a.markeringen.get(s.id, ('', ''))[0] for s in o.slots}
            if boven_helft(a, o):
                termen.append(W_BOVEN_HELFT * v)
            if 'LIEVER_NIET' in niveaus:
                termen.append(W_LIEVER_NIET * v)
            if 'VOORKEUR' in niveaus:
                termen.append(-W_VOORKEUR * v)
            if o.vorm in ('VIER', 'TWEE_DD'):
                termen.append(-W_WENS * v)
        # Spreading: more than one block in four weeks costs per block too many.
        blokken = [(o, v) for o, v in xs if o.is_blok]
        for spanne in SPREIDING_DAGEN:
            start = van
            while start <= tot:
                eind = start + timedelta(days=spanne)
                binnen = [v for o, v in blokken if start <= o.eerste < eind]
                if len(binnen) > 1:
                    teveel = m.NewIntVar(0, len(binnen), f'spr{spanne}_{a.id}_{start}')
                    m.Add(teveel >= sum(binnen) - 1)
                    termen.append(W_SPREIDING * teveel)
                start += timedelta(days=7)
    termen.append(W_PUNT_MAX * max_af)
    m.Minimize(sum(termen))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(tijdslimiet)
    if workers:
        solver.parameters.num_workers = workers  # otherwise CP-SAT's own choice: every core, as the achterwacht's
    solver.parameters.random_seed = seed
    status = solver.Solve(m)
    naam = {
        cp_model.OPTIMAL: 'OPTIMAAL',
        cp_model.FEASIBLE: 'HAALBAAR',
        cp_model.INFEASIBLE: 'ONMOGELIJK',
        cp_model.MODEL_INVALID: 'ONGELDIG',
    }.get(status, 'GEEN_OPLOSSING')

    toewijzingen: dict[str, str] = {}
    gekregen: dict[str, list[Optie]] = {a.id: [] for a in aios}
    boven: dict[str, int] = {a.id: 0 for a in aios}
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for a in aios:
            for o in toegestaan[a.id]:
                if solver.Value(x[a.id, o.id]):
                    gekregen[a.id].append(o)
                    if boven_helft(a, o):
                        boven[a.id] += 1
                    for s in o.slots:
                        toewijzingen[s.id] = a.id
    leeg = [s for s in slots if s.id not in toewijzingen]

    # Why an empty dienst stayed empty: per AIOS the first rule that rules it
    # out, or BEZET when they could have but have another dienst near it.
    redenen: dict[str, dict[str, int]] = {}
    for s in leeg:
        tel: dict[str, int] = {}
        enkel = next(o for o in opties if s in o.slots and o.vorm not in ('VIER', 'TWEE_DD'))
        for a in aios:
            reden = waarom_niet(a, enkel) or 'BEZET'
            tel[reden] = tel.get(reden, 0) + 1
        redenen[s.id] = tel

    return Uitkomst(
        status=naam,
        toewijzingen=toewijzingen,
        opties=gekregen,
        leeg=leeg,
        doel_tienden=doel,
        doel_soort=doel_soort,
        doel_feestdagen=doel_feest,
        werkdagen=wd,
        boven_helft=boven,
        redenen_leeg=redenen,
        tijd_s=solver.WallTime(),
        objectief=solver.ObjectiveValue() if status in (cp_model.OPTIMAL, cp_model.FEASIBLE) else math.nan,
    )

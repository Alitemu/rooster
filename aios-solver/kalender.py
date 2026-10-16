"""
Dates and times for the AIOS roster: the compensation days of a dienst
(docs/aios-rooster.md, hard rules 7 and 8) and the rest between two
diensten (hard rule 9).

The AIOS's own code, apart from the achterwacht's solver (./solver), which
stays as it is (docs/development/diensten.md, "Copied, not changed").
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

MA, DI, WO, DO, VR, ZA, ZO = range(7)  # date.weekday()

# Hard rule 9: at least 14 hours between the end of a dienst and the start
# of the next, 46 after a night block of three or four nights.
RUST_UREN = 14
RUST_NA_NACHTBLOK_UREN = 46
# At most 7 nights in a row.
MAX_NACHTEN_ACHTEREEN = 7


def datum(s: str) -> date:
    return date.fromisoformat(s)


def tijdstip(dag: date, hhmm: str) -> datetime:
    uur, minuut = (int(x) for x in hhmm.split(':'))
    return datetime(dag.year, dag.month, dag.day, uur, minuut)


def begin_en_eind(dag: date, start: str, eind: str) -> tuple[datetime, datetime]:
    """A dienst's start and end; an end at or before its start is the next morning (the night)."""
    b = tijdstip(dag, start)
    e = tijdstip(dag, eind)
    if e <= b:
        e += timedelta(days=1)
    return b, e


def is_werkdag(dag: date) -> bool:
    return dag.weekday() <= VR


def schuif(dag: date, richting: int, feestdagen: set[date], bezet: set[date]) -> date:
    """
    Hard rule 8: a compensation day on a werkdag that is a feestdag moves a
    day away from the dienst (before it: earlier, after it: later), again if
    that is one too. The feestdag itself is then no compensation day. One
    already taken by another compensation day of the same dienst moves on
    too, so a dienst keeps as many compensation days as rule 7 gives it.
    """
    while (is_werkdag(dag) and dag in feestdagen) or dag in bezet:
        dag += timedelta(days=richting)
    return dag


def compensatiedagen(soort: str, vorm: str, eerste: date, laatste: date, feestdagen: set[date]) -> set[date]:
    """
    Hard rule 7: the days after (or before) a dienst on which its AIOS has no
    other dienst, by the table in docs/aios-rooster.md. `eerste` and
    `laatste` are the first and last date of the dienst or block; `vorm` is
    the option's (model.py): ZO_DI, WO_VR, ZA, VIER (wo t/m za), TWEE_DD,
    ENKEL or LOS.
    """
    dag = timedelta(days=1)
    voor: list[date] = []
    na: list[date] = []
    if soort == 'NACHT' and vorm == 'ZO_DI':
        na = [laatste + dag, laatste + 2 * dag]  # wo, do
    elif soort == 'AVOND' and vorm == 'ZO_DI':
        na = [laatste + dag]  # wo; the Sunday's ADW is the block's, nothing before it
    elif vorm == 'WO_VR':
        na = [laatste + dag, laatste + 2 * dag]  # za, zo
    elif vorm == 'VIER' and soort == 'AVOND':
        na = [laatste + dag]  # zo
    elif vorm == 'VIER' and soort == 'NACHT':
        na = [laatste + dag, laatste + 2 * dag]  # zo, ma
    elif vorm == 'ZA' and soort == 'NACHT':
        voor = [eerste - dag]  # vr
        na = [laatste + dag, laatste + 2 * dag]  # zo, ma
    elif vorm in ('ZA', 'TWEE_DD') or (soort == 'DAG' and eerste.weekday() in (ZA, ZO)):
        # A dag- or avonddienst on Saturday, a dagdienst on Sunday or both:
        # the Friday before and the Monday after the weekend.
        zaterdag = eerste if eerste.weekday() == ZA else eerste - dag
        voor = [zaterdag - dag]
        na = [zaterdag + 2 * dag]
    elif soort == 'DAG':
        # A dagdienst on a feestdag in the week.
        voor = [eerste - dag]
        na = [laatste + dag]
    elif vorm in ('LOS', 'ENKEL') and soort in ('AVOND', 'NACHT'):
        # A day of a block cut up (LOS), or an evening or night without a
        # block: the second AIOS on New Year's Eve.
        na = [laatste + dag]
    # UITLOOP: none.

    uit: set[date] = set()
    for d in voor:
        uit.add(schuif(d, -1, feestdagen, uit))
    for d in sorted(na):
        uit.add(schuif(d, +1, feestdagen, uit))
    return uit

# The AIOS's solver (aios-solver/)

Moved out of CLAUDE.md like the other areas; the rules stay there. Read this
when working on the AIOS roster's generation. The design, in Dutch and agreed
with the planner, is docs/aios-rooster.md; this is how the solver holds it.

## Apart from the achterwacht's

The planner's rule (October 2026): the AIOS get their own solver in their own
container, and the achterwacht's (./solver) is not changed for them
(docs/development/diensten.md, "Copied, not changed"). So aios-solver/ is a
service of its own: the same stack (Python 3.11, FastAPI, OR-Tools 9.8, the
same pinned requirements), its own image `ghcr.io/alitemu/rooster-aios-solver`,
its own compose service `aios-solver` (internal network only, `expose`, no
Linux privileges, its own user, `AIOS_SOLVER_MEM_LIMIT`), its own tests in
"Bouwen (test)" (job test-aios-solver). The web container reaches it as
`AIOS_SOLVER_URL` (http://aios-solver:8000); outside Docker `python main.py`
listens on 127.0.0.1:8001. Step 3 (0.74.0) is the solver alone: the app calls
it from step 4 on (generating, the roster per block, publishing).

Files: kalender.py (compensation days, rest), model.py (options, the hard
rules, the objective), controle.py (an independent check of a roster),
main.py (the contract, /health and /solve), test_*.py (test_hulp.py builds
quarters the way lib/aiosDiensten.ts aiosRooster does).

## The contract (POST /solve)

Field names are the AIOS's own and Dutch, like the rest of its code. Input:

- `periode` {van, tot}; `feestdagen`: every feestdag from a week before the
  quarter to a week after it (a compensation day may fall just outside).
- `diensten`: {id, datum, code UD|DD|AD|ADW|ND, start_tijd, eind_tijd (HH:MM;
  at or before the start is the next morning), punten, blok_id}. The app's
  shift_slot rows.
- `blokken`: {id, soort AVOND|NACHT, vorm ZO_DI|WO_VR|ZA|LOS}: shift_block.
  A LOS block's diensten are single (a block the planner cut up, the second
  AIOS on New Year's Eve).
- `aios`: {id, fte (0 < fte <= 1), beschikbaar [{van, tot}] (Geldig
  vanaf/tot), onderbreking, inwerken, parttime_dagen, vier_avonden,
  vier_nachten, twee_dagdiensten, markeringen [{dienst_id, niveau ABSOLUUT|
  LIEVER_NIET|VOORKEUR, bron MANUAL|PARTTIME|ABSENCE}], erboven {counter:
  n}, saldo_punten (a delta: negative = fewer this quarter),
  feestdag_achterstand (positive = had fewer than fair so far)}.
- `tijdslimiet_seconden` (1 to 600, default 60), `seed`.

`erboven` comes from the app's own counters (lib/aiosVoorkeur.ts
blokkadeTellers), so the solver takes exactly what the AIOS's screen
promised: "hoogstens N alsnog". The solver maps an option to its counter the
same way (model.py `_groep`) but does not recount.

Output: `status` OPTIMAAL|HAALBAAR|GEEN_OPLOSSING (|ONMOGELIJK|ONGELDIG,
not expected: an empty dienst is allowed), `toewijzingen` [{dienst_id,
aios_id}], `leeg` [{dienst_id, redenen {reason: how many AIOS}}] (BEZET: could
have, but has a dienst near it), `per_aios` [{punten, doel_punten, werkdagen,
dienstpercentage (fraction), nachten, avonden, dagdiensten, uitloopdiensten,
feestdagdiensten, doel_feestdagdiensten, blokken, liever_niet, voorkeur,
boven_de_helft}]. Malformed input answers 422 (unknown block or dienst,
duplicate ids, a dienst outside the period, fte outside (0, 1], a negative
erboven, an unknown counter).

## The model

One decision per option, not per day: a whole block (zo t/m di, wo t/m vr,
the Saturday), a single dienst (UD, DD, a LOS day), and for who asks for it a
block of four (wo t/m vr plus the Saturday after it, the same soort) or the
two dagdiensten of one weekend. x[aios, option] exists only where the rules
per option allow it (`waarom_niet`, which also gives the reasons in `leeg`).

Hard (each a function in model.py, a test in test_regels.py and a mutation in
scripts/mutation-check.mjs with `cwd: 'aios-solver'`):

1. within Geldig vanaf/tot (`regel_1_beschikbaar`), not during an onderbreking
   (`regel_1_onderbreking`), not on leave or a part-time day, not on a block by
   hand (`regel_1_blokkade`) except from the part above half: per counter at
   most `erboven` such options, each costing W_BOVEN_HELFT;
2. every dienst at most one AIOS, a block whole (options are whole blocks);
3. one dienst a day per AIOS;
4. on a part-time day no UD and no evening option with that day in it, a night
   may (`regel_4_parttime`, on parttime_dagen itself, the marks aside);
5. fte 1.0 never in the night block zo t/m di;
6. inwerken: only UD and DD on Saturday and Sunday;
7. and 8. no dienst on another option's compensation day (kalender.py
   `compensatiedagen`, the design's table), moved off a feestdag on Monday to
   Friday away from the dienst, and off a day that is already one of the same
   dienst's, so a dienst keeps its number of compensation days (the design's
   examples are a parametrized test);
9. rest: 14 hours, 46 after the last night of three or four, at most seven
   nights in a row. With these times the compensation days already give 14
   hours almost everywhere (the design says so too), so the 14-hour rule is
   tested on two diensten directly; the 46 hours also in the model, where
   rule 8 moves a compensation day off a feestdag.

Besides: one loose weekend dienst per AIOS per weekend (DD za, DD zo, the
Saturday's evening or night; the two dagdiensten count as one), and the 4-block
and the two dagdiensten only for who asks for them.

Soft, weighted in one objective (the planner's choice, as the achterwacht's:
fairness before liever niet): W_LEEG per empty dienst (1 000 000), W_BOVEN_HELFT
(20 000) per option from the part above half, W_PUNT (100 per tenth of a point)
off the share plus W_PUNT_MAX on the largest such difference, per soort
(nights 300, evenings 200, dagdiensten 100 per dienst; nights weigh most, H2),
W_FEESTDAG (300) per feestdagdienst off the share over the years, W_LIEVER_NIET
(500), spreading W_SPREIDING (400) per block too many in any two and in any
four weeks (the planner's choice: one block in four weeks; with four weeks
alone three blocks in three weeks came out as cheap as one every other week),
a granted 4-block or two dagdiensten -300, voorkeur -150.

Shares: points to fte x the werkdagen (Monday to Friday, no feestdag) someone
can do diensten on (within Geldig vanaf/tot, not during an onderbreking; leave
counts as an ordinary werkdag, G5), plus the saldo. Per soort the same, and
for who inwerkt the evenings and nights only after the inwerkperiode. The
feestdagen: their number this quarter to the same capacity, plus the
achterstand.

## What it does with a real quarter

Measured on a 13-week quarter with random preferences (20% of the diensten
blocked by hand per AIOS, 10% liever niet, 5% voorkeur, a part-time weekday
for most, a week of leave for half of them, the wishes for one in five, two
feestdagen):
20 AIOS: every dienst filled in 60 s, every dienstpercentage between 18.2 and
18.6%; 30 AIOS: filled in 60 s, 11.1 to 13.5%, nobody more than 0.7 point off
their share; 60 AIOS: filled in 120 s but 2.4 to 9.2%: at four or five points a
quarter one block (2.2 to 3 points) is already a large share of it, and the
saldo carries what is off to the next quarter, as for the achterwacht. No hard
rule broken in any of them (controle.py). The tests with twelve AIOS stop at
their time limit unproven but good; the rest is proven optimal in under a
second.

## The independent check

controle.py checks a roster from the roster alone (dienst -> AIOS), not from
the model's options, with its own wording of the compensation table. Every
solve in the tests goes through it (test_hulp.los_op), random quarters too
(test_willekeurig.py), and test_controle.py makes rosters wrong on purpose so
a check that misses a rule fails as well (with mutations of its own).

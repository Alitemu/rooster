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
listens on 127.0.0.1:8001. Step 3 (0.74.0) is the solver alone; from 0.75.0
(step 4a) the app calls it; 0.76.0 (step 4b) adds the blocks around
feestdagen and New Year's Eve; 0.77.0 (step 4c) gives the app its own
copy of the hard rules, for changing the roster by hand.

## The app's side (step 4a, 0.75.0)

- lib/aiosSolverInvoer.ts builds the request from the database: the
  period's slots and blocks, the feestdagen a week either side, and per AIOS
  taking part (aiosDeelnemers) the fte (lib/aiosFte.ts: a part-time day every
  week is 0,8, every other week 0,9, pro rata over the quarter), Geldig
  vanaf/tot clipped to the quarter, the part-time days (patroonDekt), inwerken,
  onderbreking and the wishes from aios_wens, the marks with their bron, and
  `erboven` from blokkadeTellers. saldo_punten, saldo_nachten (0.107.0: the
  nights target of the quarter before, aios_doel.doel_nachten, minus the nights
  done; NULL for a quarter made before: none), saldo_dagen and
  saldo_weekendavonden (0.108.0, the same from doel_dagen and
  doel_weekendavonden, counting the DD and ADW done) and feestdag_achterstand from
  lib/aiosSaldo.ts (0.79.0, step 4e): the solver's own share of the last
  published quarter the AIOS had one in (aios_doel, kept from per_aios
  doel_punten and doel_feestdagdiensten at every generation, gone with
  "Rooster verwijderen") minus what they did there, as the roster is now;
  before that the history read in (aios_beginstand, against the average per
  fte x maanden of everyone read in); otherwise 0. Since the share the
  solver adds the saldo to is kept, the chain carries on by itself: no
  balance is stored, only the share it is measured against.
- lib/aiosGenereren.ts runs it in the background (its own job store on
  globalThis, as the achterwacht's), only from GESLOTEN or GEGENEREERD, one
  at a time per period (409 GENERATION_RUNNING), and writes in one
  transaction that first checks the period's status and row_version did not
  move. A new generation replaces the whole roster, a change by hand
  included: the screen says so before. "Rooster verwijderen" empties it and
  goes back to GESLOTEN (only from GEGENEREERD); heropenen stays GESLOTEN
  only, so a made roster goes first.
- When making it fails by an exception, the planner is told what failed
  (aiosGeneratieFoutTekst, 0.87.1), not "niet bereikbaar" for everything:
  nothing answers at AIOS_SOLVER_URL (ECONNREFUSED, ENOTFOUND, EAI_AGAIN,
  EHOSTUNREACH or ENETUNREACH: the container is not running, or not in the
  compose file); the connection broke or timed out (ECONNRESET, EPIPE: the
  container stopped or was killed while solving, e.g. out of memory); or
  the app's own fault (an answer it cannot read, the database), which
  gets a foutcode printed in the web log beside the real error. A solver
  that answers with an error status stays "kon geen rooster maken".
  At every start the web container also looks up the host name in
  AIOS_SOLVER_URL and logs a warning when it does not exist (ENOTFOUND, an
  old docker-compose.yml without the service): warnAboutMissingAiosSolver
  in instrumentation-node.ts, a name lookup only, never awaited. The
  full quarter with the image's own dependencies (only requirements.txt)
  solves 4 AIOS in 2 seconds and 25 AIOS in 60 seconds (HAALBAAR) at 330 MB
  at most, so memory is no reason at the 2g limit.
- lib/aiosRooster.ts reads the roster for the page: per day who has what,
  per AIOS points, werkdagen, fte and dienstpercentage (lib/aiosFte.ts, the
  solver's werkdagen), counted from the roster itself so a change by hand
  counts too.
- Tests: app/api/aios/aiosGenereren.test.ts against a fake solver that
  records the request (the contract), tests/e2e/aios-rooster.e2e.ts against
  the real one (AIOS_SOLVER_URL, 8001 in the browser checks).

## Blocks around feestdagen and New Year's Eve (step 4b, 0.76.0)

- lib/aiosFeestdagBlokken.ts asks the questions: per run of two or more
  feestdagen in a row (reeksen) every zo t/m di or wo t/m vr block it falls
  in, evening and night apart, with no default; every other such block with
  a single feestdag, whole unless cut up; and with 31 December in the
  period one or two AIOS on its night. A Saturday is one dienst already and
  never asked. The route .../feestdagblokken (GET, PUT) shows and keeps
  them, also before the period closes, not after publishing and not while
  a generation runs.
- .../genereren answers 409 QUESTIONS_OPEN while a required question has
  no answer. Then zorgVoorOudjaar makes the second night (an ND slot
  without a block, availability copied from the block's night that day,
  again at every generation) or takes it away with one chosen; reopening
  the period takes it away too, so the AIOS never see it on their screen.
- lib/aiosSolverInvoer.ts sends a cut block as vorm LOS; the shift_block
  row stays as made. The solver makes every dienst of a LOS block a single
  option, and a dienst without a block too (ENKEL): the second night. Both
  get the day after as compensation day (kalender.py, the table row "Losse
  avond of nacht door de week"), and controle.py checks the same. Hard rule
  5 (from 0,9 fte on, GEEN_NACHTBLOK_VANAF_FTE in kalender.py, controle.py and lib/aiosRegels.ts) is for the whole nachtblok zo t/m di: such an AIOS may do a single night
  of a cut one (test_regels.py, the planner's design: "elke dag van het
  blok is een losse dienst").
- lib/aiosRooster.ts gives a cut block vorm LOS, so the page draws it per
  day; a box spans only the days one AIOS has. The second night is its own
  row, "Nacht 2", in the week it falls in.
- Tests: app/api/aios/aiosFeestdagBlokken.test.ts (fake solver),
  lib/aiosFeestdagBlokken.test.ts (reeksen, oudjaarIn), the second test of
  tests/e2e/aios-rooster.e2e.ts (real solver).

### The voortgangstoets (0.82.0)

- The night before it is a fellow's (docs/aios-rooster.md,
  "Voortgangstoets"). lib/aiosVoortgangstoets.ts deletes that ND as soon as
  the planner saves the date, so the solver never gets it: the contract is
  unchanged, a block simply comes with a night less (zo and ma, or zo and
  di with the fellow's Monday between). It stays one option for one AIOS.
  kalender.py, controle.py and lib/aiosRegels.ts all count a block's
  compensation days from its last night, which is what the planner chose:
  zo and ma give di and wo. With two nights the 46 hours of rule 9 do not
  apply (three or four nights), the 14 hours do.
- A 4-block still forms when the shortened wo t/m vr block ends on the
  Friday (do and vr with the Saturday), as for a whole one.
- test_regels.py has both shapes; regelgevallen.py leaves a block's night
  out now and then, so tests/fixtures/aios-regels.json has rosters with
  them for both copies of the rules. App side:
  app/api/aios/aiosVoortgangstoets.test.ts, tests/e2e/aios-voortgangstoets.e2e.ts.
- A night that comes back (another date, or none) in a roster already
  made goes to the AIOS who has the rest of its block, row source SOLVER,
  unless that rest is not with one AIOS or they have it ABSOLUUT or an
  ABSENCE mark on it (0.86.0, geefAanBlok; the PUT answers `teruggezet`
  with the night and to whom or why not). It stayed open, the block was
  no longer whole and publishing waited until the planner filled it in:
  app/api/aios/aiosLevensloop.test.ts found it, its first example is that
  sequence.

## The app's copy of the hard rules (step 4c, 0.77.0)

- Changing the roster by hand warns, the solver isn't asked: the user
  chose (October 2026) a copy of the rules in the app over a /controle on
  the solver, so it works without the solver running. lib/aiosRegels.ts
  is controle.py line by line (its eenheden, compensation table, rule 8's
  shift, the rest and seven nights, the weekend), on the request the app
  sends (aiosSolverInvoer) and a roster; it returns controle.py's tuples.
- So the rules are in three places: model.py, controle.py and
  lib/aiosRegels.ts. tests/fixtures/aios-regels.json keeps the last two
  equal: random quarters with random rosters (a block now and then split,
  cut up, a second night without a block), two made for the rarer rules
  (more than seven nights, a 4-block and two dagdiensten without the wish)
  and three of the solver's own solutions, each with what controle.py found.
  test_gedeeld.py runs controle.py over it, lib/aiosRegels.test.ts the app's
  copy; both also check every rule occurs in it. A rule changed on purpose:
  change controle.py and lib/aiosRegels.ts (and model.py), run
  `python regelgevallen.py` in ./aios-solver (it writes the file, and is
  left out of the image like the tests), then both tests must pass.
- lib/aiosHandmatig.ts uses it: per AIOS before choosing (route
  .../rooster/kandidaten) the violations the change adds to that AIOS's own
  (only their own diensten are checked, so another's don't show), their
  marks on it (geblokkeerd, afwezig, parttimedag, liever niet; the
  solver's 1_GEBLOKKEERD and the part above half say the same and are left
  out), a block no longer whole and their dienstpercentage after it above
  25%. Someone not in the pool on the day is refused, as the achterwacht's
  planner is. The change (.../rooster/wijzigen) is one dienst or diensten of
  one block, each with `was`, who the planner saw (409 when it moved);
  written as bron MANUAL with assignment_edit rows (HANDMATIG_VERWIJDEREN,
  HANDMATIG_TOEWIJZEN) and one audit row, answered with its warnings and
  `terug`, the change back ("Ongedaan maken" sends it). Only GEGENEREERD,
  not while a generation runs.
- lib/aiosRooster.ts lists what the whole roster breaks (overtredingen):
  nothing as the solver made it, a change by hand may.
- Tests: lib/aiosRegels.test.ts, aios-solver/test_gedeeld.py,
  app/api/aios/aiosHandmatig.test.ts, the first test of
  tests/e2e/aios-rooster.e2e.ts (a block by hand and back).

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
  A LOS block's diensten are single: a block the planner cut up. So is a
  dienst with blok_id null: UD and DD, and an ND or AD without a block
  (the second AIOS on New Year's Eve).
- `aios`: {id, fte (0 < fte <= 1), beschikbaar [{van, tot}] (Geldig
  vanaf/tot), onderbreking, inwerken, parttime_dagen, vier_avonden,
  vier_nachten, twee_dagdiensten, markeringen [{dienst_id, niveau ABSOLUUT|
  LIEVER_NIET|VOORKEUR, bron MANUAL|PARTTIME|ABSENCE}], erboven {counter:
  n}, saldo_punten (a delta: negative = fewer this quarter), saldo_nachten
  (0.107.0, the same for the nights: negative = fewer nights this quarter,
  default 0), saldo_dagen and saldo_weekendavonden (0.108.0, the same for the
  dagdiensten and the avonddiensten at the weekend, default 0),
  feestdag_achterstand (positive = had fewer than fair so far),
  eerdere_diensten [{id, datum, code, start_tijd, eind_tijd, blok_id,
  blok_soort, blok_vorm}] (0.111.0, what they did in the last eight days of
  the quarter before in the pool: rules 7, 8 and 9 run on over the boundary.
  model.py makes options of them as for the quarter, 4-blocks and two
  dagdiensten kept whole, and forbids what breaks the rest or a compensation
  day of theirs (the reason KWARTAALGRENS); controle.py and lib/aiosRegels.ts
  take them along and judge only the diensten of this quarter)}.
  The answer's per_aios holds doel_nachten, doel_dagen and doel_weekendavonden:
  the fair number of each this quarter, the saldo of the years before
  included (a debt stays a debt).
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

Since 0.112.0 (the audit of what the solver accepts): a time must be a real
one (`99:99` and `24:60` are 422, not a 500), `saldo_punten` lies within
-500 and 500 and `feestdag_achterstand` within -200 and 200 and neither is
infinite or NaN, the period is at most 400 days, a block id comes once, an
AIOS's earlier diensten have distinct ids and fall before the period. The
model's bounds on how far an AIOS may be from their target grow with the
size of that target, so a large carry-over (a saldo of 100 points on a small
quarter) is a large difference and no longer "ONMOGELIJK" with every dienst
empty. The empty roster is the hint, so a short time or a large quarter ends
in HAALBAAR and not in GEEN_OPLOSSING. The time limit is for the whole job,
building the model included. One solve runs at a time (a second answers
429, which the app tells as "nog bezig met een eerder rooster"), and a
search stops as soon as the caller has hung up (model.Stop, polled once a
second in main.py), the way the achterwacht's solver does it: the app
forgets a running generation when it restarts, and the planner pressing
"maken" again used to start a second solve beside the first.
test_regels.py proves it with a request that hangs up after two seconds
(`_Verbinding`): a 120 second search ends within 20 seconds and the next
solve is not turned away with a 429.

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
4. on a part-time day no UD (`regel_4_parttime`, on parttime_dagen itself,
   the marks aside). Its evening may: the app marks it LIEVER_NIET with bron
   PARTTIME (lib/aiosSync.ts), which costs what any liever niet costs (0.82.0,
   the planner's choice; the evening was a hard rule before). Its night has
   no mark (0.83.0, the planner's choice; 0.82.0 marked it liever niet too).
   controle.py and lib/aiosRegels.ts check the UD only;
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
W_SOORT (0.103.0, the planner's order, most important first: nights 1500,
dagdiensten 600, evenings at the weekend 300, evenings in the week 200,
uitloopdiensten 100, per dienst off the share; the evening at the weekend
(ADW) is its own soort, `Slot.eerlijk_soort`; the points are not enough on
their own: an uitloopdienst counts 0,2 and made up for a night not done),
W_FEESTDAG (300) per feestdagdienst off the share over the years, W_LIEVER_NIET
(500), spreading W_SPREIDING (400) per block too many in any two and in any
four weeks (the planner's choice: one block in four weeks; with four weeks
alone three blocks in three weeks came out as cheap as one every other week),
a granted 4-block or two dagdiensten -300, voorkeur -150.

Measured on 20 AIOS in a quarter (120 s, 40% of the options blocked):
before 0.103.0 nights 0 to 8 per AIOS and uitloopdiensten 0 to 14; since,
nights 3 to 6 and uitloopdiensten 0 to 7. Heavier nights (2500) made the
percentages drift apart (14,8 to 19,1) for no gain, so 1500 it is.

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

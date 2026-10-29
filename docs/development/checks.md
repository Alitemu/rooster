# Checks: browser checks, mutations, schema drift

Which of these to run for which change, and in what order, is in
docs/teststrategie.md (Dutch, for the planner and the operator).

The mutation runner puts the source back when it is stopped (SIGINT, SIGTERM,
SIGHUP, a crash) and keeps a copy of each file it mutates in
`.mutation-backup/` (not in git) for a kill it cannot catch: the next run
restores from it first. `--droog` also checks that every test filter names
a file. The replacement text is passed as a function, so `$'` in it is not
a JavaScript replacement pattern (a mutation with one broke the file it
meant to break differently).

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

**The Caddy check** (deployConfig.test.ts) validates the Caddyfile inside
docker-compose.yml with a real Caddy (`CADDY_BIN`, or caddy on the PATH). Without
one it skips and prints a warning; a release run sets `REQUIRE_CADDY=true`, so
a missing Caddy fails instead of passing unseen.

**Browser-level checks** need a seeded database, both solvers and the app
already running (`npm run seed`, `uvicorn main:app --port 8000` from
`./solver`, `uvicorn main:app --port 8001` from `./aios-solver`, then
`ALLOW_SEED_PASSWORD=true SOLVER_URL=http://localhost:8000
AIOS_SOLVER_URL=http://localhost:8001 npm start`) - none of them starts
anything itself. tests/e2e/aios-rooster.e2e.ts makes an AIOS roster with
the AIOS's solver and fails without it, once plain and once over kerst and
oudjaar with the questions about the blocks around feestdagen;
tests/e2e/aios-publiceren.e2e.ts reads in the history from before the
app, publishes one, opens it as the AIOS on their link and makes it
definitief; tests/e2e/aios-ruilen.e2e.ts has one AIOS ask a swap and the
other approve it, each on their own link. ALLOW_SEED_PASSWORD
because they all log in with the seed password, which otherwise only
opens a "choose a new password" session (see Authentication):
- `npm run test:e2e` - the Playwright suite in `tests/e2e`. It builds its
  own period/assignments fixture per file (`tests/e2e/setup.ts`), so it does
  not read the seeded period, only the pool and shift types it finds.
- `node scripts/full-check.mjs` - the API lifecycle against real data,
  including the solver's own hard rules on its untouched output (no
  ABSOLUUT violation, nobody twice in one ISO week, nobody's window rule
  broken, nobody past their streefbereik).
- `node scripts/ui-check.mjs` - the two screens people use most.
- The calendar of the seed, the e2e fixtures, full-check and ui-check
  moves with the real date (scripts/demoKalender.mjs): they were written
  for Monday 4 January 2027 and a period, deadline or shift in the past
  fails them on the calendar alone. Nothing moves while that period starts
  at least six weeks ahead, then whole weeks (the weekday stays).
  `DEMO_SHIFT_WEEKS=60` forces a shift, to try them before the date makes
  it necessary. scripts/demoKalender.test.ts holds the rule and bans a fixed
  2026 or 2027 date in these files.
- `node scripts/scenario-check.mjs` - the planner's own case end to end:
  15 people, a fellow with a part-time Monday, 36 weeks from the Monday of
  ISO week 53 of the next year that has one, at least four weeks ahead (28
  December 2026, then 27 December 2032, found with lib/holidays.ts), opened with the wizard's
  suggested streefbereik, generated with all four methods at windows 0-2
  (SCENARIO_MODES, SCENARIO_WINDOWS, SCENARIO_TIME, default the dialog's
  120 s): nothing empty, no rule broken, then "Rooster verwijderen" and
  again. Where shifts stay empty and the dialog offers "langer proberen"
  (a CP-SAT result not proven best) it tries longer like a planner does,
  2.5 and then 5 times SCENARIO_TIME (300 and 600 s): since the window
  counts days, window 2 for these 15 people needs more than 120 seconds
  (audit 14). "Willekeurig" leaving a dienst is a warning, not a failure,
  and so is "Herhaalplanner" at window 2 (3 attempts here, up to 100 in
  the dialog). Lexicographic at window 2 leaves 1 or 2 diensten empty on
  OR-Tools 9.8, even after trying longer: a known result since audit 14,
  in the achterwacht's solver, which stays as it is.

**Full or short scenario-check.** The full run takes about 35 minutes
(13 generations of 120 seconds or more); the other browser checks take
about 5 minutes per build together. `--kort` runs one method at one window
(weighted, window 1) and the generation after "Rooster verwijderen" with
the same, about a minute. The user chose (October 2026):
- the sub-folder build always gets `--kort`: it checks the paths under the
  base path, and the solver does nothing different there;
- at the root the full run only when the solver or the achterwacht's code
  that makes its input changed since the previous release, i.e. when
  `git diff --name-only v<previous> HEAD -- solver lib app/api
  ':(exclude)lib/aios*' ':(exclude)app/api/aios' ':(exclude)*.test.ts'`
  lists a file; otherwise `--kort` there too.

`node scripts/mutation-check.mjs [name]` needs nothing running: it breaks
one hard rule at a time (a guard removed or weakened in the source),
runs only the tests meant to guard it and expects them to fail; a
mutation that survives is a rule without a test. The source is restored
after each. Add a mutation when adding a guard. A solver guard gets one
too (`runner: 'pytest'`, run in ./solver with SOLVER_PYTHON, a Python
with solver/requirements.txt and pytest; audit 14). One of the AIOS's
solver adds `cwd: 'aios-solver'` (docs/development/aios-solver.md); its
tests, `python -m pytest -q` in ./aios-solver, take about 20 seconds.
test_gedeeld.py there and lib/aiosRegels.test.ts here check the same
rosters (tests/fixtures/aios-regels.json): the solver's check and the
app's copy of the AIOS's hard rules must find the same.

`node scripts/mutation-check.mjs --droog` runs no test: it only checks that
every `find` is still in its file, and once (a find that occurs twice
mutated only the first; say `alles: true` to mutate every occurrence).
Fast, so worth running after changing a file a mutation names. Since
0.111.0 a mutation counts as caught only when a test fails: a timeout, a
syntax or import error that fails the suite while loading, or a crash is
a broken mutation and is reported as such.

Which mutations a release runs (the user's choice in October 2026; until
0.81.0 every release ran all of them, about 12 minutes): a 0.x.0 release
runs `node scripts/mutation-check.mjs --sinds v<the previous 0.x.0>`, the
mutations whose file changed since then or one of whose tests did (a
vitest filter as a path prefix, a pytest file in the solver's folder; the
working tree counts too). Counting from the previous 0.x.0 and not from
the previous release keeps a 0.0.x in between from slipping through. A
0.0.x release runs none. For 0.82.0 that was 144 of the 271, the AIOS's
part; a change to a file with many guards (aios-solver/model.py) runs all
of its mutations.

The solver the browser checks talk to should run the OR-Tools version
of solver/requirements.txt (9.8, the image's): another version searches
differently: in the planner's scenario at window 2 and 120 seconds
lexicographic left 1 shift empty on 9.12 and 8 on 9.8 (audit 14). Three sweeps run with npm
test: app/api/auditCoverage.test.ts (every planner route that changes data
writes the audit log or states why not), app/dutchStyle.test.ts (no
joining dash, no comma before en/of in user-facing text) and
app/buttonContrast.test.ts (white text on a `bg-` or `hover:bg-` colour
reaches 4.5 to 1, measured with the palette of tailwind.config.ts; take
the 700 of green, amber or emerald, not the 600, and the 800 on hover).

`node scripts/schema-drift.mjs` needs nothing running. It builds one
database from the seed and one from the migrations and compares them
column by column, index by index, foreign key by foreign key. Run it after
any schema change: SEED_ON_START defaults to planner, so on a real deployment
it is scripts/seed.ts - not db/migrations - that builds the schema, and
the two drifting apart means production quietly runs a different one than
every test does.

`node scripts/upgrade-drift.mjs [commit...]` covers the other half: a
production database was never built from nothing. It builds one with an
older version's own seed (a git worktree; by default 0.2.0, 0.6.0, 0.8.1
and 0.11.0), runs the current production start over it (seed.ts
--alleen-planner) and compares the result with a fresh database - every
column, index, foreign key and CHECK constraint - and checks no row of the
core tables was lost. Run it after adding a column; it needs the git
history, not a shallow clone.

Two things these get wrong easily, and both cost a day to diagnose:
- **Assert on Dutch.** Every user-facing string is Dutch; a selector looking
  for an English label matches nothing, and a `getByText(/error/i)` that
  never matches looks exactly like a passing test.
- **Fixtures must obey the rules they are not testing.** A fixture that
  hands one person two shifts in the same ISO week has a window-rule
  violation in it, so the publication check flags a warning and every swap
  between those people carries a "two shifts close together" warning -
  noise that has nothing to do with what the test meant to check.

# Roster rules: fellows, membership, bands, the solver, absences, preferences import, capacity

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Fellows

Fellows support the AIOS on the voorwacht on Saturdays, so they don't do
weekends. Per period only (`dienstrooster_period_fellow`), nothing carries
over.

- "Ik ben fellow" on the participant's preferences step (FellowToggle,
  `PUT /api/person/[id]/fellow`), until the deadline like any preference;
  the planner can change it until the roster is generated ("Status
  voorkeuren", audit-logged; 409 on GEGENEREERD/GEPUBLICEERD: it would move
  everyone's weekend band under a built roster, and carry-over reads it
  when the next period opens).
- Ticking blocks every Saturday and Sunday of the period, feestdagen on a
  weekend included, never a weekday feestdag, and never a day the person
  marked themselves (lib/fellows.ts). A weekend day a part-time pattern
  or absence held becomes a fellow block when that lets go of it
  (lib/fellowBlocks.ts restoreFellowBlocks, called where parttimeSync and
  absenceSync delete rows), so it never counts as released. The rows are ordinary ABSOLUUT
  availability with `fellow_blok = 1` (source stays MANUAL: the CHECK on
  `source` predates this), so solver, warnings and publication check need
  nothing special. Unticking removes only `fellow_blok` rows and re-syncs
  part-time patterns and absences; setting such a day by hand clears the
  flag (slot route), an absence takes it over. Never counted against a
  block budget.
- A fellow may release weekend days (clear or mark them). Bands: fellows
  don't count for WEEKEND, so the others' band goes up at generation
  (lib/rosterBands.ts `resolvePeriodBands`: a configured band scaled by
  everyone / the non-fellows, both as effective headcounts, floor/ceil;
  otherwise the default over the non-fellows). A fellow's own WEEKEND band is `[0, released days]`,
  capped at the others' max, without the ledger (`fellowWeekendBand`),
  sent to the solver as `band_overrides` - an optional SolverInput field
  that replaces a person's scaled band and delta for one counter.
  `computeMemberTargets` is the one per-person target (publication check,
  band room in pick lists, "Jouw rooster", invitation indication).
  Carry-over: a fellow's weekend saldo waits; shifts taken anyway pay off
  debt but never create credit (lib/carryOver.ts).
- Planner views: "Fellow" label in Status voorkeuren, Dienstdoende
  (weekend "n.v.t."), and every candidate list; fellows sorted to the
  bottom; own category FELLOW on a fellow-blocked weekend day. The
  generation dialog shows the raised weekend band and whether the
  weekend/feestdag window still fits the non-fellows
  (`checkWeekendCapacity`, lib/fellowSummary.ts) - the window itself stays
  the planner's to set.
- The tick stays when someone's Geldig vanaf/tot moves off the period or
  they leave the pool, so everything counts fellows among the period's
  members only (loadPeriodMembers). The publication check's "Fellows
  tellen niet mee" counted the tick itself and told a planner without
  fellows that the weekend band was raised for them.

## Geldig vanaf/tot (membership window)

Overlapping the period is enough to take part (headcount, coverage factor:
someone leaving halfway gets a proportionally lower streefbereik), but a
shift needs the membership to hold on its own date (lib/membershipWindow.ts,
both ends inclusive). generate-roster sends every slot outside it to the
solver as ABSOLUUT (blockOutsideMembership, not stored); manual-assign and
reassign refuse it (notMemberOnSlotDate); pick lists, herverdeling and swap
candidates leave the person out; swap create and approve refuse it; and
the publication check lists such a shift as an issue (only possible when
the membership changed after the roster was made).

"Today" on Personeel beheren (the members route's Actief, the new
member's start) is the Dutch calendar date (lib/localDate.ts
`localIsoDate`, Europe/Amsterdam), never `toISOString().slice(0, 10)`: that
is UTC, still yesterday until 01:00 or 02:00 Dutch time.

Adding someone reuses an existing participant by codenaam, the exact
spelling; one that differs only in capitals is refused (409
CODENAAM_HOOFDLETTERS, naming the existing one). "persoon-01" for an
existing "Persoon-01" made a second person, and the first one's
carry-over, feestdagdiensten over the years and the flow's row for their
mail stayed behind (audit 13).

Adding someone on "Personeel beheren" starts Geldig vanaf at the pool's
one period being rostered (OPEN, GESLOTEN or GEGENEREERD), and says so
under the form; with none, or two at once, today. Geldig tot is always the
open end 2099-12-31 (lib/membershipDefaults.ts OPEN_EINDE, 0.901.0). It was
the period's own end: an AIOS quarter, so all 30 AIOS were extended by hand
every quarter. Without a period it was 2029-12-31, which would have dropped
everyone added that way at once at the end of 2029. Before that it was
empty, and an end date typed short of the period gave shifts nobody could
take.

Several at once (0.901.0), all through lib/poolLeden.ts, so a reeks adds
nobody the single form would refuse (capitals, an account, the other
dienst, an overlap):
- *Een reeks toevoegen*: aios01 tot en met aios30 (lib/codenaamReeks.ts:
  one beginning, the width of the first number, at most 100), with the dates
  of the single form. Who can't be added is skipped and named, the rest is
  added (POST .../members/reeks).
- *Selecteren en zetten*: a tick per row and "Iedereen selecteren", then a
  new Geldig vanaf and/or tot for the selection (PATCH .../members/selectie).
  All or none: one that would end before it starts, overlap another of the
  same person or be of another pool stops the lot, naming who. A date left
  out keeps each one's own. Reaching a period whose roster exists asks once
  for the lot (lib/membershipRooster.ts). Each change is an audit row.

A mistake on Personeel beheren is told where it was made
(app/planner/pool/[id]/staff/page.tsx): under Toevoegen for a new member,
under its own row for a change or a removal, scrolled into sight; only a
failed load of the list shows above it. Everything showed above the list,
out of sight under 30 or 40 people (tests/e2e/staff-errors.e2e.ts).

## Deelnamefactor (0.93.0, audit 0.94.0)

The planner does not type it in any more, for either dienst: it follows
from the part-time days the person gives themselves in the Deeltijd step
(lib/deelnamefactor.ts `afgeleideDeelnamefactor`). One day off every week is
0,8, one every other week 0,9, none 1,0; a pattern that holds for part of the
period counts pro rata; never below 0,2. It is the AIOS's fte rule
(lib/aiosFte.ts) copied, so the achterwacht does not import the AIOS's code
(lib/deelnamefactor.test.ts checks the two agree for any patterns the AIOS
may enter, one per weekday).

Audit 0.94.0 on top of that:
- **A weekday counts once.** The AIOS's routes always refused a second
  pattern over a day (lib/aiosDeeltijd.ts PATTERN_OVERLAPS) because the
  fte counts each pattern; the achterwacht's did not, so a participant who
  added instead of changed got 0,6 for one day off. The routes now refuse it
  too (lib/parttimeSync.ts `patternsOverlap`, 409 PATTERN_OVERLAPS; even and
  odd weeks of one weekday share no day), and for rows from before the
  derivation takes the union per weekday: every week beats every other
  week, even and odd weeks together are every week.
- **Monday to Friday only.** A part-time day means "I do not work this
  weekday" (PARTTIME_WEEKDAGEN); a Saturday or Sunday pattern from before
  that rule says nothing about the weekday diensten and is left out.
- **Over the membership.** `loadPeriodMembers` derives the factor over the
  days of each membership within the period and combinedMembership weighs
  them by those days, so a pattern that follows a partial membership is not
  diluted by the days outside it.
- **Held per period (0.95.0).** The part-time days change from one period to
  the next, so the factor of a made roster is held when it is made
  (dienstrooster_period_factor, `legFactorenVast`, `bevrorenFactoren`): the
  publication check, the carry-over, the feestdag history and the AIOS's
  dienstpercentage (also over four quarters, each quarter with its own fte)
  count with it afterwards. Only while the period is gegenereerd or
  gepubliceerd; before a roster, and after it is removed, the factor follows
  the part-time days as they are. `loadPeriodMembers` takes `{ vers: true }`
  for the generation itself, which makes a new one. Someone who joined after
  it was made is counted by their part-time days.

- **The solver** gets the derived value: `loadPeriodMembers`
  (lib/rosterBands.ts) overrides the stored column with
  `laadAfgeleideDeelnamefactoren` before the memberships are combined, so
  generate-roster, the targets, the publication check, carry-over,
  the capacity check and the feestdag history all count the same. It does not
  wait for the person to hand in: the Deeltijd step is what it takes (1,0
  without part-time days), as the AIOS's solver does.
- **Personeel beheren** shows it (members route GET, `deelnamefactorVoorLijst`):
  `null` ("nog onbekend") until the person's submission for the period the
  pool is dealing with is BEVESTIGD. That period is the active one (the
  invitations went out last; for the AIOS the day in dienstrooster_aios_
  periode, not the period row), otherwise the latest OPEN, GESLOTEN or
  GEGENEREERD (`relevantePeriode`); with none, everyone is nog onbekend.
  The wizard asks for its own period by its dates (`periodeMetDatums`), and
  the list names the period it is about (`deelnamefactor_periode`). A
  "Voltijd" for someone who has not filled in anything would be a guess.
- **The column** `pool_membership.deelnamefactor` stays in the table, always
  1,0 for new rows, and is no longer read or written (not in the audit rows
  either). The members routes take dates only: a request with only a factor
  is answered "Geen velden om bij te werken". A value typed in earlier is
  ignored: a part-timer without part-time days counts as full-time until
  they are filled in.

## Streefbereik, venster and the solver's phases

- **Bands over the effective headcount.** The default band per teller is
  the period's slots over `effectiveHeadcount` (lib/rosterBands.ts: the
  sum of each member's coverage of the period, times the deelnamefactor
  under NAAR_RATO), floor/ceil; scaledBandForMember then scales it per
  person by the same two factors. Counting heads instead left shifts
  empty: with people joining or leaving halfway everyone's maximum added
  up to fewer shifts than there were. `resolvePeriodBands(config,
  slotCountByTeller, members, fellowIds, distributionMode)` is the
  one entry point (generate-roster, computeMemberTargets, fellowSummary;
  the capacity route's suggested band uses effectiveHeadcount too).
- **One member per person, all memberships together.** `loadPeriodMembers`
  (lib/rosterBands.ts) is the one query for a period's participants:
  someone who stopped and came back within the period has two
  memberships, and `combinedMembership` (lib/coverageFactor.ts) adds their
  days up (dekking) and weighs the deelnamefactor by them. Picking one row
  per person gave someone present the whole period the streefbereik of a
  part of it (audit 7). generate-roster sends the same dekking and factor
  as coverage_factors/participation_factors;
  generate-roster/solverContract.test.ts runs it against a fake solver and
  checks every person's band and the windows against computeMemberTargets
  and resolveWindowWeeks.
- **Carry-over per person** (lib/carryOver.ts; the AIOS's own is
  lib/aiosSaldo.ts, docs/development/aios-solver.md): each member is measured
  against their own scaled target, the one the solver got, not the flat
  band. Someone at factor 0.5 who did their half carries nothing over.
  Booked when a period opens and booked again at every generation
  (`refreshCarryOverForPeriod` in generate-roster's POST, before the job
  reads balances; rows that already say the same stay, a change writes one
  audit row): the previous roster keeps being corrected while the next
  period is open for preferences, and a correction made after it opened
  never reached a ledger (audit 8). A published next period is not
  generated again, so it keeps what it had. Rows are dated ISO like every
  other ledger row (they used datetime('now'), which sorts wrong as text).
- **"Eerdere toewijzingen"** (dienstrooster_prior_assignment, the previous
  roster's last weeks for the window rule across the boundary, read by the
  solver and lib/windowRule.ts; the whole window back since the window
  counts days, lib/priorAssignmentDerive.ts calculatePriorAssignmentWeeks,
  N weeks where N - 1 did in calendar weeks): the AFGELEID rows follow the previous
  roster as it is now - `refreshDerivedPriorAssignments`
  (lib/previousPeriod.ts) at "afleiden" and before every generation, with
  an audit row when something changed. A day someone else works since (a
  swap) gets them, a day nobody works loses its row, rows from a period
  that is no longer the previous one go; HANDMATIG rows (including a day
  the planner cleared) and ONBEKEND stay. They used to be a snapshot that
  "afleiden" again never touched (audit 10). A row is a day before the
  period: the PATCH route refuses a day of the period or after it (400
  NOT_BEFORE_PERIOD, 404 for no period), as the CSV import skips one. It
  took any date, and a row inside the period was a fixed shift for the
  solver and the window checks that nobody held (audit 14).
- **Feestdagdiensten over the years** (lib/feestdagHistory.ts, the
  planner's words after audit 10: "het gaat om het aantal over de jaren
  heen en niet om een specifieke feestdag"). A period has few of them, so
  everyone's FEESTDAG band is 0 or 1 and carry-over (band edges) forgot
  who got the one. Now, per member: over every published period of the
  pool before this one outside the trash (lib/previousPeriod.ts
  `publishedPeriodsBefore`), their fair share of its feestdagdiensten (the
  band weights: dekking, and the deelnamefactor under that period's
  NAAR_RATO) minus what they did, summed = achterstand; plus this
  period's fair share = their target. generate-roster sends it as
  `feestdag_targets` (SolverInput, optional; a caller without it changes
  nothing). The solver pulls each person's FEESTDAG count (manual
  pre-fills included) toward the target rounded half up to a whole shift
  (objective.py add_feestdag_history_objective): a weighted term of 1 per
  shift of distance (a swap outweighs one liever-niet), lexicographic
  phase 2c after the band phases and before liever-niet (so marking every
  feestdag liever niet doesn't keep someone off their count), and in the
  greedy planner only the people furthest from their target take part in
  the tiers. Never on a blocked day and never past a band. Newcomers and
  everyone at the pool's first period start even; there is no import of
  history from before the app. Fellows count like anyone (weekday
  feestdagen are theirs too). solverContract.test.ts holds the targets to
  feestdagTargets; solver/test_feestdag_history.py proves the solver side.
- **Why shifts stayed empty.** generate-roster marks each unfilled slot
  with `reden`: GEEN_LID (no member's Geldig vanaf/tot covers that date)
  or IEDEREEN_GEBLOKKEERD (every member who covers it has ABSOLUUT, the
  membership blocks included), otherwise null; and `bereik_tekort` per
  teller when the members' maximums together (scaled band plus balance, a
  fellow's own weekend band) are fewer than the slots, with `voorgesteld`
  (the band the app would choose itself for the members there are now)
  when a typed band is lower; `deels_lid` counts the members whose
  membership covers only part of the period. The shortfall accounts for
  that many of the unexplained shifts, so they are not named twice.
  RosterGenerationDialog
  words it with lib/unfilledExplanation.ts `explainUnfilled`, per cause,
  instead of one "not enough people" for all of them: a planner whose
  memberships ended halfway the period saw 160 empty shifts with every
  planner and window and nothing on screen said why. The band shortfall is
  one calculation (lib/bandShortfall.ts `computeBandShortfall`), also shown
  before generating: the dialog asks GET .../band-check for the bands as
  typed and warns under "Venster en streefbereik", with "Bereik voor de
  huidige leden" to put in the suggested band (saved at "Genereren" like any
  edit there). A period's band is required when it opens and frozen with
  the then-members, so a pool that changed afterwards needed this (audit 9:
  5-6 avonddiensten worked out for 30 people, generated for 15).
- **Window warnings look across the boundary** (lib/windowRule.ts
  shiftsAround, audit 11): personWouldViolateWindowRule and
  getWindowConflictingPersonIds - manual-assign and reassign warnings, the
  "venster" group in pick lists and herverdeling, swap warnings - weigh the
  person's shifts in this period, in the pool's other periods outside the
  prullenbak (a generated or published roster, or a MANUAL/OVERRIDE
  pre-fill in one still being made; a SOLVER row of a period waiting to be
  generated again is no roster) and the period's "Eerdere toewijzingen".
  They looked inside the period only, while the solver and the
  publication check already looked across: someone who worked the last
  Sunday before a period was offered for its first Monday without a word,
  and a swap in a period's last week said nothing about the next one's
  first. countWindowRuleViolations (publication check) is unchanged.
- **windowWeeks N = at least 7 x N days between two shifts of one
  person** (0.22.0), counted between the shifts' dates, so 1 is 7 days and
  0 switches the rule off (solver/constraints.py add_window_constraints and
  add_prior_assignment_constraints, solver/greedy.py window_ok,
  lib/windowRule.ts tooClose - the warnings, the publication check and
  swaps). It counted ISO weeks (one shift in any N consecutive
  Monday-to-Sunday weeks), and a Sunday and the Monday two weeks later, 8
  days apart, passed a window of 2: the planner read it as "14 dagen of
  meer tussen 2 diensten". The per-teller windows and the cross-type floor
  work as before, in days. With either per-teller window set,
  generate-roster sends both as resolveWindowWeeks reads them (the solver
  would read a missing one as 0). Up to 0.11 a window of 1 counted as off.
  "Nobody twice in one ISO week" follows from this rule at 1 or more, not
  a rule of its own. The holiday spread (holidaySpreadWeeks) still counts
  weeks. The way back, should rosters no longer solve, is the previous
  release (0.21.0), not a setting. The period header shows the windows
  the period generates with (lib/windowWeeks.ts vensterTekst, pure, so the
  page can use resolveWindowWeeks too): it showed the old `windowWeeks`,
  which the wizard sets to the avond window at opening and the generation
  dialog never changes (audit 14).
- **objectiveMode lexicographic** (solver/solver.py `_solve_lexicographic`):
  each phase starts from the previous phase's solution as hints, and a
  phase that finds nothing in its time falls back to the last phase that
  did (a warning in the solver log), never to an empty roster. The phases
  after it still run from that roster (only phase 1 finding nothing ends
  the run): they were skipped, so "eerlijkheid" out of time meant
  liever-niet and voorkeur were never looked at (audit 15). The run is
  OPTIMAL only when every phase was proven optimal; otherwise FEASIBLE,
  so the dialog offers "langer proberen". It reported the last phase's
  status: a phase 1 out of time with 8 shifts empty and a last phase
  proven optimal behind it read as "Optimaal" (audit 14). Each phase
  gets what is left of the budget over the phases still to run, so time a
  quick phase leaves (or a phase with nothing to do, never started) goes
  to the ones after it: every phase had a fixed share decided up front,
  and the planner's scenario used 67 of 120 seconds (audit 14). A larger
  share for phase 1 was tried and left it at 3 empty shifts instead of 8
  on OR-Tools 9.8; weighted left 1 in the same 120 s, so the split stayed
  even. Lexicographic is what the wizard opens every new period with
  (objectiveMode in the frozen ruleset); weighted is the default only for
  a period frozen before that field existed.

## Absences and part-time over what someone marked by hand

One availability row per person per slot, so a sync meets what is there:
an absence (lib/absenceSync.ts) takes over a part-time or fellow block and
any softer marking made by hand (LIEVER_NIET, VOORKEUR, or an empty row) -
a vacation day must never stay open to the solver - and leaves a day
blocked by hand or by another absence alone. A part-time pattern
(lib/parttimeSync.ts) takes over LIEVER_NIET and empty manual rows but
leaves a VOORKEUR (someone wanting to work that particular day), manual
blocks, absences and fellow blocks. What was marked on a taken-over day is
gone when the absence or pattern is removed; the day is then open.

A marking the next sync would take back is refused instead (409, slot
route, audit 8): LIEVER_NIET or VOORKEUR on a day inside one of the
person's absences (IN_AFWEZIGHEID), LIEVER_NIET on a day one of their
patterns covers (IN_DEELTIJD). Written anyway, the day stayed open to the
solver until some unrelated action re-synced it. ABSOLUUT and clearing
are always taken. Changing or removing a pattern re-syncs all the
person's patterns and then their absences, so a day another pattern
covers (switching patterns, the new one added first) is blocked again at
once. app/api/person/[id]/availabilityModel.test.ts drives random
sequences of all of this through the routes and checks after every step
that one more sync of everything changes nothing.

The participant's calendar shows the real block budget per counter
(`blokkadebudget` in GET /api/person/[id]/preferences/[periodId], from
lib/blockBudget.ts blockBudgetLimits: max and whether part-time days are
exempt), counted the way checkBlockBudget counts; without a budget it
shows blocked days out of all days and speaks of no maximum.

## Preferences import (test, beheerder only)

The preferences overview itself (GET /api/exports/preferences/[period-id])
has one column per member of the period (loadPeriodMembers), nobody else:
someone removed from the pool used to stay in it as long as they had
markings left.

"Voorkeuren importeren (test)" next to the preferences overview download
(components/PreferencesImportDialog.tsx, POST
/api/admin/period/[id]/preferences-import, lib/preferencesImport.ts)
reads that overview back after it was filled in and saved in Excel - as
.xlsx only (a re-saved CSV's separator and encoding depend on the
machine). The overview is a workbook itself since 0.20.0, so the
downloaded file goes back in as it is. lib/xlsx.ts reads the first worksheet with Node's zlib, no
library (size-capped before and while inflating, read in one forward pass
without backtracking regular expressions, a cell past column XFD refused:
audit 6 packed a sheet of 20 MB of unclosed rows into a 29 kB upload); a date cell arrives as
Excel's day number, text dates as YYYY-MM-DD or d-m-yyyy. The dialog
sends the file as base64 within the 1 MB body cap. Tests build their
workbooks with tests/fixtures/buildXlsx.ts. Hand markings only: a plain level is set
as MANUAL (like the planner's calendar), an empty cell clears a MANUAL
row, and a cell with "(parttime)", "(afwezig)" or "(fellow)" - or an
empty cell over such a row - is skipped. No block budget. Checking
(`toepassen` false) writes nothing; applying refuses a file with any
problem, and a period whose roster is built (409). Audit-logged; cleared
people are re-synced like the slot route, backups rewritten. A column
header "'-Anna" is matched to -Anna too: the CSV export before 0.20.0
guarded a codenaam starting with =, +, - or @ with an apostrophe, and
Excel keeps it; the workbook holds the name as it is
(preferences-import/roundtrip.test.ts, generated codenamen, the download
itself and as Excel saves it again).
The dialog lists the first 50 changes and says so ("Hieronder de eerste 50
van de N wijzigingen"), and the button reads "Toepassen (N wijzigingen)":
"En nog 3442 wijzigingen" under 50 of 3492 read as the total, and the
check seemed to count wrong until Toepassen said 3492 (the planner's
report; tests/e2e/preferences-import.e2e.ts). Check and apply count the
same plan. A codenaam column twice, a day twice and a column for someone
who does not take part in the period (loadPeriodMembers) are problems:
the copies counted twice and the last one won, and any participant's
codenaam was taken, also from another pool (audit 13).

## Capacity Check (Live)

Two formulas, both checked before generation:

```
1. Total capacity:
   max_shifts = floor(weeks / windowWeeks)
   capacity = active_participants * max_shifts
   Check: capacity >= total_slots

2. Distinct people per window (more restrictive):
   required = 7 * windowWeeks
   Check: active_participants >= required
```

Show live in settings screen with interpretation in plain Dutch.
Since the window counts days (0.22.0) a person can do floor((days - 1) /
(7 x windowWeeks)) + 1 shifts at most, so formula 1 stays a cautious
estimate rather than the exact maximum.

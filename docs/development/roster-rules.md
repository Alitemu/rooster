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
- A fellow may release weekend days (clear or mark them). A liever niet on
  a weekend day counts as released too, so the solver may give that day;
  asked after 1.3.0, the planner chose to leave this as it is. Bands: fellows
  don't count for WEEKEND. A derived WEEKEND band is worked out over the
  non-fellows (lib/rosterBands.ts `resolvePeriodTargets`); a band the
  ruleset names stays as it is (2.5.0, the planner's choice "altijd
  letterlijk", after being told weekend shifts can then stay empty: the
  generation dialog's bereik-tekort says so before generating). Until
  2.5.0 a named band was raised by everyone / the non-fellows with
  floor/ceil, which made [1, 2] "1 tot en met 3". The usual case shows
  the cost: the wizard suggests a weekend band for everyone, then someone
  ticks fellow, and the others' maximums together are exactly the weekend
  shifts (the scenario: 14 x 5 = 70). bereik-tekort says nothing (70 is
  enough on paper), yet at window 2 a method can leave a weekend dienst
  empty. Asked again with that in hand, the planner kept it: "het maken
  van het rooster blijft handwerk", the Dienstdoende tab shows who is
  short. scripts/scenario-check.mjs warns there instead of failing. A fellow's own WEEKEND
  band is `[0, released days]`, capped at the others' max, without the
  ledger (`fellowWeekendBand`).
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

The calendar shows those days (1.1.4): GET .../preferences/[periodId] gives
each slot `niet_in_dienst`, PreferencesCalendar draws it as "niet in dienst"
(a dash, dashed border, in the legend), not to click and not counted in the
block budget, and the slot route refuses a marking there (409
NIET_IN_DIENST; clearing an old one stays possible). Nothing is stored, so
a later change of the dates is right at once. The planner asked: a member
with dates shorter than the period saw those days open. The AIOS has its own
copy (lib/aiosPreferences.ts markeerNietInDienst for its screen,
setAiosVoorkeur refuses a mark on a dienst or block that reaches past the
membership; hard rule 1 already kept the solver off them).

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

The setup wizard's stap 2 "Personeel" (1.1.3, components/SetupWizard.tsx)
writes nothing when it opens. It widened every membership that did not
cover the whole period "the first time this period's staff list is
opened", but that first time lived in a ref and came again with every page
load: a Geldig tot set inside the period, a later Geldig vanaf and an
unticked Actief were undone the next time the wizard opened, someone who
had left was taken in again, and an open end was cut to the period's end on
the way (the planner's report: "die data worden niet opgeslagen"). A member
added there gets the open end too, as on Personeel beheren: it got the
period's own end and so dropped out of the next period, which the widening
then hid. Who has dates outside the period shows as Niet actief, with a
line above the list counting them, and is ticked by hand. A change that
reaches a period with a roster asks in its row ("Toch doorgaan",
lib/membershipRooster.ts), for a date, the Actief tick and a removal, and
every mistake shows under its row or under Toevoegen: it showed above a
list of 30 people, out of sight, and the wizard had no way to say yes, so
such a change could not be saved there at all.
components/wizardPersoneel.test.ts and tests/e2e/wizard-personeel.e2e.ts
hold it.

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
- **Whether it counts (1.1.2).** The factor scales a streefbereik only under
  the verdeelmodus Naar rato (wizard step 4); under Gelijk it changes
  nothing, while the part-time days themselves are blocked either way. The
  planner asked why the column is there when it "does not count". So the
  members route also sends `deelnamefactor_verdeling`, the verdeelmodus of
  the same period (its frozen ruleset, the pool's before it opens; null for
  an AIOS pool, whose fte works otherwise), and Personeel beheren says in
  words whether the factor counts (lib/deelnamefactorVerdeling.ts). Its
  test checks the sentence against `scaledBandForMember` itself. Not
  renamed to fte: the factor follows from the part-time days only, not from
  a contract the app does not know.

## Streefbereik, venster and the solver's phases

- **Each person's band, 2.5.0.** Someone present the whole period at
  factor 1 gets the period's band: the one the ruleset names, literally,
  or the derived one. Everyone else (dekking below 1, or a deelnamefactor
  below 1 under NAAR_RATO) gets their own share in proportion, rounded
  once: `[floor(s), floor(s) + 1]`, s = the exact share (slots over the
  effective headcount) times their factor, or the named band's midpoint
  times it (`scaledBandForMember`). Before, both ends of the band were
  scaled, the minimum down and the maximum up, at every factor: [2, 3] at
  0.7 became "1 tot en met 3", a band of three values (the planner asked
  how a range could be 3 to 5). Over the exact share the maximums still
  add up to every shift and the minimums to no more than there are
  (lib/calendarRules.test.ts, lib/rosterBands.test.ts); over a named
  band that is the planner's, and lib/bandShortfall.ts says so.
- **What the planner is told, 2.6.1 (the audit after 2.6.0).** The warning
  before generating (lib/bandShortfall.ts computeBandShortfall) suggests a
  band worked out over the non-fellows for the weekend
  (resolvePeriodTargets): over everyone it was the typed band again with a
  fellow, and the button "Bereik voor de huidige leden" never came. It also
  reports maximums exactly as many as the shifts: no room, everyone at
  their maximum, and shifts can stay empty all the same (the 2.5.0
  scenario). explainGeenRuimte says so, in the dialog and after a
  generation; generating is not stopped. The table's explanation says
  "naar rato (71%)" for someone counting below 1 (MemberTarget.factor), and
  the publication warning names the period's band as "3 of 4".
- **The app sends each person's band whole.** generate-roster sends
  `band_overrides` for every member and every counter (lib/bandShortfall.ts
  `memberBands`: scaledBandForMember plus the ledger delta, clamped at
  none, a fellow's weekend their own). The solver takes an override as it
  is (only shifts filled in by hand are taken off), so its own scaling of
  band_avond/band_weekend/band_feestdag by coverage_factors and
  participation_factors is not used for the achterwacht's roster: the
  solver's code is unchanged (no change to the solver itself was needed),
  the calculation lives in one place. solverContract.test.ts checks every
  override against computeMemberTargets.
- **Bands over the effective headcount.** The default band per teller is
  the period's slots over `effectiveHeadcount` (lib/rosterBands.ts: the
  sum of each member's coverage of the period, times the deelnamefactor
  under NAAR_RATO), floor and floor + 1. Counting heads instead left shifts
  empty: with people joining or leaving halfway everyone's maximum added
  up to fewer shifts than there were. `resolvePeriodBands(config,
  slotCountByTeller, members, fellowIds, distributionMode)` (the bands)
  and `resolvePeriodTargets` (the bands with their exact share) are the
  entry points (generate-roster, computeMemberTargets, fellowSummary;
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
- **Search time chosen first (2.6.0, the planner's choice "zoals bij de
  aios"):** the dialog has the AIOS's picker: 10 minutes (the default, also
  what the route sends without a body), 15 or 30, or "Zelf kiezen" with a
  whole number of minutes from 1 to 60 (`gekozenZoektijd`; "Genereren"
  waits on anything else). Only for weighted and lexicographic: Herhaalplanner
  and Willekeurig keep their own. After a FEASIBLE result the button offers
  the next of 10, 30 and 60 minutes above the time used. solver/main.py
  takes up to 3600 seconds (the planner's choice again, the one change to
  the solver; its model is as it was). full-check asks 5 minutes for its two
  generations, as before. tests/e2e/zoektijd-kiezen.e2e.ts checks the picker
  and what it sends.
- **Search time (0.905.0, lib/solverZoektijd.ts):** a first run of CP-SAT
  (weighted, lexicographic) searches 5 minutes, sent by the route when the
  dialog asks for none. On the planner's own period (October 2026) 2
  minutes left one shift empty and 5 filled them all. After a FEASIBLE
  result the dialog offers 10, then 30 minutes; each is a new run from the
  start whose roster replaces the one on screen, hand-filled shifts kept
  (the button says so since 0.904.0). solver/main.py takes up to 1800
  seconds: the one change to the achterwacht's solver, the planner's
  choice; its model is as it was. Herhaalplanner sends no time (the
  solver's own 120 s per attempt, up to 100 attempts) and Willekeurig does
  not search. scripts/scenario-check.mjs keeps 120 s for a first run: a
  stricter test than the app's, and a full run would take hours longer.

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

"Voorkeuren importeren" next to the preferences overview download
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

## Rules from the audit of 1.2.2 (1.3.0)

- **A swap onto a day you blocked yourself: a warning, not a refusal.** The
  swap candidates warned about the colleague's blocks only; Persoon-23 got
  21 April through a swap, a day they had blocked themselves (an absence or
  a deeltijddag is stored as an ABSOLUUT marking too), without a word. The
  planner chose a warning over a block: someone may want to work that day
  after all. lib/swapCandidates.ts marks such a shift
  (requester_geblokkeerd, lib/swapEigenBlokkade.ts), the option says "(jij
  hebt die dag zelf geblokkeerd)" and the preview shows
  EIGEN_BLOKKADE_WAARSCHUWING (lib/eigenBlokkadeWaarschuwing.ts) before the
  request goes out; the create route takes it. A liever niet is not marked.
  The AIOS's swap does not offer such swaps at all (its own rules).
- **Rooster vooraf invullen checks one round against itself.** The
  categories come from the server and know only what is already in the
  roster, so one round could put the same person on 14 and 15 January
  without a word. lib/vooraf.ts botsingenInRonde names the other picks of
  the same person in the round within the window (requiredGapWeeks, from
  lib/windowGap.ts, the database-free half of lib/windowRule.ts), next to
  the option and under the slot. sorteerOpRuimte puts who still has room
  first in every group (the grid and the calendar too), "vol" last; a
  voorkeur shows as a green ✓, not a ⚠️.
- **The solver's words.** "had na 5 minuten nog niet bewezen" after 101
  seconds: lib/solverZoektijd.ts names the zoektijd it had, not a duration
  it did not take. "Totale kosten" is gone; "Score (lager is beter)" shows
  only for the Puntenplanner (objectiveMode weighted).
- **Absence days counted once, the same way.** The card of an absence and
  the line under the calendar both name every day of the absence inside
  the period (lib/afwezigheidTelling.ts); the card says apart how many this
  absence blocked itself and the line how many fall on a deeltijddag.
  Before, the card said "7 van de 12 dagen" and the line "10
  afwezigheidsdagen" for the same absence.
- **Words.** "deeltijd" everywhere on the achterwacht's screens (the
  voorkeurenoverzicht writes "(deeltijd)"; the import still reads
  "(parttime)" from an older file), "Afwijking" instead of "Overrule",
  "Personeel beheren" instead of "Medewerkers", "Tot en met" in the range
  message, "2 weekenddiensten extra" and wizard step 5 in words
  (lib/saldoWijzigen.ts saldoInWoorden, beginsaldoInWoorden).

## Rules from the audit of 1.3.0 (1.4.0)

- **A new period starts from the previous period's settings.** Rooster
  instellen always started on Gelijk and a blokkadebudget of 100%: 2027-1
  ran Naar rato, 2027-2 opened on Gelijk, and only "Verdeling: Gelijk" in
  the summary said so. With deelnamefactoren of 0.8 and 0.9 that gives
  part-timers a full-timer's streefaantal. lib/vorigeInstellingen.ts reads
  the pool's latest opened period before this one (a frozen ruleset, outside
  the trash) and GET /api/periods/[id] hands a concept's
  `vorige_instellingen` to the wizard: the verdeling, both windows, the two
  budgets and "deeltijddagen tellen niet mee". Steps 3 and 4 say "overgenomen
  van …"; step 7 shows the budget and, when the planner changed one,
  "Anders dan in … Daar was het: …" (lib/vorigeInstellingenTekst.ts). The
  streefbereik is not taken over (the capacity check works it out for this
  period), nor the solver's advanced settings.
- **The carry-over is on screen.** The CARRY_OVER rows (lib/carryOver.ts)
  showed nowhere for the planner: "Import en correcties" lists imported
  beginsaldi only and "Grote verschillen" starts at 2. The import-balances
  GET returns `doorgeschoven` (doorgeschovenSaldo): the previous published
  period's name and each row as the ledger words it ("1 avonddienst in te
  halen van vorige periode"), or "Er schuift niets door" when the previous
  period settled everyone. Nothing for a concept, which has no rows yet.
- **Labels and announcements.** Every label in the wizard points at its
  field (components/wizardLabels.test.ts), a one-line `{error && ...}`
  message has role="alert" everywhere (app/foutmeldingRol.test.ts), the
  back-up dialog scrolls its answer into view (a wrong password showed only
  a red edge), the participant sees one banner after Publicatie intrekken,
  and a kind of shift the period lacks gets no blocked-days box.

## The expectation a participant gets (2.1.0)

The invitation (lib/periodInvitations.ts indicatieTekst) and the participant's page (components/PersonalRosterView.tsx)
say each person's streefbereik in the words the planner's page uses, lib/bereikInWoorden.ts: "2 of 3 avonddiensten",
"hoogstens 1 feestdagdienst", "geen feestdagdiensten". Until 2.1.0 both named the top of the range as "ongeveer":
in the audit per role of 2.0.2, a period with 60 avonddiensten, 23 weekenddiensten and 1 feestdagdienst for 30
people promised all 30 "ongeveer 3 avonddiensten en ongeveer 1 feestdagdienst"; all 30 got 2 avonddiensten and 29
no feestdagdienst. The page then read "2 avonddiensten toegewezen. Je streefaantal is ongeveer 3", a shortfall that
was none. lib/correcties210.test.ts and lib/fellows.test.ts hold it.

## Each person's streefbereik for the planner (2.2.0)

"Status voorkeuren" (GET .../progress, field `streefbereik`) and the tab "Dienstdoende" (GET .../staffing-overview,
fields `streefbereik`, `uitkomst` and `bereik`) show computeMemberTargets per person: the band of the period scaled for the
person (`basis`) with the saldo of this period folded in (`saldo`: beginsaldo, carry-over and correcties). In
words per kind (lib/streefbereikPerPersoon.ts), with the saldo said when there is one. Dienstdoende lists every
member with a target, also who got no dienst, and marks who falls outside only once the roster has diensten
in it. The AIOS gets none (their fairness is lib/aiosEerlijk.ts). Held by the test in
app/api/planner/period/[id]/import-balances/achteraf.test.ts, on the same import and correcties the solver gets.

2.3.0, the planner's design after three mock-ups: in Dienstdoende the range stands under each bar in brackets
("[2 of 3]", always in numbers, "0 of 1" rather than "hoogstens 1") and, for evenings and weekends, as a dashed
box over the bar (lib/bereikVak.ts, its own file without imports because a client component uses it: the range itself, half a dienst past each edge, never
left of 0). The box stays on the range: a box centred on the count put the same range in two places and was
rejected as confusing, a bar snapped to the middle of the box stopped telling the count. So a count on the
bottom of "2 of 3" ends left of the middle, on the top right of it, one too many half a dienst past the box.
The last column says per kind `uitkomst`: "goed", "1 te veel", "2 tekort" (a fellow's weekend has no box and
no shortfall). Feestdag has no box and no arrow, the planner's choice.


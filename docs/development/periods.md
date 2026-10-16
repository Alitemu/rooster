# Periods, undo and publishing

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Period Management

- **Auto-round** to Monday start, Sunday end on ISO-week boundaries
- **An AIOS period is a quarter** (lib/aiosQuarter.ts): exactly
  Wednesday to Tuesday, Q1 on the first Wednesday after 1 January, so the
  blocks fit. POST /api/planner/periods refuses other dates for an AIOS
  pool (400) and makes the diensten and blocks right away, in the same
  transaction (lib/aiosSlots.ts): its dates never change, unlike an
  achterwacht period's, whose slots wait for "Openen". So an AIOS draft
  does take its days: a second period on the quarter is refused, and one
  from the prullenbak comes back only onto a free quarter. Until the AIOS
  preferences, solver and publishing exist, it can be renamed, put in the
  prullenbak and back, and nothing else: every planner route that changes
  a period answers 409 AIOS_NOG_NIET (aiosNotYetDenial, lib/aiosPeriod.ts;
  in 0.70.0 only open, generate-slots and capacity did, so the beheerder
  could still publish, fill in or invite on one), and periodUsableFor
  refuses it to every participant route, the beheerder acting for an
  AIOS participant included. The absence and part-time syncs leave it
  out (an absence or a part-time day means something else there), and
  the swap routes read no swap of it (LIVE_SWAP_REQUEST_SQL).
  app/api/aiosNotYet.test.ts sweeps all of it: the
  source of every changing handler that asks periodDienstDenial, and every
  changing route called with the AIOS period's ids, open and published,
  leaving it as it was. The new-period form offers the quarters after the
  one running (aiosQuartersToOffer): the running one has started, so its
  deadline could never be set. The period page
  shows its diensten per week with the blocks and points instead
  (components/AiosPeriodOverview.tsx, GET
  /api/planner/period/[id]/aios-diensten), and the setup wizard sends it
  there. app/api/periods/aiosPeriod.test.ts holds it.
- **One period per day:** every day belongs to at most one period of a
  pool (lib/periodOverlap.ts; create and open answer 409 PERIOD_OVERLAP,
  checked on the whole weeks opening rounds to). A period being made
  (CONCEPT) or in the prullenbak takes no days. Opening rounds the start
  back to Monday, and a next period typed to start mid-week reached into
  the last week of the one before: both rosters filled those days, two
  people on one achterwacht day (audit 12). This line used to promise
  "days already assigned in published previous periods are excluded",
  which no code did.
- **Freeze ruleset** when period opens (no retroactive rule changes)
- **Row versioning** for optimistic concurrency on mutable periods
- **Back to OPEN** (`POST /api/periods/[id]/reopen`, "Terug naar open" in
  the period header, two clicks): from GESLOTEN or GEGENEREERD. From
  GEGENEREERD the SOLVER rows and the pending undo go; MANUAL/OVERRIDE rows
  (filled in beforehand, corrections) stay, as a regeneration keeps them.
  Not from GEPUBLICEERD (409): unpublish first, which tells participants.
  The deadline can then be moved like any OPEN period's.
- **Remove the generated roster** (`POST /api/periods/[id]/reset-roster`,
  "Rooster verwijderen" in the period header, a confirmation with a
  checkbox): GEGENEREERD back to GESLOTEN, ready to generate afresh with
  the preferences still closed. The SOLVER rows and the pending undo go;
  with `ook_handmatig: true` the MANUAL/OVERRIDE rows too, for a clean
  start. Not from GEPUBLICEERD (409, unpublish first), nor without a
  generated roster or while a generation runs (409). Audit-logged. Swap
  requests play no part: they only exist on a published roster.
- **Rename** (`PATCH /api/periods/[id]` `{naam}`, "Naam wijzigen" in the
  period list's row): any status, checked like a new period's name
  (validateSingleLine, PERIODE_NAAM_MAX_LENGTH in lib/vrijeTekst.ts),
  audit-logged. Mails already sent keep the old name.
- **The prullenbak** (lib/periodTrash.ts): any status may go in, a
  published one too (participants lose it at once), restorable for 30
  days, then purged with everything that references it (its pending undo
  included). A period in the trash is no previous period: the one lookup
  of "the previous published period" (lib/previousPeriod.ts
  findPreviousPublishedPeriod - carry-over, the overloop confirmation gate,
  "Eerdere toewijzingen") skips it, and lib/previousPeriod.test.ts fails on
  any other place that queries it itself (audit 10). Carry-over already
  booked from it stays when nothing else comes before, as for a roster
  unpublished for the moment. Participants lose it at once on every route
  that looks up a period or acts on a swap request: lib/periodAccess.ts
  isPeriodVisibleToPerson, LIVE_SWAP_REQUEST_SQL for approve, reject and
  cancel, or `verwijderd_op IS NULL` in the query
  (app/api/person/trashSweep.test.ts). The own roster and every swap action
  still answered, and approving moved shifts in a roster nobody could see
  (audit 13). Restoring refuses days another period took meanwhile (409
  PERIOD_OVERLAP, lib/periodOverlap.ts); a draft comes back whatever its
  dates.
- **While a generation runs** manual-assign, reassign, delete and undo
  answer 409 (GENERATION_RUNNING_MESSAGE, lib/rosterGenerationJobs.ts), as
  reset-roster does: the solver's answer, written when it comes, was built
  without the change - on the same day it killed the whole result on the
  UNIQUE constraint, on another it could give someone a second shift that
  week (audit 10). Publish too (audit 11): it mailed everyone the roster
  being replaced, and the generation then died on the row_version.
- **Venster/streefbereik of a generated roster** (PATCH
  /api/periods/[id]/ruleset, the generation dialog saves its edits there
  at "Genereren"): GEGENEREERD goes back to GESLOTEN, like "Rooster
  verwijderen", so it waits for a new generation with the preferences
  still closed. It went to OPEN, which opened them again whenever the
  deadline was still ahead (audit 11).
- **Length:** a period is at most two years (lib/isoDate.ts
  MAX_PERIODE_DAGEN, periodRangeProblem; create, open, the capacity
  check's date overrides and the wizard's first step). Every day becomes a
  slot: a year typed as 2207 made a period of 180 years (audit 11).

**Undo on the period page:** a manual assign/reassign/remove leaves one
"ongedaan maken" (lib/pendingUndo.ts) that records its `onderdeel` - the
heading it was made under (ROOSTER, VOORAF = "Rooster vooraf invullen",
HERVERDELING = "Voorstellen voor herverdeling"; the client sends it, the
route falls back to ROOSTER). PlannerDashboard shows the button inside that
section, so it folds away with it; a hidden herverdeling section hands it
to the roster. A generation clears it, like "Rooster verwijderen" and
"Terug naar open": it belonged to the roster that was replaced (audit 10).

**Publishing (GEGENEREERD → GEPUBLICEERD) and its way back:**

(The AIOS's has its own copy, lib/aiosPublicatie.ts, 0.78.0: the same
columns and two steps, its own check (an empty dienst stops it; a hard
rule of lib/aiosRegels.ts broken or above 25% needs `bevestigd`), its own
mail, no mail on withdrawing. A change by hand on a published AIOS
roster needs a reason, as here. What follows is the achterwacht's.)

- Two steps (lib/publication.ts). `POST .../publish` makes the roster
  voorlopig: status GEPUBLICEERD, `definitief_op` NULL, everyone's shifts
  kept in `voorlopig_rooster_json`, and each participant mailed their own
  shifts (verzendlijst soort ROOSTER_VOORLOPIG) to check. `POST
  .../finalize` ("Definitief maken") is always a manual act, never a timer:
  it reruns the publication check (same issues/warnings rule as publish),
  sets `definitief_op`/`definitief_door_person_id` and mails the final
  shifts with what changed per person since the voorlopige version
  (ROOSTER_DEFINITIEF). Corrections in between are ordinary manual
  assignments on a GEPUBLICEERD roster. Both mails go out after the commit;
  the response's `mail` says whether they did, and the dialog warns before
  the button is pressed that everyone gets a mail at once. A roster
  published before this existed counts as definitief (backfill in
  migration 0020 and LATER_COLUMN_BACKFILL). Participants see a "voorlopige
  rooster" notice while `definitief_op` is NULL.

- `runPublicationCheck` (lib/publicationCheck.ts) distinguishes two kinds
  of finding: `issues` (an unfilled slot - genuinely not finished, always
  blocks) and `warnings` (an ABSOLUUT or window-rule violation already
  sitting in the roster, or someone outside their streefbereik). The
  solver can never produce an ABSOLUUT or window-rule violation itself -
  both are hard constraints on its side - so those warnings always mean a
  planner deliberately overrode it via manual-assign ("in consultation
  with the person taking the shift"), or, for the window rule, that two
  participants agreed to a swap leaving one of them with two shifts close
  together. That is their own call: swaps are never refused over the
  window rule, only flagged to both sides (lib/swapWindowRule.ts). A band violation is a warning too:
  going over is hard-capped in the solver (MAX_BAND_OVERSHOOT = 0), so
  that is always a manual choice, and going under is deliberately soft
  there, so it can be a legitimate outcome when supply can't meet demand
  - either way a planner may knowingly publish it. Warnings require
  `confirmOverrides: true` on `POST .../publish` (409 without it) but never
  block on their own - blocking on the same override a planner just made
  on purpose would mean no roster using it could ever be published.
- `POST .../unpublish` is for a roster published by mistake (the
  planner's words after audit 9: a published roster only changes through
  swaps, and nobody withdraws one while working on the next period - so
  carry-over, which skips an unpublished period, is not guarded against
  that). It reverts GEPUBLICEERD back to GEGENEREERD: clears
  `gepubliceerd_op`/`gepubliceerd_door_person_id` and the definitief
  fields and snapshot (publishing again starts voorlopig), keeps every assignment
  (withdrawing is not discarding the roster), keeps notifications already
  sent (a historical record) and sends a new one telling participants the
  publication was withdrawn.

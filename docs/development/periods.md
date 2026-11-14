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
- **The AIOS's deadline** (0.809.0) is guarded by the deadline the planner saw (`was`), not by row_version: its pages
  never carry the row_version, and the deadline is what two people overwrite. A different `was` answers 409
  `DEADLINE_CONFLICT`; the UPDATE itself checks the deadline it read, so a change in between is caught too
  (lib/aiosStatus.ts, app/api/aios/aiosApart.test.ts).
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
- **Order of periods** (lib/periodVolgorde.ts): a period is generated and
  published only after the latest period of its pool before it is
  published (409 VORIGE_PERIODE_NIET_GEPUBLICEERD, with the name and the
  state of that one). A period in the prullenbak does not count. Its saldo
  comes from that one (lib/previousPeriod.ts), so skipping it books the
  difference twice or not at all. Generating needs GESLOTEN (or
  GEGENEREERD, to go again), so preferences and absences are fixed.
  Reopening (back to OPEN) catches up the part-time and absence blocks
  that only follow changes while a period is OPEN, wipes the frozen
  deelnamefactoren and is refused (409) once the period has started.
- **Membership and a roster**: changing or removing a membership on days
  that fall in a GEGENEREERD or GEPUBLICEERD period answers 409
  LIDMAATSCHAP_RAAKT_ROOSTER until the planner confirms (`bevestigd: true`,
  `?bevestigd=1` for DELETE; lib/membershipRooster.ts). The roster does not
  change with it.
- **Rename** (`PATCH /api/periods/[id]` `{naam}`, "Naam wijzigen" in the
  period list's row): any status but not in the prullenbak (404 there), checked like a new period's name
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
- **A generation and the prullenbak (0.112.0):** a period is not put in the
  prullenbak while a generation runs for it (409 GENERATION_RUNNING), and a
  roster that comes back from the solver after it went there by another way
  is not written (the apply transaction asks verwijderd_op too, for the
  achterwacht and the AIOS: the prullenbak bumps no row_version). The factors
  a generation holds (dienstrooster_period_factor) go back to what they
  were when it ends without a roster: failed, no solution, a conflict, a
  lost connection to the solver.
- **Nothing changes in the prullenbak** (lib/periodTrash.ts
  trashedPeriodDenial, the full audit, 0.86.0): every changing
  achterwacht route under a period's path answers 409 PERIOD_TRASHED
  ("Deze periode staat in de prullenbak. Zet hem eerst terug."), except
  coming back, purging, renaming and cancelling a generation that runs.
  The period page still opened from a bookmark or a tab left open, and
  from there it was opened, generated and published: the verzendlijst
  told everyone about a roster none of them could open. Only "Terug naar
  open" and "Rooster verwijderen" asked. Since 0.96.0 the period page of a
  period in the prullenbak shows nothing of it (components/PeriodeVerwijderd.tsx,
  `data-testid="periode-verwijderd"`): a planner is told to bring it back
  through the Prullenbak, a participant with their link is told to ask a
  new one on the startpagina ("Link kwijt?"). The same for the AIOS: its
  verify-link answers 410 PERIOD_DELETED for a link of its own period in the
  prullenbak, and both participant pages show that page. A
  planner acting for a participant loses it too (lib/periodAccess.ts
  periodUsableFor). app/api/periodTrashGuard.test.ts sweeps both halves:
  the source of every changing handler, and every one of them called on
  a published period in the prullenbak. The AIOS's routes find no
  quarter there at all (aiosUitnodigPeriode).
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
Undoing gives back the roster from before the change, the source of the
row included: "Wisselen" writes a MANUAL row, and its undo put the person
back but left that MANUAL, so a solver's dienst stayed fixed through the
next generation and "Rooster verwijderen" (the full audit, 0.86.0). The
payload keeps `previous_bron`. The model test
app/api/planner/period/[id]/assignments/handmatigModel.test.ts runs random
toewijzen, wisselen, verwijderen and ongedaan maken against it;
app/api/periods/periodLevensloop.test.ts does the same for the period's
steps from concept on, with a stand-in solver.

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
  publication was withdrawn. No mail goes out, and until 1.3.0 that notice
  was invisible: the participant's page showed "🔔 Meldingen" only for a
  published roster, while the dialog promised "krijgt een melding" (audit
  1.2.2). Meldingen now shows in every status, the dialog says "Er gaat
  geen mail" and that they see it when they open their link, and the page
  of a generated but unpublished roster says so in one banner
  (`rooster-nog-niet-gepubliceerd`) instead of two that contradicted each
  other (app/person/[token]/meldingenZichtbaar.test.ts, the last test of
  tests/e2e/publication-workflow.e2e.ts).

## The wizard's last step (1.6.0)

"Periode instellen" (components/SetupWizard.tsx) read its data per step: the
proposed streefbereik (`GET /api/periods/[id]/capacity`) only while step 3
was on screen, the staff only on step 2 or 6. A planner who came back to a
concept period and went straight to step 7 read "0 actief" with everyone
active and could not open. After a look at step 2 the period opened on the
range the code started with, 7 or 8 avonddiensten whatever the period, and
every invitation promised "ongeveer 8 avonddiensten" (audit per role, R-01;
six scenarios, two of them wrong).

Now both are read on every step and again when the dates, the window or the
verdeling change. The fields start empty. Step 7 shows the streefbereik in
words and four checks (components/wizardControles.ts): periode en deadline,
personeel and streefbereik must hold before "Periode openen" works, the
capacity is a warning. With nobody active the button is off and says why;
someone added in step 2, or dates moved in step 1, turn it on again and that
person is in the period (the planner's wish). tests/e2e/wizard-openen.e2e.ts
opens three periods this way and reads what was frozen;
components/wizardControles.test.ts holds the checks,
components/wizardOpenen.test.ts the three places in the source.

Not kept: a window, verdeling or budget the planner chose without opening.
Coming back, the wizard starts from the previous period's settings again
(lib/vorigeInstellingen.ts); step 7 shows what it opens with (option A, the
user's choice; keeping a draft in the browser or on the server were B and C).

## The period page and its roster (1.7.0)

From the functional audit and the audit per role (all of section 2 of the overview, the user's choice):

- **The streefbereik while the period is open (R-06).** It could be changed only in Rooster genereren,
  which is closed while the period is open, so a wrong range went into every invitation without a way
  back. "Aanpassen" next to the streefbereik on the period page, only while OPEN
  (components/streefbereikAanpassen.ts), saves through PATCH /api/periods/[id]/ruleset: the route of
  Rooster genereren, which took an open period all along, writes the audit log and refuses an old
  row_version. Not a change to "the ruleset is frozen when a period opens": that freeze is about the
  pool's ruleset, the period's own copy was always the planner's to change. The invitations name the
  expected number (lib/periodInvitations.ts indicatieTekst), so after `uitgenodigd_op` (now in GET
  /api/periods/[id] for the planner) the page says they named the old one and that sending them again
  gives the new. Kept small at the user's request: no proposal of the app in that editor.
- **Periode sluiten (R-08)** asks the dashboard's submission_stats at the first click and says how many
  have not confirmed and how many filled in nothing (lib/sluitVraag.ts), before the second click.
- **Empty diensten in the tab Lijst (F-03).** `?met_lege=1` on GET .../assignments returns every dienst
  of the period, an empty one as a row with id null and `leeg: true`, paged over the diensten; a search on
  a person stays a list of toewijzingen. The list asks for it once the roster is made
  (lib/rosterLijst.ts toonLegeDiensten) and fills an empty row through manual-assign, its candidates from
  slots/[slotId]/eligible-people, as the calendar does. Without the flag the route is what it was.
- **Rooster vooraf invullen (F-05, F-02)** is "Lege diensten aanvullen" once the roster is made
  (lib/vooraf.ts voorafNaam: section, button, page and the warning before generating). Below sm a dienst
  and its list of names stack (components/voorafOpTelefoon.test.ts, measured at 375 pixels in
  tests/e2e/lege-diensten.e2e.ts).

## Volgende stap (1.8.0)

One line at the top of the period page of the achterwacht, always there (the planner's wish), with what
to do now: lib/volgendeStap.ts picks it from what the dashboard already reads (status, deadline,
submission_stats, the empty diensten of FillGapsSummary, whether mail is set up) plus two dates the
dashboard route now returns, `uitgenodigd_op` and `gepubliceerd_op`. The order is the planner's: invite,
remind until the deadline, close, generate, fill what stayed empty, voorlopig, definitief. Nothing for a
concept (the wizard's) or a status it does not know, and no button where nothing can be done (mail not
set up, a definitief roster).

The button is a signpost, never an action: STAP_PLEK in components/PlannerDashboard.tsx opens the section
the step is in and gives the existing button the focus (knop-uitnodigingen, knop-periode-sluiten in the
page header, knop-genereren and so on); lib/volgendeStap.test.ts fails when an id it points to is gone.
The AIOS gets its own copy only when the planner of the achterwacht finds it useful. A different layout
of the page (the sections as a list on the left) is on docs/todo.md.


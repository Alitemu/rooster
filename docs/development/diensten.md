# Diensten: the achterwacht and the AIOS

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Diensten: the achterwacht and the AIOS

Two rosters with two planners, who never see each other's pools,
periods, rosters or preferences (the planner's words: "Ze mogen elkaars
rooster en voorkeuren niet inzien"). The AIOS roster is designed in
docs/aios-rooster.md (agreed with the planner: blocks, points, the
dienstpercentage, the hard rules) and built in steps; until its accounts
are switched on (step 5), an AIOS account is refused
(DIENST_NIET_IN_PRODUCTIE) and the separation is ready for it.

- A pool's `type` is its dienst, a staff account's `dienst_type` theirs
  (AuthContext.dienst, read live like the role; null counts as
  ACHTERWACHT, what migration 0022 gave every account). The beheerder
  sees every dienst (the planner's choice), a planner only their own
  (lib/dienstAccess.ts).
- Every route with a period or pool id answers 404 "Niet gevonden" for
  the other dienst's, before anything else (periodDienstDenial /
  poolDienstDenial right after requirePlannerAccess). A participant of the
  other dienst is refused by personAccessDenial (requirePersonAccess asks
  staffMayAccessPerson), and a participant route that takes a period
  (path, query or body) asks periodUsableFor (lib/periodAccess.ts): a
  planner passed those on their role alone, and with their own
  participant and the other dienst's period id the fellow route wrote into
  that roster. The lists (periods, prullenbak, pools) hold only the own
  dienst; a period is made only in a pool of it.
- A participant belongs to one dienst: adding someone who is in a pool of
  another type is refused (409 ANDERE_DIENST, the beheerder too), and the
  imports that look a codenaam up (prior assignments, holidays) treat
  someone of the other dienst as unknown.
- The active period is per pool (lib/activePeriod.ts getActivePeriod(poolId),
  getActivePeriods): one for the app kept the AIOS planner from inviting
  while the achterwacht's period was open, and the refusal named it.
  "Link kwijt?" offers the links of every pool's active period, one
  verzendlijst per dienst to its own flow (linkAanvraagKandidaten).
- One shared Gmail account for both (the planner's choice), and a flow per
  dienst (the planner's choice in October 2026): Mailinstellingen hold the
  achterwacht's flow address and the AIOS's (`mail.verzendlijst_aan_aios`).
  Every verzendlijst goes to the flow of its period's dienst
  (sendVerzendlijst(lijst, dienst), dienstVanPeriode); with no address for
  that dienst nothing goes, invitations answer NOT_CONFIGURED before a
  link is issued, and a swap mail waits in the queue without holding up
  the other dienst's (runFlush skips it). Only the beheerder saves or
  removes them (403 for a planner, who sees them read-only, with only
  their own dienst's address): a planner who could point a flow mailbox
  elsewhere would get the other dienst's personal links.
- Codenamen: staf01, staf02, ... for the achterwacht and aios01, ... for
  the AIOS (lib/startParticipants.ts). A production start creates
  staf01..staf30; an installation from before had Persoon-01..30, renamed
  once at its next production start (--alleen-planner or --schema-only,
  never the demo seed) to stafNN, the setting codenamen.staf_hernoemd
  keeping it from running again (a Persoon-NN added later stays). The
  operator renames the rows in the flow's Excel list at the same moment.
- The AIOS roster is built in steps (docs/aios-rooster.md,
  "Bouwvolgorde"). Step 1 (0.70.0): the AIOS pool exists at every start
  (lib/aiosPool.ts), an AIOS period is a quarter with its diensten and
  blocks (lib/aiosQuarter.ts, lib/aiosDiensten.ts, lib/aiosSlots.ts), and
  its page shows them with the points; every achterwacht step on it is
  refused until the next steps (lib/aiosPeriod.ts, swept by
  app/api/aiosNotYet.test.ts, whose ALLOWED lists what an AIOS period may
  go through). Step 2 (0.72.0): the preferences. The open route opens an
  AIOS period by its own rules (lib/aiosOpen.ts: a deadline before the
  quarter, an AIOS taking part; no ruleset frozen, no carry-over, the
  syncs run), and the deadline, invitations (their own text,
  aiosInvitationBericht, without the achterwacht's streefaantal),
  reminders, a link for one person, closing and reopening take it. The
  participant page shows the AIOS their own steps when /api/periods/[id]
  says `dienst: 'AIOS'` (components/AiosPreferences.tsx): Deeltijd and
  afwezigheid without the check step, their requests (aios_wens) and the
  grid per week with a block as one box, then Bevestigen. The rules are in
  lib/aiosPreferences.ts, what the browser counts with in lib/aiosVoorkeur.ts.
  The planner's page of an AIOS period has the steps and "Status
  voorkeuren" (/api/planner/period/[id]/aios-voorkeuren) with the 50%
  warnings. app/api/aiosOpen.test.ts and lib/aiosPreferences.test.ts hold
  it, tests/e2e/aios-voorkeuren.e2e.ts in the browser. The staff page of the AIOS pool suggests
  aios01 as a codenaam and has no deelnamefactor: an AIOS's fte follows
  from their part-time days. The pool list sorts without regard to
  capitals, or "AIOS" came before "Achterwacht" in the beheerder's
  new-period form.
- app/api/dienstSeparationOwn.test.ts holds it from inside each dienst
  (the achterwacht audit, 0.71.0): every answer to the own planner with
  its own ids, downloads included (a workbook read for its strings), and
  to the own participant's link holds nothing of the other dienst; a
  participant's link with the other dienst's period, slot, swap and notice
  changes nothing of it; the verzendlijst the achterwacht sends names only
  its own, and a reminder to an AIOS codenaam is refused; a generation
  sends the solver only its own pool; "Link kwijt?" pairs everyone with a
  period of their own pool. Both separation tests build their two worlds
  with tests/fixtures/dienstWorlds.ts.
- The participant's swap dialog names the flow mailbox of their own
  dienst for a swap the app cannot make (lib/appSettings.ts
  getSwapContacts(dienstVanPersoon)).
- app/api/dienstSeparation.test.ts holds it: two complete worlds, every
  route file called by each world's planner with the other's ids (and
  for participant routes their own participant with the other's period,
  slot and swap in path, query and body), expecting 401/403/404, nothing
  of the other world in any answer, and the other world's rows unchanged;
  the same GETs by the own planner and the beheerder must find their ids.
  A route added later is covered without anyone remembering to.

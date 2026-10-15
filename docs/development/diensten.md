# Diensten: the achterwacht and the AIOS

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Diensten: the achterwacht and the AIOS

Two rosters with two planners, who never see each other's pools,
periods, rosters or preferences (the planner's words: "Ze mogen elkaars
rooster en voorkeuren niet inzien"). The AIOS roster itself is designed
but not built yet (docs/aios-rooster.md, agreed with the planner: blocks,
points, the dienstpercentage, the hard rules); until it is, an AIOS account
is refused (DIENST_NIET_IN_PRODUCTIE) and the separation is ready for it.

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
  "Link kwijt?" offers the links of every pool's active period.
- One shared Mailinstellingen and flow for both (the planner's choice), so
  only the beheerder saves or removes them (403 for a planner, who sees
  them read-only): a planner who could point the flow mailbox elsewhere
  would get the other dienst's personal links.
- Codenamen: staf01, staf02, ... for the achterwacht and aios01, ... for
  the AIOS (lib/startParticipants.ts). A production start creates
  staf01..staf30; an installation from before had Persoon-01..30, renamed
  once at its next production start (--alleen-planner or --schema-only,
  never the demo seed) to stafNN, the setting codenamen.staf_hernoemd
  keeping it from running again (a Persoon-NN added later stays). The
  operator renames the rows in the flow's Excel list at the same moment.
- The AIOS roster is built in steps (docs/aios-rooster.md,
  "Bouwvolgorde"). Step 1 (0.26.0): the AIOS pool exists at every start
  (lib/aiosPool.ts), an AIOS period is a quarter with its diensten and
  blocks (lib/aiosQuarter.ts, lib/aiosDiensten.ts, lib/aiosSlots.ts), and
  its page shows them with the points; opening it is refused until the
  next steps (lib/aiosPeriod.ts). The pool list sorts without regard to
  capitals, or "AIOS" came before "Achterwacht" in the beheerder's
  new-period form.
- app/api/dienstSeparation.test.ts holds it: two complete worlds, every
  route file called by each world's planner with the other's ids (and
  for participant routes their own participant with the other's period,
  slot and swap in path, query and body), expecting 401/403/404, nothing
  of the other world in any answer, and the other world's rows unchanged;
  the same GETs by the own planner and the beheerder must find their ids.
  A route added later is covered without anyone remembering to.

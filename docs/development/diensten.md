# Diensten: the achterwacht and the AIOS

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Diensten: the achterwacht and the AIOS

Two rosters with two planners, who never see each other's pools,
periods, rosters or preferences (the planner's words: "Ze mogen elkaars
rooster en voorkeuren niet inzien"). The AIOS roster is designed in
docs/aios-rooster.md (agreed with the planner: blocks, points, the
dienstpercentage, the hard rules) and built in steps, on code of its own
("Copied, not changed" below); until its accounts are switched on (step
5), an AIOS account is refused (DIENST_NIET_IN_PRODUCTIE).

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
  "Bouwvolgorde"). Step 1 (0.70.0): the AIOS pool exists at every start
  (lib/aiosPool.ts), an AIOS period is a quarter with its diensten and
  blocks (lib/aiosQuarter.ts, lib/aiosDiensten.ts, lib/aiosSlots.ts), and
  its page shows them with the points; every achterwacht step on it is
  refused (lib/aiosPeriod.ts, swept by app/api/aiosNotYet.test.ts). Step 2
  (0.72.0), the AIOS's preferences, is built on the AIOS's own code, see
  "Copied, not changed" below. The staff page of the AIOS pool suggests
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
- The participant's swap dialog names the achterwacht's flow mailbox for a
  swap the app cannot make (lib/appSettings.ts getSwapContacts). The AIOS
  swap later on their own screen, with their own flow (docs/aios-rooster.md).
- app/api/dienstSeparation.test.ts holds it: two complete worlds, every
  route file called by each world's planner with the other's ids (and
  for participant routes their own participant with the other's period,
  slot and swap in path, query and body), expecting 401/403/404, nothing
  of the other world in any answer, and the other world's rows unchanged;
  the same GETs by the own planner and the beheerder must find their ids.
  A route added later is covered without anyone remembering to.

## Copied, not changed

The planner's rule (October 2026): after the login page, the AIOS goes its
own way. Code that works for the achterwacht is not changed for the AIOS;
what the AIOS needs is copied into files of its own, so the achterwacht
can't break because of the AIOS. Shared are only the login (the login
page, /api/auth/*, verify-link, sessions, accounts), the database (the
same tables; an AIOS's rows are apart through the AIOS pool) and the
Gmail account of Mailinstellingen. The AIOS's solver is its own container
(aios-solver/, 0.74.0, docs/development/aios-solver.md); the achterwacht's
solver stays as it is.

Since 0.71.0 the achterwacht's code is unchanged. The AIOS's:

- Pages: app/aios/[token] (the AIOS's personal link, /aios/<token>) and
  components/Aios*.tsx. The achterwacht's period page renders
  AiosPeriodOverview for an AIOS period, a line that was there in 0.71.0;
  the overview loads and reloads its period from the AIOS's own route.
- Routes: app/api/aios/ only. deelnemer/[id]/... for the AIOS
  participant (their screen, a mark, their requests, handing in, deeltijd,
  afwezigheid), periode/[id]/... for the planner (the period, openen,
  deadline, sluiten, heropenen, uitnodigingen, links, herinneringen,
  auto-herinneringen, voorkeuren, download-voorkeuren, download-verzoeken),
  mail-instellingen (the AIOS's flow address, beheerder only)
  and link-aanvragen. Every one loads only an AIOS period
  (lib/aiosRoute.ts, loadAiosPeriode).
- Libraries: lib/aios*.ts. aiosMail.ts (the verzendlijst to the AIOS's own
  flow, from the shared account; key aios.mail.verzendlijst_aan),
  aiosSync.ts (leave and part-time days into AIOS periods, the AIOS's
  rules), aiosDeeltijd.ts (the part-time and absence routes' logic),
  aiosUitnodigen.ts (links to /aios/, the texts, who to remind),
  aiosOpen.ts and aiosStatus.ts (the steps), aiosPreferences.ts and
  aiosVoorkeur.ts (the screen's rules), aiosVoorkeurBackup.ts,
  aiosAutoHerinneringen.ts (a copy of lib/autoReminders.ts, 0.73.0) and
  aiosDownloads.ts (the planner's two workbooks, 0.73.0).
- Tables of its own: aios_wens and aios_periode (when the AIOS were
  invited, under which address, and whether their automatic reminders
  are on). An AIOS period never gets
  schedule_period.uitgenodigd_op: that makes a period the achterwacht's
  active one, which its "Link kwijt?" runs over. Both tables cascade on
  delete, so the achterwacht's prullenbak takes them with the period.

The achterwacht's code keeps refusing an AIOS period (aiosNotYetDenial,
periodUsableFor, the syncs' AIOS exclusion). Where it runs over every
period by itself, the AIOS's data keeps it away instead of a change to it:
an AIOS period opens with auto_herinneren = 0, so the achterwacht's
automatic reminders (lib/autoReminders.ts) never take it. The AIOS's own
(lib/aiosAutoHerinneringen.ts) take only AIOS periods and keep their
switch in aios_periode. The server's hourly check (instrumentation-node.ts)
runs them in a try of their own after the achterwacht's: one line added
there, the achterwacht's call unchanged, and a failure in either leaves
the other alone. The one shared
screen part that knows both is "Link kwijt?" on the start page
(components/LinkAanvraagForm.tsx), part of the login page: it asks both
routes and takes the achterwacht's answer first.

app/api/aios/aiosApart.test.ts holds both halves: the AIOS's routes take a
quarter from opening to closing, and the achterwacht's code, unchanged,
leaves an open AIOS period alone (its opening refuses it, its automatic
reminders and "Link kwijt?" never pick it up, its absence route does not
write into it, its prullenbak takes the AIOS's rows). The sweeps treat
app/api/aios/deelnemer/ like person/ (participant routes).

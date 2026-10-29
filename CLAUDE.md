# Dienstrooster - Claude Code Guide

## Project Overview

Dienstrooster is a scheduling application for medical wards (20-40 staff members) with:
- Fair shift distribution using solver (CP-SAT)
- Preference blocking (absolute + soft)
- Feestdagdiensten fair over the years (the count, not which feestdag)
- Part-time support
- Automatic roster generation with diagnostics

Two rosters with two planners: the achterwacht (in production) and the AIOS
(in use since 0.81.0; designed in docs/aios-rooster.md, steps 1 to 5 are in), kept apart
in every route (docs/development/diensten.md).

This file holds the rules. The background per area - why a rule exists, what
went wrong before, which file does what - is in docs/development/ (see
"Where things are"); read the file for the area you work on. A code comment
that says "CLAUDE.md, ..." points to a section that now lives there.

## Standing instructions from the user

- Answer the user in Dutch, with the Dutch style rules below.
- **Achterwacht and AIOS apart:** after the login page each goes its own
  way. Code that works for the achterwacht is not changed for the AIOS:
  what the AIOS needs is copied into its own files (lib/aios*.ts,
  app/api/aios, app/aios, components/Aios*), docs/development/diensten.md
  "Copied, not changed". Shared: the login, the database, the Gmail
  account. The AIOS gets its own solver in its own container; the
  achterwacht's solver is not changed.
- The repository is public: no organisation names, domains, e-mail
  addresses, IP addresses, internal paths or real names of people anywhere
  in it (code, docs, tests, commit messages). Files the user shares
  (rosters, forms) stay out of the repository.
- Never ask for or show the Gmail app password: the beheerder enters it in
  the app.
- **Version:** the header shows `versie` from package.json, right of the
  title - bump it when releasing. Three numbers only (npm and release.yml
  refuse a fourth): a new feature or changed behaviour raises the middle
  one (0.3.8 -> 0.4.0), a small fix or wording change the last one
  (0.4.0 -> 0.4.1). Bump once per build, not per commit: several small
  changes before one "Bouwen (test)" share one new number. Once a version
  bump is committed and pushed, run "Bouwen (test)" and then "Vrijgeven
  (productie)" for that version without asking first, and report the
  outcome. Run the checks under Testing before the bump.

## Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend + Backend | Next.js App Router | 16.4.2 |
| Language | TypeScript | 5.5+ |
| Styling | Tailwind CSS + shadcn/ui | 3.4+ (build only, devDependencies) |
| Database | SQLite (WAL mode) | Latest via better-sqlite3 |
| ORM | Drizzle | 0.45+ |
| Auth | Custom (tokens + passwords) | bcrypt |
| Solver | Python + FastAPI + OR-Tools (./solver; the AIOS's own ./aios-solver) | 3.11, 0.141, 9.8 |
| Testing | Vitest + fast-check + Playwright | 4.1+, 3.14+, 1.62+ |
| Container | Docker Compose | - |

## Code Conventions

### TypeScript & Structure

- **Strict mode:** All TypeScript files use strict type checking
- **No default exports:** Use named exports, except where Next.js
  requires a default export (`page.tsx`, `layout.tsx` and the like under `app/`)
- **File organization:**
  ```
  app/          # Next.js routes and pages
  components/   # React components
  lib/          # Utilities, helpers, calculations
  db/           # Drizzle schema, migrations
  types/        # TypeScript types and interfaces
  scripts/      # Setup, seeding, maintenance
  tests/        # Test files, fixtures
  ```

- **Naming:**
  - Components: PascalCase (`PersonCard.tsx`)
  - Utilities: camelCase (`getWeekNumber.ts`)
  - Types: PascalCase (`Person.ts`)
  - Database: snake_case in schema, PascalCase in TypeScript interfaces

### Database Layer

**Critical Conventions:**

1. **No real names, emails, or phone numbers** - only `codenaam` (code name)
2. **Dates as ISO-8601 strings** - all dates stored/retrieved as `YYYY-MM-DD`
3. **Sign convention:** 
   - Delta values: negative = fewer shifts, positive = more shifts
   - Always consistent with UI language (see Frontend Rules)
4. **Constraints at schema level:**
   - `person.codenaam` UNIQUE
   - `availability(person_id, slot_id)` UNIQUE
   - `assignment(schedule_version_id, slot_id)` UNIQUE
   - `holiday_history(person_id, feestdag_groep, jaar)` UNIQUE
5. **Optimistic locking:** Use `row_version` on mutable aggregate tables
   - `submission`, `schedule_period`
6. **Ledger destinations:** `ledger_entry.geldt_voor_periode_id` determines which period's balance an entry affects
   - Carry-overs are recorded, not mutations
   - Corrections target the next un-generated period
   - Never double-count by both storing a value AND appending to ledger

### Frontend Rules

**Language: all user-facing text is Dutch.** Every screen a participant or
planner sees - labels, buttons, error messages, notification templates,
exported files and mail content - is in Dutch. English stays in code
identifiers, DB fields, comments, and console/log output only.

**Dutch writing style in user-facing text:**
- No dash (" - ") to join two sentences or clauses. Write separate
  sentences, or rephrase ("..., omdat ...", "Dat is handig als ...").
- No comma before "en" in a list or between clauses (", en" is English
  style). Same for "of".

**Balance & Saldo Messaging:**
- ❌ Never show raw numbers: `-1`, `+2`, `band: [7,8]`
- ✅ Always in words:
  - "1 avonddienst minder" / "1 avonddienst extra"
  - "Je krijgt 8 of 9 avonddiensten"
  - "2 diensten in te halen van vorige periode"

**Terminology:**
- Internal code terms: `windowWeeks`, `teller`, `band`, `slot`, `basis`
- User-facing (Dutch): "venster (weken)", "avond-/weekend-/feestdagdiensten", "bereik", "dienst", "streefaantal"
- Never say "band" to users - use "bereik" ("range")
- `FEESTDAG` = "feestdagdienst"
- `AVOND` = "avonddienst"
- `WEEKEND` = "weekenddienst"
- `LIEVER_NIET` = "liever niet"
- `ABSOLUUT` = "geblokkeerd"
- `VOORKEUR` = "voorkeur"

**Calendar/UI Constraints:**
- Grid must remain readable on 375px width (mobile-first)
- Always show ISO week numbers
- Saturday and Sunday as separate cells (no "whole weekend" quick action:
  the tiny button it once had was removed at the planner's request)
- 5 states per day must be visually distinct without color alone:
  - Neutral (no marking)
  - Voorkeur (soft, positive)
  - Liever niet (soft, negative)
  - Geblokkeerd (hard)
  - Part-time (auto-generated)
- Print-friendly: must work in B&W

**No Mock Data in Production:**
- All seed data via `/scripts/seed.ts`
- Never hardcode example data in components or routes
- Fixtures go in `/tests/fixtures/`

### Naming Conventions

| Concept | Code | UI | Comments |
|---------|------|----|----|
| Person identifier | `person.codenaam` | staf01, aios01 (demo: Persoon-01) | Only pseudonym, no real names |
| Service counter | `AVOND`, `WEEKEND`, `FEESTDAG` | "avonddienst", "weekenddienst", "feestdagdienst" | Enums in code, words in UI |
| Time window | `windowWeeks` | "venster (weken)" | Setting in UI, config in code |
| Balance amount | Stored as delta, delta < 0 = fewer | "1 avonddienst minder" | Never show raw sign to user |
| Balance range | `band[min, max]` | "Je krijgt 8 of 9 avonddiensten" | Band is internal; show the range (bereik) |
| Preference level | `ABSOLUUT`, `LIEVER_NIET`, `VOORKEUR` | "geblokkeerd", "liever niet", "voorkeur" | Enums in code |

### Server-Side Functions and Errors

Database mutations, auth checks, solver calls and other sensitive logic run
server-side, in the route handlers under `app/api` and the `lib/` code they
call (the app has no server actions). Never leak implementation details:
no raw DB errors, no internal error codes, client-safe Dutch messages.
Validate at system boundaries only (user input, external APIs); trust
internal code and framework guarantees, no defensive code for what can't
happen.

Every route keeps these, and a sweep test fails when one doesn't:
- **Access:** `requirePlannerAccess` / `requireAdminAccess` /
  `personAccessDenial` first; then, for a period or pool id,
  `periodDienstDenial` / `poolDienstDenial` (lib/dienstAccess.ts), and a
  participant route that takes a period asks `periodUsableFor`
  (lib/periodAccess.ts). A participant route takes only its own dienst's
  people: `personAccessDenial(...) ?? aiosPersonDenial(...)` under
  app/api/person, `?? geenAiosDenial(...)` under app/api/aios/deelnemer.
  Lists filter on `visibleDienst` (app/api/routeAccess.test.ts,
  app/api/dienstSeparation.test.ts).
- **Dienst boundary:** AIOS code imports only the shared parts, the
  achterwacht's code the AIOS's only where listed (app/dienstImports.test.ts).
  The AIOS needs something of the achterwacht's: copy it.
- **Prullenbak:** an achterwacht route that changes a period asks
  `trashedPeriodDenial` (lib/periodTrash.ts) after the access checks
  (app/api/periodTrashGuard.test.ts).
- **Audit log:** every planner route that changes data writes
  `writeAuditLog` or says why not (app/api/auditCoverage.test.ts).
- **Input:** bodies through `parseJsonBody` and lib/requestFields.ts, query
  numbers checked, never a 500 for odd input (app/api/routeInput.test.ts,
  app/api/queryInput.test.ts).
- **Sub-folder:** every client fetch and plain link through `withBasePath`
  (app/basePathSweep.test.ts).
- **Dutch style** in user-facing text (app/dutchStyle.test.ts).
- **Contrast:** white text on a button reaches 4.5 to 1 (app/buttonContrast.test.ts).

### Testing

- **One rule = one test that proves it can't be broken:** a test that fails
  when the rule is violated, not just example data. Add a mutation to
  scripts/mutation-check.mjs for every new guard (`runner: 'pytest'` for a
  solver guard).
- Colocate `utils.ts` + `utils.test.ts`; Vitest (`npm test`); fast-check for
  invariants; no DB mocks, real SQLite with fixtures. Cover the happy path,
  boundaries (period start, year boundary, ISO week 53) and error cases.
- **Assert on Dutch.** A selector looking for an English label matches
  nothing, and a `getByText(/error/i)` that never matches looks exactly like
  a passing test.
- **Fixtures must obey the rules they are not testing** (e.g. no two shifts
  of one person in one window), or every check in the test drowns in
  warnings that have nothing to do with it.

The gate before a release, all green:
1. `npx tsc --noEmit -p .`, `npx eslint .`, `npx vitest run`,
   `npm audit --omit=dev` (must stay 0).
2. Solvers: `python -m pytest -q` in ./solver and in ./aios-solver, on
   OR-Tools 9.8 (solver/requirements.txt; another version searches
   differently).
3. At a 0.x.0 release `node scripts/mutation-check.mjs --sinds v<the
   previous 0.x.0>` (SOLVER_PYTHON for the solver mutations): the
   mutations whose file or tests changed since then, every one caught. A
   0.0.x release runs none (the user's choice). It edits sources while it
   runs: nothing else meanwhile.
4. After a schema change: `node scripts/schema-drift.mjs` and
   `node scripts/upgrade-drift.mjs`.
5. Browser checks, with a seeded database, both solvers (the AIOS's on
   AIOS_SOLVER_URL) and the app running (ALLOW_SEED_PASSWORD=true): `node scripts/full-check.mjs` then
   `node scripts/ui-check.mjs` on the same seed, `npx playwright test`,
   `node scripts/scenario-check.mjs` - at the root and in a sub-folder build
   (`NEXT_PUBLIC_BASE_PATH=/achterwacht` at build and start,
   `APP_URL=http://localhost:3000/achterwacht`). The scenario-check runs
   `--kort` in the sub-folder, and at the root too unless the solver or
   the achterwacht's lib/ or app/api/ changed since the previous release
   (the git diff in docs/development/checks.md): the full run takes 35
   minutes.

How to run them and what each one covers: docs/development/checks.md.

## Where things are

| Area | Read | Key code |
|---|---|---|
| Tables, holidays, the seed | docs/development/data-model.md | db/schema.ts, lib/holidays.ts, scripts/seed.ts |
| Periods, prullenbak, publishing, undo | docs/development/periods.md | lib/periodOverlap.ts, lib/periodTrash.ts, lib/publication.ts, lib/publicationCheck.ts |
| Fellows, Geldig vanaf/tot, bands, carry-over, window, the solver's phases, absences and part-time, preferences import, capacity | docs/development/roster-rules.md | lib/rosterBands.ts, lib/carryOver.ts, lib/windowRule.ts, lib/fellows.ts, lib/absenceSync.ts, lib/parttimeSync.ts, solver/ |
| Achterwacht and AIOS apart, the AIOS's copies | docs/development/diensten.md | lib/dienstAccess.ts, lib/activePeriod.ts, lib/aios*.ts, app/api/aios |
| The AIOS roster (design, steps) | docs/aios-rooster.md | lib/aiosQuarter.ts, lib/aiosDiensten.ts, lib/aiosSlots.ts, lib/aiosPool.ts, lib/aiosPeriod.ts |
| The AIOS's solver (contract, model, tests) | docs/development/aios-solver.md | aios-solver/ |
| Links, passwords, beheerder, sessions | docs/development/auth.md | lib/auth-context.ts, lib/session.ts, lib/staffAccounts.ts |
| Verzendlijst, reminders, swap mails, "Link kwijt?" | docs/development/mail.md | lib/verzendlijst.ts, lib/verzendlijstMail.ts, lib/meldingMail.ts, lib/autoReminders.ts |
| Images, workflows, compose, sub-folder, backups (also by mail, and the restore), uploads, downloads, limits | docs/development/deployment.md | Dockerfile, docker-compose.yml, .github/workflows, lib/basePath.ts, lib/xlsxWrite.ts, lib/dbBackup*.ts |
| Operator guides (Dutch) | README.md, docs/installatie-it.md (for the IT department), docs/verzendlijst-power-automate.md, docs/back-up-power-automate.md, docs/teststrategie.md (what to test when), docs/stappenplan-testen.md (the checklist for the user) | - |

Traps that cost a day each time:
- **The seed builds the schema with its own SQL.** A new column needs the
  schema (db/schema.ts), a migration (db/migrations) and the seed (its
  CREATE TABLE and `LATER_COLUMNS`); then schema-drift and upgrade-drift.
- **Production starts with `seed.ts --alleen-planner`** at every start
  (SEED_ON_START=planner), not with the migrations.
- **Periods:** one period per day per pool; the ruleset is frozen when a
  period opens; while a generation runs, changes to the roster answer 409.
- **Mail:** the app never stores e-mail addresses and never mails
  participants itself; everything goes as a verzendlijst to the
  operator's flow.
- **The AIOS's hard rules live in three places:** aios-solver/model.py
  (the solver), aios-solver/controle.py (its independent check) and
  lib/aiosRegels.ts (the app's copy, the user's choice). A rule changed in
  one is changed in all three, then tests/fixtures/aios-regels.json
  written again (`python regelgevallen.py` in ./aios-solver):
  test_gedeeld.py and lib/aiosRegels.test.ts both check it
  (docs/development/aios-solver.md).

## Common Patterns & Pitfalls

- One sign convention everywhere (delta < 0 = fewer shifts), commented in
  the schema.
- Never show a raw balance ("-1"): always words ("1 avonddienst minder").
- A balance is the sum of ledger entries only, never also a stored value.
- No database mocks: real constraints are part of what a test checks.

## How to Add a Feature

1. **Identify the hard rule** (if any) - write test first
2. **Add DB schema** if needed - schema change, migration, seed
3. **Add server function** - query/mutation logic (typed)
4. **Add form/UI** - client component, validation via Zod
5. **Add end-to-end test** - full flow via Playwright (`tests/e2e`)
6. **Write down what you learned** in the docs/development file for the area

## When to Ask

- Anything not covered by this CLAUDE.md or docs/development/
- Design questions about terminology or UI flow
- Decisions between multiple valid approaches
- Anything involving the solver contract

## Resources

- Design inspiration: shadcn/ui + Tailwind defaults
- Database source of truth: `/db/schema.ts`
- Tests run via: `npm test`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

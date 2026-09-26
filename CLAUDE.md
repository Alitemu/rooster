# Dienstrooster - Claude Code Guide

## Project Overview

Dienstrooster is a scheduling application for medical wards (20-40 staff members) with:
- Fair shift distribution using solver (CP-SAT)
- Preference blocking (absolute + soft)
- Holiday rotation tracking
- Part-time support
- Automatic roster generation with diagnostics

**Phase 0:** Foundation - auth, datamodel, period management, holiday calculations, capacity checks.

## Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend + Backend | Next.js App Router | 16.3 |
| Language | TypeScript | 5.5+ |
| Styling | Tailwind CSS + shadcn/ui | 3.3+ |
| Database | SQLite (WAL mode) | Latest via better-sqlite3 |
| ORM | Drizzle | 0.29+ |
| Auth | Custom (tokens + TOTP) | bcrypt, speakeasy |
| Solver | Python + FastAPI | 3.11+, 0.104+ |
| Testing | Vitest + fast-check | 1.0+, 3.14+ |
| Container | Docker Compose | 3.8+ |

## Code Conventions

### TypeScript & Structure

- **Strict mode:** All TypeScript files use strict type checking
- **No default exports:** Use named exports exclusively
- **File organization:**
  ```
  app/          # Next.js routes and pages
  components/   # React components
  lib/          # Utilities, helpers, calculations
  server/       # Server-side functions, DB queries
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
exported CSV/mailto content - is in Dutch. English stays in code
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
- Saturday and Sunday as separate cells with a "heel weekend blokkeren" quick action
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

### Testing

**One Rule = One Test That Proves It Can't Be Broken:**
- Example: "Window rule - person with shift in week 12 has no shift in weeks 11, 13"
  - Test that proves it fails if violated
  - Not just example data

**Test Organization:**
- Colocate: `utils.ts` + `utils.test.ts` in same folder
- Use Vitest: `npm run test`, `npm run test:ui`
- Property-based tests: `fast-check` for invariants
- No DB mocks - use seed fixtures with real SQLite

**Browser-level checks** need a seeded database, the solver and the app
already running (`npm run seed`, `uvicorn main:app --port 8000` from
`./solver`, then `ALLOW_SEED_PASSWORD=true SOLVER_URL=http://localhost:8000
npm start`) - none of them starts anything itself. ALLOW_SEED_PASSWORD
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

`node scripts/schema-drift.mjs` needs nothing running. It builds one
database from the seed and one from the migrations and compares them
column by column, index by index, foreign key by foreign key. Run it after
any schema change: SEED_ON_START defaults to planner, so on a real deployment
it is scripts/seed.ts - not db/migrations - that builds the schema, and
the two drifting apart means production quietly runs a different one than
every test does.

Two things these get wrong easily, and both cost a day to diagnose:
- **Assert on Dutch.** Every user-facing string is Dutch; a selector looking
  for an English label matches nothing, and a `getByText(/error/i)` that
  never matches looks exactly like a passing test.
- **Fixtures must obey the rules they are not testing.** A fixture that
  hands one person two shifts in the same ISO week has a window-rule
  violation in it, so the publication check flags a warning and every swap
  between those people carries a "two shifts close together" warning -
  noise that has nothing to do with what the test meant to check.

**Test Files Must Cover:**
1. Happy path (normal operation)
2. Boundary conditions (start of period, year boundary, etc.)
3. Error cases (invalid input, constraint violation)

### Naming Conventions (CRITICAL)

These avoid subtle bugs when UI and code use different sign conventions:

| Concept | Code | UI | Comments |
|---------|------|----|----|
| Person identifier | `person.codenaam` | Shown as "Persoon-01" | Only pseudonym, no real names |
| Service counter | `AVOND`, `WEEKEND`, `FEESTDAG` | "evening", "weekend", "holiday" shifts | Enums in code, words in UI |
| Time window | `windowWeeks` | "Number of weeks between shifts" | Setting in UI, config in code |
| Balance amount | Stored as delta, delta < 0 = fewer | "1 fewer shift" | Never show raw sign to user |
| Balance range | `band[min, max]` | "8 or 9 evening shifts" | Band is internal; show the range |
| Preference level | `ABSOLUUT`, `LIEVER_NIET`, `VOORKEUR` | "Blocked", "Prefer not", "Preferred" | Enums in code |

### Server-Side Functions

Use `'use server'` for:
- Database mutations
- Auth checks
- External API calls (solver)
- Sensitive business logic

Never leak implementation details to client:
- No raw error messages from DB
- No internal error codes
- Return client-safe error messages

### Error Handling

- Validation at system boundaries only (user input, external APIs)
- Trust internal code and framework guarantees
- No defensive code for scenarios that can't happen

Example: If the ORM guarantees a constraint, don't also check in code.

## Datamodel Overview (Phase 0)

**Core Tables (Implemented Phase 0):**
- `person` - staff members (codenaam, role, password_hash, totp_secret, sessie_versie)
- `person_access_link` - personal links for participants
- `pool` - shift pool (name, type, settings reference)
- `pool_membership` - who's in which pool when
- `ruleset` - configuration and rules (frozen when period opens)
- `schedule_period` - time periods (CONCEPT, OPEN, GESLOTEN, GEGENEREERD, GEPUBLICEERD)
- `shift_type` - shift definitions (evening, weekend, holiday)
- `shift_slot` - individual slots to fill (date, iso_year, iso_week, counter_type)
- `holiday_history` - holiday group assignments across years
- `ledger_entry` - balance adjustments (CARRY_OVER, CORRECTION, BEGINSALDO)
- `audit_log` - all actions by admins/planners
- `notification_template` - message templates
- `reminder_schedule` - reminder timing rules

**Phase 1+:**
- `availability` - blocking preferences (person + slot + level)
- `assignment` - final shift assignments
- `submission` - period status per person
- `swap_request` - shift exchanges

## Holiday Calculation

6 holiday groups (never show raw names to users):

| Group | English | Dates | Rule |
|-------|---------|-------|------|
| `NIEUWJAAR` | New Year | Jan 1 | Fixed |
| `PASEN` | Easter | Easter Sun, Easter Mon | Meeus algorithm |
| `KONINGSDAG` | King's Day | Apr 27 (or 26 if Sun) | Conditional |
| `BEVRIJDINGSDAG` | Liberation | May 5 every 5 years | Every 5 years |
| `HEMELVAART` | Ascension | Easter + 39 days | Variable |
| `PINKSTEREN` | Pentecost | Easter + 49-50 | Variable |
| `KERST` | Christmas | Dec 25-26 | Fixed |

**Implementation:**
- `/lib/holidays.ts` - TypeScript calculation utilities
- `/solver/holidays.py` - Python solver utilities
- Tests for 2024-2035 including leap years

## Period Management

- **Auto-round** to Monday start, Sunday end on ISO-week boundaries
- **Auto-exclude** days already assigned in published previous periods
- **Freeze ruleset** when period opens (no retroactive rule changes)
- **Row versioning** for optimistic concurrency on mutable periods

**Undo on the period page:** a manual assign/reassign/remove leaves one
"ongedaan maken" (lib/pendingUndo.ts) that records its `onderdeel` - the
heading it was made under (ROOSTER, VOORAF = "Rooster vooraf invullen",
HERVERDELING = "Voorstellen voor herverdeling"; the client sends it, the
route falls back to ROOSTER). PlannerDashboard shows the button inside that
section, so it folds away with it; a hidden herverdeling section hands it
to the roster.

**Version:** the header shows `versie` from package.json, right of the
title - bump it when releasing.

**Publishing (GEGENEREERD → GEPUBLICEERD) and its way back:**

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
- `POST .../unpublish` reverts GEPUBLICEERD back to GEGENEREERD: clears
  `gepubliceerd_op`/`gepubliceerd_door_person_id`, keeps every assignment
  (withdrawing is not discarding the roster), keeps notifications already
  sent (a historical record) and sends a new one telling participants the
  publication was withdrawn.

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
  people / (people - fellows), floor/ceil; otherwise the default over the
  non-fellows). A fellow's own WEEKEND band is `[0, released days]`,
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

Show live in settings screen with interpretation in plain Dutch/English.

## Authentication

**Two mechanisms:**

1. **Personal Links** (participants)
   - Long random token → SHA256 hash in DB
   - Grants access to own period/preferences only
   - Read-only after deadline
   - Valid for its own period; a new export issues an extra link rather
     than retiring earlier ones, so someone can still use the link in the
     original invitation mail. `ingetrokken_op` is honoured on every
     request (lib/auth-context.ts), but no flow sets it - revoking is a
     deliberate manual act, not a side effect of exporting.

2. **Password + TOTP** (planner/admin)
   - bcrypt (the native binding) for password hashing
   - Speakeasy for TOTP generation
   - No email required (pseudonymous)
   - The password is changed through POST /api/auth/change-password
     ("Wachtwoord wijzigen" on the period list), which requires the
     current one. /api/auth/first-run-setup only ever claims an account
     that has none yet, so it is not a reset path.
   - `scripts/seed.ts` sets a known password from `lib/seedPassword.ts` -
     deliberate, so a seeded database is immediately usable while this is
     being built. The app logs a warning on every start while an account
     still has it. The repository is public, so a login with it gets a
     session flagged `wachtwoordWijzigen` (lib/session.ts): requirePlannerAccess
     refuses it, only change-password (requireStaffSession), logout and
     /api/auth/me accept it, and the login page asks for a new password
     first; the seed password itself is refused as the new one.
     ALLOW_SEED_PASSWORD=true lifts this for local test runs only;
     docker-compose.yml does not pass it through.
   - The TOTP secret is stored encrypted like the mail password
     (lib/totpSecret.ts, "v1:"; a plain-text one from before is re-saved
     encrypted at the next login). Unreadable after a key change: the
     login says so, and `scripts/reset-totp.ts <codenaam>` on the server
     turns two-step verification off for that account.
   - The login page's `redirect` only goes to a /planner path on this site
     (lib/safeRedirect.ts, checked with the URL parser: "/\\host" leaves
     the site in a browser).
   - TOTP is self-service, mirroring the password: "Tweestapsverificatie"
     on the period list opens `TotpSettingsDialog`, which calls
     `/api/auth/totp/setup` (a fresh secret + a server-rendered QR PNG,
     `qrcode` renders the `otpauth://` URI - nothing is persisted yet) and
     `/api/auth/totp/confirm` (a live code from that secret is what
     actually writes `totp_secret`). `/api/auth/totp/disable` is the way
     back - current password only, deliberately never a fresh TOTP code,
     since "I no longer have a code to give" is the ordinary reason to
     call it, not an edge case. All three routes, plus `/api/auth/me`'s
     `totp_enrolled` flag the dialog reads its own state from, existed
     server-side since Phase 0 but had no screen calling any of them until
     this was wired up - `qrcode` sat in package.json unused the whole
     time.

**Session revocation**

Session cookies are self-contained signed tokens, so nothing server-side
knows they exist. `person.sessie_versie` is the one thing that does: it is
baked into every token and compared on each request (lib/sessionVersion.ts).
Raising it invalidates every token issued for that person in one UPDATE.

- Logging out revokes every session for that person, not just this
  browser's cookie. `{ "alleenDezeBrowser": true }` on POST /api/auth/logout
  keeps the others.
- Changing the password revokes them too, and re-issues a cookie for the
  browser that made the change.
- A token from before the column existed carries no version and is
  refused, so everyone logs in once more after that upgrade.

## Mailing personal links (verzendlijst)

The app never stores e-mail addresses, so it never mails participants
itself. It hands a "verzendlijst" (lib/verzendlijst.ts: fixed subject
`DIENSTROOSTER-VERZENDLIJST` + a JSON attachment: summary fields plus
`berichten`, each `{soort, codenaam, personen, onderwerp, tekst}`; `personen` = every codenaam
the text names, longest first, so a flow can swap in real names from its
sheet without "Persoon-1" matching inside "Persoon-10") to a Power Automate flow on the planner's
side, which looks each codenaam up in its own Excel list and sends the
mail. The server sends that mail itself (lib/verzendlijstMail.ts) once an
account is set up, in the app only ("Mailinstellingen" under Exporteren &
communicatie, `/api/planner/mail-settings`, lib/appSettings.ts - Gmail
only, a 16-letter app password, the login is tried before saving, the
password is stored AES-GCM encrypted with a key derived from the session
secret, lib/settingsCrypto.ts, and never returned). .env is not read for
it any more (SMTP_USER/SMTP_PASS/VERZENDLIJST_AAN were removed on
purpose); SMTP_HOST/SMTP_PORT exist only so tests can point it at
tests/smtpSink.ts. The one mail variable left is MAIL_UITGESCHAKELD=true, a
kill switch for a test installation on a copy of production's data: nothing
is sent (readConfig returns null) and MailWarning says so. Without it the export dialog says sending isn't
set up, and MailWarning at the top of the period page says no mail goes
out at all. That warning also shows the last failed send (stored as
`mail.laatste_fout` in app_setting by sendVerzendlijst, cleared by the
next successful send or new settings; "not set up" is never recorded as
a failure) - automatic reminders and swap mails fail where nobody
watches. There is deliberately no other way out: the old manual JSON
download and the per-person mailto links are gone, and a single reminder
goes through the flow too. The invitations CSV download stays. The recipient is always the flow mailbox from Mailinstellingen, never
anything from a request. Links in mails a participant sets off (swap
mails, lib/meldingMail.ts) use lib/baseUrl.ts `mailBaseUrl`: BASE_URL or
the period's `basis_url` from the planner's export, never the Host header
of the participant's request (anyone can forge it, and the colleague's
fresh personal link would go to that host); with neither known the mail
has no link. resolveBaseUrl (Host header) is for planner exports only. Swap requests use the same channel (lib/meldingMail.ts):
a new request mails the colleague (SWAP_REQUESTED) and confirms to the
requester, and approve/reject mails the requester (SWAP_RESULT), each a
one-bericht verzendlijst with a fresh personal link and the swap spelled
out from the reader's side (lib/swapMailDetails.ts). Started after the
commit and never awaited, so a mail failure can't fail or slow the swap.
A swap mail that can't go out (not set up, or refused) waits in
dienstrooster_mail_queue with its MeldingMail as JSON - built, personal
link included, only when it is sent - and flushMailQueue sends it hourly
(instrumentation-node.ts), right after mail settings are saved and after
any other successful send (flushAfterSend, via a dynamic import from
lib/verzendlijstMail.ts), oldest first, stopping at the first refusal.
What no longer applies is pruned on every run, also while sending isn't
set up, so MailWarning's count stays honest. A withdrawal waits for its
own request mail if that is still being tried (requestsInFlight). Dropped after 7 days, a
RUILVERZOEK/RUIL_BEVESTIGING as soon as the swap is no longer PENDING,
and a withdrawal notice whose request mail never went out takes that
request mail with it instead of being sent. The create route returns
`mail_vertraagd` (not set up, a remembered failure, or a non-empty queue)
so the requester is told the colleague may only see it in the app for
now; MailWarning counts what waits. Every
bericht carries a `soort` (UITNODIGING, HERINNERING, LAATSTE_HERINNERING,
RUILVERZOEK, RUIL_BEVESTIGING, RUIL_UITKOMST, RUIL_INGETROKKEN) and an
`html` field: `tekst` escaped with <br> for line breaks (tekstNaarHtml).
The flow must use `html` as the mail body, never build HTML from `tekst`:
the text can hold words a participant typed (swap toelichting, rejection
reason, both capped at 1000 characters by lib/freeText.ts). Withdrawing a
swap tells the colleague. One shift may be offered to several colleagues
at once (the candidates list marks who was already asked, `al_gevraagd`;
the exact same request twice is refused): the first to approve wins. That
approval withdraws the other open requests of either side of that swap
(INGETROKKEN, only the colleague each was sent to is told; the requester
hears it in the approval mail, the approver on screen from the response's
`afgesloten`) and closes anyone else's request on either shift as
AFGEWEZEN ("vervallen", both sides told) (lib/swapLifecycle.ts). One
participant may start at most 20 swap requests per 24 hours, withdrawn
ones included (lib/swapQuota.ts, 429): each mails two people, and the
sending account's daily limit is shared with invitations and reminders. Invitations go out only for an OPEN period before
its deadline, like reminders (lib/reminderGate.ts); the CSV of links is
not gated. SMTP on any port but 465 requires STARTTLS (requireTLS).

Automatic reminders (lib/autoReminders.ts, run every hour from
instrumentation-node.ts): for an OPEN period with `auto_herinneren` on,
one moment per reminder_schedule milestone (7 and 1 days by default) at
the last 09:00 at least N*24h before the deadline, to everyone not
BEVESTIGD (own text for NIET_BEGONNEN/no row and for BEZIG), minus anyone
with a REMINDER/FINAL_WARNING in notification_log in the last 24h (manual
sends log there too). Each moment is claimed in dienstrooster_reminder_run
keyed on (period, milestone, deadline) before sending and released if the
send fails; a moment more than 12h late, or due together with a more
urgent one, is recorded as OVERGESLAGEN instead. Links use BASE_URL or the
period's `basis_url`, remembered from the planner's last export request.
There is no separate summary mail: every verzendlijst is an object
(lib/verzendlijst.ts `Verzendlijst`) whose fields around `berichten` -
soort, automatisch, periode, deadline, aantal, and for reminders
nog_niets_ingevuld/nog_niet_ingediend - let the flow report back to the
planner itself. runAutoReminders takes `onlyPeriodIds` for tests: the
test database is shared across test files. Setup for the operator, in
Dutch: docs/verzendlijst-power-automate.md.

The planner reminds by hand from "Status voorkeuren": a "Herinnering
sturen" per person (disabled once BEVESTIGD) and one below the table for
everyone not BEVESTIGD, both POST /api/planner/period/[id]/remind - the
automatic reminder's text (reminderBericht), fresh links, logged like any
reminder, only while OPEN before the deadline. (There used to be a
"submit on behalf" button there; it is gone on purpose.)

"Link kwijt?" on the start page (components/LinkAanvraagForm.tsx, public
POST /api/link-aanvragen, lib/linkAanvraag.ts): the app can't map an
address to a codenaam, so it mails the flow a LINK_AANVRAAG verzendlijst
with the typed address (`aanvraag_email`, trimmed, lower case) and a
bericht for every participant of every current period (not CONCEPT, not
ended, not in the trash, with a known mailBaseUrl - never the request's
Host header) in `kandidaten`, each with a fresh link per such period.
`berichten` stays empty on purpose: a flow that doesn't know this soort
must send nothing rather than mail everyone. The flow looks the address
up in its sheet and sends only that codenaam's bericht, to the sheet's
address. The answer is the same for any address; rate-limited per caller
(3) and in total (10) per 15 minutes, because every request mints a link
for every participant and costs a Gmail send. The address is never
stored or logged.

## Deployment

**Images:** node:22-alpine (Node 20 is end-of-life), dev dependencies
pruned after the build; `.npmrc` sets legacy-peer-deps because npm 10
crashes resolving vitest 4's optional peers, and `npm ci` must match the
lockfile. Built only by hand. "Bouwen (test)" (.github/workflows/images.yml)
builds `ghcr.io/alitemu/rooster-web` and `rooster-solver` (amd64 only)
tagged with package.json's `version` and `test`, only after the app's and
the solver's tests pass and only for a version not built before (bump
package.json for every build); "Vrijgeven (productie)"
(release.yml) points `stable` at an already built, tested version without
rebuilding. Compose pulls `${ROOSTER_VERSION:-stable}` (a test
installation sets `test`) and keeps `build` for building from source.
Updating is `docker compose pull && docker compose up -d`. The schema of an
existing database is brought up to date at every start either way:
docker-entrypoint.sh runs the seed (SEED_ON_START=planner, the default, or
true) or else
`scripts/seed.ts --schema-only` (tables, LATER_COLUMNS, reworded
templates, no data; skipped for a migration-built database).

**Sub-folder (basePath):** NEXT_PUBLIC_BASE_PATH at build time (Dockerfile
arg BASE_PATH, "Bouwen (test)" input `basispad`, empty by default -
the app got its own subdomain instead;
empty = root, as before) sets next.config basePath. Next.js prefixes
<Link> and router.push itself; everything else goes through
lib/basePath.ts `withBasePath` - every client fetch('/api/...'), plain
<a href>, window.location - and `withoutBasePath` for a browser pathname.
The session cookie's path is the sub-folder, resolveBaseUrl appends it
(BASE_URL must include it), the Docker healthcheck uses it, and Caddy
redirects anything outside it to it (BASE_PATH in .env). A new client
fetch without withBasePath works at the root and breaks only in a
sub-folder, so run the browser checks against a sub-folder build too:
`NEXT_PUBLIC_BASE_PATH=/achterwacht npm run build`, start it the same
way, and run them with `APP_URL=http://localhost:3000/achterwacht`
(scripts and tests/e2e read APP_URL).

**Backups and a clean start:** lib/dbBackup.ts writes one `VACUUM INTO`
copy a day to `<db dir>/backups/database/rooster-YYYY-MM-DD.db` (local
date), from the hourly scheduler, keeping the newest 14 - a plain file copy
of a WAL database misses what is still in -wal. The key for everything stored
encrypted (`<db dir>/.session_secret`, or SESSION_SECRET) is deliberately
not in it; the README tells the operator to keep it apart. SEED_ON_START=planner runs
`scripts/seed.ts --alleen-planner`: planner account, ruleset, pool, shift
types and notification templates, no demo people or period (the
production start and compose's default; true adds the demo data); a rerun
on a seeded database only upgrades the schema.

**Container hardening:** the web image is built in two stages (no
compiler, Python or dev dependencies in the one that runs, no .next/cache),
code owned by root with only /data and .next/cache writable for `node`,
NEXT_TELEMETRY_DISABLED. The solver image installs wheels only
(--only-binary), no build-essential, own .dockerignore, code root-owned.
Compose: caddy:2-alpine (Caddy 2.8+ dropped on_demand_tls interval/burst),
capped json-file logs, no-new-privileges everywhere, init + mem_limit on
web, cap_drop ALL + mem_limit on the solver. Workflow actions are pinned
to commit SHAs.

**Limits:** request bodies are capped at 1 MB in Caddy and in
lib/api-errors.ts parseJsonBody (read no further; also before login).
Free text a participant types - swap toelichting, rejection reason,
absence notitie - goes through lib/freeText.ts (1000 characters).

**Docker Compose (3 services):**
- `caddy` - TLS termination (internal certs via `tls internal`)
- `web` - Next.js + SQLite
- `solver` - Python FastAPI (healthcheck only, no public ports)

**Volumes:**
- `web`'s `/data` - SQLite database file and the preferences CSV backups
  (`lib/preferencesBackup.ts`). Bind-mounted to `./data` next to
  `docker-compose.yml` by default (override with `DATA_DIR` in `.env`) -
  deliberately a plain host folder rather than a Docker-managed named
  volume, so a NAS's own file manager (e.g. Synology File Station) can
  browse it directly instead of needing Docker's hidden volume storage.
  Ships as an empty, git-tracked folder (`data/.gitkeep`) precisely so a
  fresh clone always has it: a bind mount's host directory has to already
  exist, unlike a named volume, which Docker creates on demand. A custom
  `DATA_DIR` doesn't get this for free - create it once, manually, before
  the first `docker compose up`.
- `caddy_data` - TLS certificate cache (still a regular named volume - not
  something an operator needs to browse directly)

**Networking:**
- All services on internal bridge network
- Only `caddy` exposes the app port (default 8010) to host

## Seed Script

`npm run seed` loads 31 pseudonymous participants:

- Codenamen: Persoon-01 through Persoon-31
- Pool: 2-week window (default)
- Period: 2027-01-04 to 2027-06-06 (22 weeks)
- Various part-time patterns
- Mixed balances (some -1, +1, 0)
- Holiday history for 2025-2028
- Creates the audit_log table, but does not insert any rows into it - a
  fresh seed has an empty audit trail until real actions happen
- Access links get a real random token; only its hash is stored, exactly
  as in production, so the plaintext is gone the moment the seed ends.
  Mint a fresh link through the planner's export screen to open someone's
  page.

All data uses codenamen only, no real personal data.

**The seed builds the schema with its own raw SQL**, and db/client.ts then
skips migrations for a database that came out of it (migration 0000 would
collide with the tables already there). A column added to `db/schema.ts`
therefore needs three things, not one: the schema, a migration under
`db/migrations`, and an entry in the seed - either in its CREATE TABLE for
a fresh database, or in `LATER_COLUMNS` so a database seeded weeks ago
picks it up too.

## Common Patterns & Pitfalls

**❌ Pitfall: Mixing sign conventions**
- DB has delta < 0 = fewer, code says delta < 0 = more → subtle bugs
- **Fix:** One convention everywhere, comment it in schema

**❌ Pitfall: Showing raw balance to user**
- "-1 shifts" is confusing
- **Fix:** Always convert to language: "1 fewer shift"

**❌ Pitfall: Storing balance as both value AND ledger sum**
- Carry-over logic becomes unclear
- **Fix:** Only ledger entries; balance is sum of entries for period

**❌ Pitfall: Mocking database in tests**
- Real constraints not tested
- **Fix:** Use real SQLite with seed fixtures

**✅ Pattern: One test per hard rule**
- "Window rule" has one test proving it can't be violated
- Not an example of correct behavior; proof of enforcement

## How to Add a Feature

1. **Identify the hard rule** (if any) - write test first
2. **Add DB schema** if needed - schema change, migration
3. **Add server function** - query/mutation logic (typed)
4. **Add form/UI** - client component, validation via Zod
5. **Add end-to-end test** - full flow via Playwright (phase 2+)

## When to Ask

- Anything not in this CLAUDE.md or plan v14
- Design questions about terminology or UI flow
- Decisions between multiple valid approaches
- Anything involving the solver contract

## Resources

- Implementation plan: v14 (markdown in repo root)
- Design inspiration: shadcn/ui + Tailwind defaults
- Database source of truth: `/db/schema.ts`
- Tests run via: `npm test`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

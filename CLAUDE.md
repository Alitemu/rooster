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
| Frontend + Backend | Next.js App Router | 15.0+ |
| Language | TypeScript | 5.5+ |
| Styling | Tailwind CSS + shadcn/ui | 3.3+ |
| Database | SQLite (WAL mode) | Latest via better-sqlite3 |
| ORM | Drizzle | 0.29+ |
| Auth | Custom (tokens + TOTP) | bcryptjs, speakeasy |
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

**Calendar/UI Constraints:**
- Grid must remain readable on 375px width (mobile-first)
- Always show ISO week numbers
- Saturday and Sunday as separate cells with a "heel weekend blokkeren" quick action
- 4 states per day must be visually distinct without color alone:
  - Neutral (no marking)
  - Liever niet (soft)
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
| Preference level | `ABSOLUUT`, `LIEVER_NIET` | "Blocked", "Prefer not" | Enums in code |

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
- `person` - staff members (codenaam, role, password_hash, totp_secret)
- `person_access_link` - personal links for participants
- `pool` - shift pool (name, type, settings reference)
- `pool_membership` - who's in which pool when
- `ruleset` - configuration and rules (frozen when period opens)
- `schedule_period` - time periods (CONCEPT, OPEN, CLOSED, GENERATED, PUBLISHED)
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
   - Can be revoked per person, anytime

2. **Password + TOTP** (planner/admin)
   - bcryptjs for password hashing
   - Speakeasy for TOTP generation
   - QR code shown at setup
   - No email required (pseudonymous)

## Deployment

**Docker Compose (3 services):**
- `caddy` - TLS termination (internal certs via `tls internal`)
- `web` - Next.js + SQLite
- `solver` - Python FastAPI (healthcheck only, no public ports)

**Volumes:**
- `db_data` - SQLite database file
- `caddy_data` - TLS certificate cache

**Networking:**
- All services on internal bridge network
- Only `caddy` exposes the app port (default 8010) to host

## Seed Script

`npm run seed` loads 30 pseudonymous participants:

- Codenamen: Persoon-01 through Persoon-30
- Pool: 2-week window (default)
- Period: 2027-01-04 to 2027-09-05 (35 weeks, 245 shifts)
- Various part-time patterns
- Mixed balances (some -1, +1, 0)
- Holiday history for 2025-2026
- Full audit log

All data uses codenamen only, no real personal data.

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

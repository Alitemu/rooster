# Data model, holidays and the seed

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Datamodel Overview

**Core Tables:**
- `person` - staff members (codenaam, role, password_hash, totp_secret, sessie_versie)
- `person_access_link` - personal links for participants
- `pool` - shift pool (name, type, settings reference)
- `pool_membership` - who's in which pool when
- `ruleset` - configuration and rules (frozen when period opens)
- `schedule_period` - time periods (CONCEPT, OPEN, GESLOTEN, GEGENEREERD, GEPUBLICEERD)
- `shift_type` - shift definitions (evening, weekend, holiday)
- `shift_slot` - individual slots to fill (date, iso_year, iso_week, counter_type)
- `holiday_history` - which feestdag someone had in which year, from the
  setup wizard's old import step; read by nothing. The wizard step is gone:
  what counts is the number over the years, which the app keeps itself
  from its own rosters (lib/feestdagHistory.ts). The route
  import-holidays and the table stay for old data.
- `ledger_entry` - balance adjustments (categorie CARRY_OVER, CORRECTIE, BEGINSALDO).
  BEGINSALDO (the wizard's "Beginsaldi importeren") is for a pool's first
  period in the app only; after a period published here the carry-over is
  booked by itself, and the wizard warns that an import counts on top.
- `audit_log` - all actions by admins/planners (lib/auditLog.ts
  `writeAuditLog`; never passwords, tokens or link hashes). Since audit 6
  also creating, opening and closing a period, its deadline, rules,
  slots and automatic reminders, the pool on/off, adding, changing,
  removing and restoring a member, minting a personal link and the holiday
  import (route only since the wizard step went); app/api/auditLog.test.ts proves each writes exactly one row.
  Since audit 9 also personal links minted for everyone at once (the
  invitations and reminders exports), two-step verification switched on,
  every "Rooster vooraf invullen" change, and a planner changing someone's
  preferences, hand-in or part-time check for them (writeOnBehalfAuditLog;
  the participant's own input is not logged). app/api/auditCoverage.test.ts
  sweeps every planner route that changes data.
- `notification_template` - message templates
- `reminder_schedule` - reminder timing rules

- `availability` - blocking preferences (person + slot + level)
- `assignment` - final shift assignments
- `submission` - period status per person
- `swap_request` - shift exchanges

## Holiday Calculation

7 holiday groups (never show raw names to users):

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
- `/lib/holidays.ts` - TypeScript calculation utilities, the only place
  holidays are worked out. The solver computes none: it gets each slot's
  teller (FEESTDAG included) with the slots generate-roster sends.
- Tests for 2024-2035 including leap years

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

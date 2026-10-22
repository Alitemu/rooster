# Data model, holidays and the seed

Moved out of CLAUDE.md to keep the context of every session small; the rules
themselves stay there. Read this when working on what it covers. Code comments
that say "CLAUDE.md, ..." point to a section that now lives in docs/development/.

## Datamodel Overview

**Core Tables:**
- `person` - staff members (codenaam, role, password_hash, totp_secret, sessie_versie)
- `person_access_link` - personal links for participants
- `pool` - shift pool (name, type, settings reference)
- `pool_membership` - who's in which pool when (its `deelnamefactor` column is no longer read or written since 0.93.0: the factor follows from the part-time days, docs/development/roster-rules.md)
- `ruleset` - configuration and rules (frozen when period opens)
- `schedule_period` - time periods (CONCEPT, OPEN, GESLOTEN, GEGENEREERD, GEPUBLICEERD)
- `shift_type` - shift definitions (evening, weekend, holiday). An AIOS
  pool's have `code` (UD, DD, AD, ADW, ND), `soort` (UITLOOP, DAG, AVOND,
  NACHT), times and `punten`; their `teller` only fills the NOT NULL
  column and is never read (lib/aiosDiensten.ts). NULL for the achterwacht.
- `shift_slot` - individual slots to fill (date, iso_year, iso_week, counter_type).
  The achterwacht has one per day; the AIOS three (UD, AD, ND on a
  werkdag, DD, ADW, ND on a weekend day or feestdag), an evening or night
  pointing at its block through `shift_block_id` (no foreign key: the
  column is older than the table).
- `shift_block` - an AIOS evening or night block (soort AVOND or NACHT,
  vorm ZO_DI, WO_VR, ZA or LOS, start and end): one AIOS does all of it.
  Made with the period (lib/aiosSlots.ts), purged with it.
- `aios_wens` and `aios_periode` - an AIOS's requests for a quarter, and
  per AIOS period when the invitations went out, under which address and
  whether the AIOS's automatic reminders are on (`auto_herinneren`, 0.73.0,
  migration 0025; no row reads as on). Both cascade on delete with the
  period (docs/development/diensten.md). `aios_periode.oudjaar_aantal`
  (0.76.0, migration 0026): one or two AIOS on the night of 31 December,
  2 unless the planner says 1; no row reads as 2.
  `aios_periode.voortgangstoets` (0.82.0, migration 0029): the date of the
  quarter's voortgangstoets or null. The ND of the night before is deleted
  while it is set and made again (in its block, with the block's marks and
  the leave on it, lib/aiosSync.ts zetAfwezigheidOpDienst)
  when it moves or goes (lib/aiosVoortgangstoets.ts; reading it,
  lib/aiosToetsNacht.ts, imports the database only, as lib/aiosSlots.ts
  is loaded by the browser tests outside Next.js).
- `aios_blokkeuze` - per AIOS period and block with a feestdag in it the
  planner's choice: whole or `opknippen` (0.76.0, migration 0026,
  lib/aiosFeestdagBlokken.ts). Cascades with the period and the block. The
  block itself keeps its vorm; only the solver gets a cut one as LOS.
- The second night of New Year's Eve is an ND shift_slot without a block
  on 31 December, made when a generation starts with two AIOS chosen
  (its availability copied from the block's night), taken away with one
  chosen or when the period is reopened. An ND without shift_block_id is
  always that one. Taken away, its assignment_edit rows go with it.
- `aios_doel` (0.79.0, migration 0027) - per AIOS quarter and AIOS the
  solver's fair share (doel_punten, doel_feestdagen, and since 0.107.0,
  migration 0034, doel_nachten: NULL for a quarter made before, whose nights
  saldo is then none), written with the roster, removed with it; the next
  quarter's saldo is measured against it (lib/aiosSaldo.ts). Cascades with
  the period and the person.
- `aios_generatie` (0.90.0, migration 0030) - per AIOS period what the last
  generation told: when, the solver's status, how many diensten it filled
  and which stayed empty with the reasons (leeg_json). Written with the
  roster in the same transaction, removed with it (Rooster verwijderen);
  lib/aiosGenereren.ts laatsteAiosGeneratie gives it back with the
  diensten empty now, counted from the roster itself (0.94.0: one filled by
  hand is gone from the list, one made empty by hand is in it without a
  reason of the solver's, a dienst that no longer exists is not), so the
  planner sees it again after a refresh. What the solver filled and left is
  history. Cascades with the period.
- `period_factor` (0.95.0, migration 0032) - per period and person the
  deelnamefactor (the AIOS's fte) the roster was made with. Written when the
  roster is made (achterwacht: generate-roster before the solver, lib/
  deelnamefactor.ts; AIOS: in the generation's transaction, lib/aiosFteVast.ts),
  replaced by a new one, removed with the roster. Counts only while the
  period is gegenereerd or gepubliceerd. Cascades with the period and the person.
- `aios_reden` (0.91.0, migration 0031) - the optional toelichting an AIOS
  gives for a day they marked geblokkeerd or liever niet by hand (tekst, at
  most REDEN_MAX_LENGTH characters), per period, person and day. Private to
  the AIOS's planner (lib/aiosReden.ts says where it is read). It counts
  only while the day has such a mark: reading checks that, and a cleared
  mark deletes it. Cascades with the period and the person.
- `aios_beginstand` (0.79.0, migration 0027) - per AIOS pool and AIOS what
  they did before the app, read in from the old Excel
  (lib/aiosGeschiedenis.ts): the diensten per soort, the feestdagdiensten
  among them, fte and maanden. A file read in replaces the pool's rows.
- `aios_ruil` (0.80.0, migration 0028) - a swap between two AIOS
  (lib/aiosRuilen.ts): the diensten of each side as a JSON array of slot
  ids (a whole block, or one dienst), status IN_BEHANDELING, GOEDGEKEURD,
  AFGEWEZEN or INGETROKKEN (VERVALLEN is no longer written, 0.102.0: what lapses is
  INGETROKKEN; the value stays allowed in the check). Also gezien_op, laatste_herinnering_op
  and laatste_herinnering_door. Approved, the assignments change
  hands with assignment_edit rows of type RUIL.
- `assignment_edit` holds the AIOS's changes by hand too (0.77.0,
  lib/aiosHandmatig.ts), with the same edit types as the achterwacht's.
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

Every start (the demo seed, `--alleen-planner` and `--schema-only`) makes
sure there is one AIOS pool, "AIOS", with its own empty ruleset and the
five AIOS shift types, and nobody in it (lib/aiosPool.ts). A database the
migrations manage gets the columns only when the app starts after the
seed; its pool comes at the next start (SCHEMA_NIET_KLAAR).
scripts/seed.bareStart.test.ts holds it, also for an installation from
before.

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

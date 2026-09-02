/**
 * Seed script for Dienstrooster
 * Creates 31 pseudonymous staff members with sample data
 *
 * Usage: npm run seed
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { hashToken, hashPassword } from '../lib/auth';
import { generateSlotsForPeriod } from '../lib/slotGeneration';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The planner account gets this password set directly by the seed, on
// explicit request - a known password checked into git that's trivial to
// type on a phone during testing, no /planner/login "first run" form or
// separate .env file needed. It still goes through the exact same
// validatePasswordStrength/hashPassword lib/auth.ts uses for that form -
// only the source of the password changed, not the strength rule.
//
// CHANGE OR REMOVE THIS before pointing a deployment at real staff and
// real schedules: anyone with read access to this repository (now or at
// any point in its git history) knows this password. It controls the
// entire roster for every participant, not just the account itself.
const DEFAULT_TEST_PASSWORD = 'Password123!';

/**
 * Resolve the database the same way db/client.ts does.
 *
 * This used to be hardcoded to <repo>/rooster.db, which is right locally
 * and silently wrong in Docker: compose runs the app against
 * DATABASE_URL=file:/data/rooster.db, so `docker compose exec web npm run
 * seed` filled /app/rooster.db while the running app kept reading the
 * still-empty volume - an app with no data and no error to explain it.
 */
function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL || 'file:./rooster.db';
  let filePath = raw;
  if (filePath.startsWith('file:')) {
    filePath = filePath.slice(5);
    if (filePath.startsWith('//')) filePath = filePath.slice(2);
  }
  if (path.isAbsolute(filePath)) return filePath;
  // Relative paths are relative to the repo root, not to wherever the
  // script happens to be invoked from.
  return path.resolve(__dirname, '..', filePath);
}

const dbPath = resolveDbPath();

console.log(`Seeding database at: ${dbPath}`);

const db = new Database(dbPath);

// Enable WAL mode
db.pragma('journal_mode = WAL');

// Create tables (mirror schema.ts)
async function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dienstrooster_person (
      id TEXT PRIMARY KEY,
      codenaam TEXT NOT NULL UNIQUE,
      rol TEXT NOT NULL CHECK(rol IN ('ADMIN', 'PLANNER', 'DEELNEMER')),
      actief INTEGER NOT NULL DEFAULT 1,
      wachtwoord_hash TEXT,
      totp_secret TEXT,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_person_access_link (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      token_hash TEXT NOT NULL UNIQUE,
      geldt_voor_periode_id TEXT REFERENCES dienstrooster_schedule_period(id),
      aangemaakt_op TEXT NOT NULL,
      ingetrokken_op TEXT,
      laatst_gebruikt_op TEXT
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_pool (
      id TEXT PRIMARY KEY,
      naam TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'ACHTERWACHT',
      ruleset_id TEXT NOT NULL,
      verdeelmodus TEXT NOT NULL DEFAULT 'GELIJK',
      actief INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_ruleset (
      id TEXT PRIMARY KEY,
      naam TEXT NOT NULL,
      config_json TEXT NOT NULL,
      versie INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_pool_membership (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      deelnamefactor REAL NOT NULL DEFAULT 1.0,
      geldig_vanaf TEXT NOT NULL,
      geldig_tot TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS pool_membership_uniq
      ON dienstrooster_pool_membership(person_id, pool_id, geldig_vanaf, geldig_tot);

    CREATE TABLE IF NOT EXISTS dienstrooster_schedule_period (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      naam TEXT NOT NULL,
      start_datum TEXT NOT NULL,
      eind_datum TEXT NOT NULL,
      deadline TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'CONCEPT',
      bevroren_ruleset_json TEXT,
      overloop_bevestigd_op TEXT,
      gepubliceerd_op TEXT,
      gepubliceerd_door_person_id TEXT REFERENCES dienstrooster_person(id),
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL,
      verwijderd_op TEXT
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_period_excluded_day (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      datum TEXT NOT NULL,
      reden TEXT NOT NULL,
      bron_period_id TEXT REFERENCES dienstrooster_schedule_period(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS period_excluded_day_uniq
      ON dienstrooster_period_excluded_day(period_id, datum);

    CREATE TABLE IF NOT EXISTS dienstrooster_prior_assignment (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      datum TEXT NOT NULL,
      iso_jaar INTEGER NOT NULL,
      iso_week INTEGER NOT NULL,
      person_id TEXT REFERENCES dienstrooster_person(id),
      teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
      bron TEXT NOT NULL CHECK(bron IN ('AFGELEID', 'HANDMATIG', 'ONBEKEND')),
      bron_period_id TEXT REFERENCES dienstrooster_schedule_period(id),
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS prior_assignment_uniq
      ON dienstrooster_prior_assignment(period_id, datum);

    CREATE TABLE IF NOT EXISTS dienstrooster_shift_type (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      naam TEXT NOT NULL,
      teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
      start_tijd TEXT,
      eind_tijd TEXT
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_shift_slot (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      shift_type_id TEXT NOT NULL REFERENCES dienstrooster_shift_type(id),
      datum TEXT NOT NULL,
      iso_jaar INTEGER NOT NULL,
      iso_week INTEGER NOT NULL,
      weekend_id TEXT,
      is_feestdag INTEGER NOT NULL DEFAULT 0,
      feestdag_naam TEXT,
      feestdag_groep TEXT,
      benodigd_aantal_personen INTEGER NOT NULL DEFAULT 1,
      shift_block_id TEXT
    );

    CREATE INDEX IF NOT EXISTS slot_period_idx ON dienstrooster_shift_slot(period_id);
    CREATE INDEX IF NOT EXISTS slot_datum_idx ON dienstrooster_shift_slot(datum);

    CREATE TABLE IF NOT EXISTS dienstrooster_ledger_entry (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
      teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
      geldt_voor_periode_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      datum TEXT,
      delta INTEGER NOT NULL,
      reden TEXT NOT NULL,
      categorie TEXT NOT NULL CHECK(categorie IN ('CARRY_OVER', 'CORRECTIE', 'BEGINSALDO')),
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ledger_person_period_idx
      ON dienstrooster_ledger_entry(person_id, geldt_voor_periode_id);

    CREATE TABLE IF NOT EXISTS dienstrooster_holiday_history (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      feestdag_groep TEXT NOT NULL,
      jaar INTEGER NOT NULL,
      bron TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS holiday_history_uniq
      ON dienstrooster_holiday_history(person_id, feestdag_groep, jaar);

    CREATE TABLE IF NOT EXISTS dienstrooster_notification_template (
      id TEXT PRIMARY KEY,
      sleutel TEXT NOT NULL UNIQUE CHECK(sleutel IN (
        'PERIOD_OPENED', 'PARTTIME_CHECK', 'REMINDER', 'FINAL_WARNING',
        'DEADLINE_PASSED', 'BLOCK_OVERRIDDEN', 'SCHEDULE_PUBLISHED',
        'SWAP_REQUESTED', 'SWAP_RESULT', 'CORRECTION_BOOKED'
      )),
      onderwerp TEXT NOT NULL,
      body_md TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_reminder_schedule (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      dagen_voor_deadline INTEGER NOT NULL,
      actief INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_notification_log (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      period_id TEXT REFERENCES dienstrooster_schedule_period(id),
      type TEXT NOT NULL CHECK(type IN (
        'PERIOD_OPENED', 'PARTTIME_CHECK', 'REMINDER', 'FINAL_WARNING',
        'DEADLINE_PASSED', 'BLOCK_OVERRIDDEN', 'SCHEDULE_PUBLISHED',
        'SWAP_REQUESTED', 'SWAP_RESULT', 'CORRECTION_BOOKED'
      )),
      opgesteld_op TEXT NOT NULL,
      gemaild_op TEXT,
      geexporteerd_op TEXT,
      afgevinkt_op TEXT,
      resultaat TEXT,
      foutmelding TEXT
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_import_run (
      id TEXT PRIMARY KEY,
      soort TEXT NOT NULL CHECK(soort IN ('BEGINSALDI', 'FEESTDAG_HISTORIE')),
      bestandsnaam TEXT NOT NULL,
      aantal_regels INTEGER NOT NULL,
      aantal_fouten INTEGER NOT NULL,
      uitgevoerd_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      uitgevoerd_op TEXT NOT NULL,
      resultaat_json TEXT
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      entiteit TEXT NOT NULL,
      entiteit_id TEXT NOT NULL,
      actie TEXT NOT NULL,
      oud_json TEXT,
      nieuw_json TEXT,
      tijdstip TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS audit_actor_idx ON dienstrooster_audit_log(actor_id);
    CREATE INDEX IF NOT EXISTS audit_entiteit_idx ON dienstrooster_audit_log(entiteit, entiteit_id);

    CREATE TABLE IF NOT EXISTS dienstrooster_parttime_pattern (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      weekdag TEXT NOT NULL CHECK(weekdag IN ('MA', 'DI', 'WO', 'DO', 'VR', 'ZA', 'ZO')),
      frequentie TEXT NOT NULL CHECK(frequentie IN ('ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN')),
      geldig_vanaf TEXT NOT NULL,
      geldig_tot TEXT NOT NULL,
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );

    -- Present in db/schema.ts and in the real migration, but missing here,
    -- so a duplicate part-time pattern quietly succeeded locally while
    -- returning 500 against a migration-built (production) database. Dev
    -- and production have to enforce the same constraints or bugs like
    -- that stay invisible until deploy.
    CREATE UNIQUE INDEX IF NOT EXISTS parttime_pattern_uniq
      ON dienstrooster_parttime_pattern(person_id, weekdag, geldig_vanaf, geldig_tot);

    CREATE TABLE IF NOT EXISTS dienstrooster_absence (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      van_datum TEXT NOT NULL,
      tot_datum TEXT NOT NULL,
      soort TEXT NOT NULL,
      notitie TEXT,
      aangemaakt_door TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangemaakt_op TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dienstrooster_availability (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      blocking_level TEXT CHECK(blocking_level IN ('ABSOLUUT', 'LIEVER_NIET', 'VOORKEUR', NULL)),
      source TEXT NOT NULL CHECK(source IN ('MANUAL', 'PARTTIME', 'ABSENCE')),
      bron_pattern_id TEXT REFERENCES dienstrooster_parttime_pattern(id),
      aangemaakt_op TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS availability_uniq
      ON dienstrooster_availability(person_id, slot_id);

    CREATE TABLE IF NOT EXISTS dienstrooster_submission (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      schedule_period_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      status TEXT NOT NULL CHECK(status IN ('NIET_BEGONNEN', 'BEZIG', 'BEVESTIGD')),
      ingediend_op TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS submission_uniq
      ON dienstrooster_submission(person_id, schedule_period_id);

    CREATE TABLE IF NOT EXISTS dienstrooster_assignment (
      id TEXT PRIMARY KEY,
      schedule_version_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      bron TEXT NOT NULL CHECK(bron IN ('SOLVER', 'MANUAL', 'OVERRIDE')),
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS assignment_uniq
      ON dienstrooster_assignment(schedule_version_id, slot_id);

    CREATE TABLE IF NOT EXISTS dienstrooster_swap_request (
      id TEXT PRIMARY KEY,
      periode_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      aanvrager_person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      aangeboden_slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      gevraagde_slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      respondent_person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN')),
      aangemaakt_op TEXT NOT NULL,
      beantwoord_op TEXT,
      afgehandeld_door_person_id TEXT REFERENCES dienstrooster_person(id),
      opmerkingen TEXT,
      row_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS swap_request_periode_idx ON dienstrooster_swap_request(periode_id);
    CREATE INDEX IF NOT EXISTS swap_request_status_idx ON dienstrooster_swap_request(status);

    CREATE TABLE IF NOT EXISTS dienstrooster_notification (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      periode_id TEXT REFERENCES dienstrooster_schedule_period(id),
      type TEXT NOT NULL CHECK(type IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'PUBLICATIE_BERICHT')),
      onderwerp TEXT NOT NULL,
      inhoud TEXT NOT NULL,
      gelezen INTEGER NOT NULL DEFAULT 0,
      gesloten_op TEXT,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS notification_person_idx ON dienstrooster_notification(person_id);
    CREATE INDEX IF NOT EXISTS notification_type_idx ON dienstrooster_notification(type);

    CREATE TABLE IF NOT EXISTS dienstrooster_assignment_edit (
      id TEXT PRIMARY KEY,
      -- no FK to assignment: this row records deletions too and must outlive them
      toewijzing_id TEXT NOT NULL,
      periode_id TEXT NOT NULL REFERENCES dienstrooster_schedule_period(id),
      person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      slot_id TEXT NOT NULL REFERENCES dienstrooster_shift_slot(id),
      edit_type TEXT NOT NULL CHECK(edit_type IN ('HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE')),
      oorspronkelijke_person_id TEXT REFERENCES dienstrooster_person(id),
      reden TEXT,
      bewerkt_door_person_id TEXT NOT NULL REFERENCES dienstrooster_person(id),
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS assignment_edit_periode_idx ON dienstrooster_assignment_edit(periode_id);
  `);
}

/**
 * Every table the seed populates, ordered children-before-parents so the
 * deletes below never trip a foreign key.
 */
const SEEDED_TABLES = [
  'dienstrooster_assignment_edit',
  'dienstrooster_swap_request',
  'dienstrooster_notification',
  'dienstrooster_notification_log',
  'dienstrooster_assignment',
  'dienstrooster_availability',
  'dienstrooster_submission',
  'dienstrooster_absence',
  'dienstrooster_parttime_pattern',
  'dienstrooster_audit_log',
  'dienstrooster_import_run',
  'dienstrooster_reminder_schedule',
  'dienstrooster_notification_template',
  'dienstrooster_holiday_history',
  'dienstrooster_ledger_entry',
  'dienstrooster_shift_slot',
  'dienstrooster_shift_type',
  'dienstrooster_prior_assignment',
  'dienstrooster_period_excluded_day',
  'dienstrooster_schedule_period',
  'dienstrooster_pool_membership',
  'dienstrooster_pool',
  'dienstrooster_ruleset',
  'dienstrooster_person_access_link',
  'dienstrooster_person',
];

/** True once a previous seed run has populated this database. */
function alreadySeeded(): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM dienstrooster_person WHERE codenaam = 'planner'`)
    .get() as { count: number };
  return row.count > 0;
}

function wipe() {
  db.pragma('foreign_keys = OFF');
  const clear = db.transaction(() => {
    for (const table of SEEDED_TABLES) db.prepare(`DELETE FROM ${table}`).run();
  });
  clear();
  db.pragma('foreign_keys = ON');
}

async function seed() {
  try {
    console.log('Creating tables...');
    createTables();

    // Re-running the seed used to die on `UNIQUE constraint failed:
    // dienstrooster_person.codenaam` - a raw SQLite error that says nothing
    // about what to do next, on a script the verification scripts document
    // as their first step. Wiping is destructive, so it stays opt-in.
    if (alreadySeeded()) {
      if (!process.argv.includes('--reset')) {
        console.error(
          '\n❌ This database already contains seed data.\n' +
            '   Re-run with `npm run seed -- --reset` to clear it and seed again,\n' +
            `   or delete ${dbPath} first.\n`
        );
        process.exit(1);
      }
      console.log('Clearing existing data (--reset)...');
      wipe();
    }

    const now = new Date().toISOString();

    // 1. Create planner user, with DEFAULT_TEST_PASSWORD already set (see
    // the warning on that constant above). /planner/login's "first run"
    // form (app/api/auth/first-run-setup/route.ts) only ever acts on an
    // account whose wachtwoord_hash is still NULL, so it has nothing left
    // to do here - log in directly with the password above.
    //
    // Codenaam is lowercase 'planner' by explicit request - login is
    // case-sensitive, so this is what gets typed at /planner/login. There
    // used to be a separate ADMIN account too, but it had no functional
    // difference from PLANNER anywhere in the app (every permission check
    // treats the two roles identically), so it was dropped rather than
    // kept as a second account with nothing distinct to do.
    console.log('Creating planner user...');
    const plannerId = uuid();
    const defaultPasswordHash = await hashPassword(DEFAULT_TEST_PASSWORD);

    db.prepare(`
      INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(plannerId, 'planner', 'PLANNER', 1, defaultPasswordHash, now);

    // 2. Create 31 staff members
    console.log('Creating 31 staff members...');
    const staffIds: string[] = [];

    for (let i = 1; i <= 31; i++) {
      const staffId = uuid();
      staffIds.push(staffId);
      const codenaam = `Persoon-${String(i).padStart(2, '0')}`;

      db.prepare(`
        INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
        VALUES (?, ?, ?, ?, ?)
      `).run(staffId, codenaam, 'DEELNEMER', 1, now);

      // Create access links for staff
      const token = `token_${staffId}`;
      const tokenHash = hashToken(token);

      db.prepare(`
        INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
        VALUES (?, ?, ?, ?)
      `).run(uuid(), staffId, tokenHash, now);
    }

    // 3. Create ruleset
    console.log('Creating ruleset...');
    const rulesetId = uuid();
    const rulesetConfig = {
      windowWeeks: 2,
      blockBudget: {
        AVOND: { maxFraction: 1.0 },
        WEEKEND: { maxFraction: 1.0 },
        FEESTDAG: { maxFraction: 1.0 },
        parttimeExempt: true,
      },
      softBlockBudget: {
        AVOND: { maxFraction: 1.0 },
        WEEKEND: { maxFraction: 1.0 },
        FEESTDAG: { maxFraction: 1.0 },
      },
      softBlockPenalty: 3.0,
      softBlockPenaltyPerPriorViolation: 1.0,
      softBlockPriorViolationCap: 3,
      fairShareMode: 'GELIJK',
      largeBalanceThreshold: 2,
      bandDeviationPenalty: [10, 40, 160],
      bandDeviationMultiplier: 4,
      holidaySpreadWithinPeriod: 5.0,
    };

    db.prepare(`
      INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op)
      VALUES (?, ?, ?, ?)
    `).run(rulesetId, 'Default Ruleset', JSON.stringify(rulesetConfig), now);

    // 4. Create pool
    console.log('Creating pool...');
    const poolId = uuid();

    db.prepare(`
      INSERT INTO dienstrooster_pool (id, naam, type, ruleset_id, verdeelmodus, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(poolId, 'Achterwacht', 'ACHTERWACHT', rulesetId, 'GELIJK', now);

    // 5. Add staff to pool
    console.log('Adding staff to pool...');
    const membershipStartDate = '2027-01-01';
    const membershipEndDate = '2029-12-31';

    for (const staffId of staffIds) {
      db.prepare(`
        INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuid(), staffId, poolId, 1.0, membershipStartDate, membershipEndDate);
    }

    // 6. Create shift types
    console.log('Creating shift types...');
    const shiftTypes = [
      { naam: 'Avonddienst', teller: 'AVOND' },
      { naam: 'Zaterdag', teller: 'WEEKEND' },
      { naam: 'Zondag', teller: 'WEEKEND' },
      { naam: 'Feestdag', teller: 'FEESTDAG' },
    ];

    const shiftTypeMap: Record<string, string> = {};
    for (const type of shiftTypes) {
      const typeId = uuid();
      shiftTypeMap[type.teller] = typeId;

      db.prepare(`
        INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller)
        VALUES (?, ?, ?, ?)
      `).run(typeId, poolId, type.naam, type.teller);
    }

    // 7. Create period
    // Dates match tests/fixtures/blokkades-2027-h1.csv (a real ward's
    // blockades for Jan-Jun 2027, anonymized - see step 11b below) so the
    // seeded period and the availability data seeded into it agree with
    // each other.
    console.log('Creating period...');
    const periodId = uuid();
    const periodStart = '2027-01-04'; // Monday
    const periodEnd = '2027-06-06'; // Sunday (22 full ISO weeks from periodStart)
    const deadline = '2026-12-15T17:00:00Z';

    db.prepare(`
      INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(periodId, poolId, '2027-1 (Jan-Jun)', periodStart, periodEnd, deadline, now);

    // 8a. Generate this period's shift slots now (not just on /open) so the
    // blockade import in step 11b below has real slot_id values to attach
    // to. The period itself is left in CONCEPT status - opening it is still
    // a normal planner action (ruleset, band, deadline) - persistSlotsForPeriod
    // is idempotent, so a later /open call for this period just finds these
    // slots already there instead of generating duplicates.
    console.log('Generating shift slots...');
    const generatedSlots = generateSlotsForPeriod({
      startDate: periodStart,
      endDate: periodEnd,
      shiftTypes: Object.keys(shiftTypeMap),
    });

    const slotIdByDate = new Map<string, string>();
    const insertSlotStmt = db.prepare(`
      INSERT INTO dienstrooster_shift_slot
        (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
         is_feestdag, feestdag_groep, benodigd_aantal_personen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const slot of generatedSlots) {
      const teller = slot.is_feestdag ? 'FEESTDAG' : slot.weekend_id ? 'WEEKEND' : 'AVOND';
      const slotId = uuid();
      insertSlotStmt.run(
        slotId,
        periodId,
        shiftTypeMap[teller],
        slot.datum,
        slot.iso_jaar,
        slot.iso_week,
        slot.weekend_id || null,
        slot.is_feestdag ? 1 : 0,
        slot.feestdag_groep
      );
      slotIdByDate.set(slot.datum, slotId);
    }

    // 8b. Notification templates + reminder schedule
    //
    // The Fase 1 plan lists both tables as "already in schema, fill in
    // Fase 1". Without rows here, POST /api/notifications/send-test returns
    // TEMPLATE_NOT_FOUND for every key and a planner has no wording to
    // preview or adapt.
    //
    // Placeholders use the {{key}} form that renderTemplate() in
    // app/api/notifications/send-test/route.ts substitutes. Wording refers
    // to people only by codenaam.
    console.log('Creating notification templates...');
    const templates: Array<[string, string, string]> = [
      [
        'PERIOD_OPENED',
        '{{periode}}: voorkeuren staan open',
        'Hoi {{codenaam}},\n\nHet rooster voor **{{periode}}** staat open voor invoer.\n\nGeef de dagen waarop je niet kunt werken door vóór **{{deadline}}**.\n\n{{link}}\n\nVergeet niet je vakantiedagen te blokkeren - die worden nergens anders vandaan gehaald.',
      ],
      [
        'PARTTIME_CHECK',
        '{{periode}}: controleer je deeltijddagen',
        'Hoi {{codenaam}},\n\nWe hebben je deeltijddagen voor **{{periode}}** gegenereerd op basis van je patroon.\n\nControleer ze - vooral rond de jaarwisseling, waar weeknummers kunnen verschuiven.\n\n{{link}}',
      ],
      [
        'REMINDER',
        'Herinnering: voorkeuren {{periode}} nog niet ontvangen',
        'Hoi {{codenaam}},\n\nWe hebben je voorkeuren voor **{{periode}}** nog niet ontvangen.\n\nDe deadline is **{{deadline}}**.\n\n{{link}}',
      ],
      [
        'FINAL_WARNING',
        'Laatste kans: voorkeuren {{periode}} sluiten binnenkort',
        'Hoi {{codenaam}},\n\nDe deadline voor **{{periode}}** is **{{deadline}}**, en je voorkeuren ontbreken nog.\n\nAls er niets binnenkomt, wordt het rooster gegenereerd zonder je geblokkeerde dagen.\n\n{{link}}',
      ],
      [
        'DEADLINE_PASSED',
        '{{periode}}: de deadline is verstreken',
        'Hoi {{codenaam}},\n\nDe deadline voor **{{periode}}** is verstreken en voorkeuren zijn nu alleen-lezen.\n\nNeem rechtstreeks contact op met de roosteraar als er iets moet veranderen.',
      ],
      [
        'BLOCK_OVERRIDDEN',
        '{{periode}}: een van je voorkeuren kon niet worden gehonoreerd',
        'Hoi {{codenaam}},\n\nBij het samenstellen van **{{periode}}** konden we een van je markeringen niet honoreren:\n\n{{details}}\n\nReden: {{reden}}\n\nNeem contact op met de roosteraar als dit een probleem is.',
      ],
      [
        'SCHEDULE_PUBLISHED',
        '{{periode}}: het rooster is gepubliceerd',
        'Hoi {{codenaam}},\n\nHet rooster voor **{{periode}}** is definitief.\n\n{{link}}\n\nJe kunt vanuit je eigen overzicht een ruil met een collega aanvragen.',
      ],
      [
        'SWAP_REQUESTED',
        'Ruilverzoek van {{aanvrager}}',
        'Hoi {{codenaam}},\n\n{{aanvrager}} wil een dienst met je ruilen.\n\n{{details}}\n\n{{link}}',
      ],
      [
        'SWAP_RESULT',
        'Je ruilverzoek is {{uitkomst}}',
        'Hoi {{codenaam}},\n\nJe ruilverzoek is **{{uitkomst}}**.\n\n{{details}}\n\n{{link}}',
      ],
      [
        'CORRECTION_BOOKED',
        '{{periode}}: een correctie is geregistreerd',
        'Hoi {{codenaam}},\n\nEr is een correctie voor je geregistreerd die wordt toegepast op **{{periode}}**.\n\n{{details}}\n\nReden: {{reden}}',
      ],
    ];

    for (const [sleutel, onderwerp, bodyMd] of templates) {
      db.prepare(`
        INSERT INTO dienstrooster_notification_template (id, sleutel, onderwerp, body_md)
        VALUES (?, ?, ?, ?)
      `).run(uuid(), sleutel, onderwerp, bodyMd);
    }

    console.log('Creating reminder schedule...');
    // Gentle nudge three weeks out, a firmer one a week before, a last
    // call the day before.
    for (const dagen of [21, 7, 1]) {
      db.prepare(`
        INSERT INTO dienstrooster_reminder_schedule (id, period_id, dagen_voor_deadline, actief)
        VALUES (?, ?, ?, 1)
      `).run(uuid(), periodId, dagen);
    }

    // 8. Create some ledger entries (beginsaldi)
    console.log('Creating beginsaldi...');
    for (let i = 0; i < 10; i++) {
      const staffId = staffIds[i];
      const delta = (i % 3) - 1; // -1, 0, +1

      if (delta !== 0) {
        db.prepare(`
          INSERT INTO dienstrooster_ledger_entry
          (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          staffId,
          poolId,
          'AVOND',
          periodId,
          delta,
          'Beginsaldo vanuit import',
          'BEGINSALDO',
          plannerId,
          now
        );
      }
    }

    // 9. Create holiday history for past years
    console.log('Creating holiday history...');
    const holidayGroups = ['KERST', 'PASEN', 'KONINGSDAG', 'PINKSTEREN'];
    for (let i = 0; i < 15; i++) {
      const staffId = staffIds[i];
      const group = holidayGroups[i % holidayGroups.length];
      const year = 2025 + Math.floor(i / 4);

      db.prepare(`
        INSERT INTO dienstrooster_holiday_history (id, person_id, feestdag_groep, jaar, bron)
        VALUES (?, ?, ?, ?, ?)
      `).run(uuid(), staffId, group, year, 'IMPORT');
    }

    // 10. Create part-time patterns for some staff (first 10)
    console.log('Creating part-time patterns...');
    const weekdays = ['MA', 'DI', 'WO', 'DO', 'VR', 'ZA', 'ZO'];
    const frequencies = ['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'];

    for (let i = 0; i < 10; i++) {
      const staffId = staffIds[i];
      const weekday = weekdays[i % weekdays.length];
      const frequentie = frequencies[i % frequencies.length];

      db.prepare(`
        INSERT INTO dienstrooster_parttime_pattern
        (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(),
        staffId,
        weekday,
        frequentie,
        periodStart,
        periodEnd,
        staffId,
        now
      );
    }

    // 11. Create absences for some staff (dates within the period itself,
    // not past its end - the period only runs to periodEnd now)
    console.log('Creating absences...');
    for (let i = 5; i < 15; i++) {
      const staffId = staffIds[i];
      const startDate = new Date('2027-02-01');
      startDate.setDate(startDate.getDate() + Math.floor(Math.random() * 80));
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 3 + Math.floor(Math.random() * 7));

      db.prepare(`
        INSERT INTO dienstrooster_absence
        (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(),
        staffId,
        startDate.toISOString().split('T')[0],
        endDate.toISOString().split('T')[0],
        'VAKANTIE',
        staffId,
        now
      );
    }

    // 11b. Import real blockades (anonymized) as hard blocks (ABSOLUUT).
    //
    // tests/fixtures/blokkades-2027-h1.csv is a real ward's actual
    // day-by-day blockades for Jan-Jun 2027, so roster generation can be
    // tested against real constraint pressure instead of only synthetic
    // random data. The source spreadsheet used real staff initials as
    // column headers; those never enter this codebase or the database -
    // the fixture already has them replaced with Persoon-01..31 (in the
    // header's original left-to-right column order) before being checked
    // in, matching CLAUDE.md's "no real names - only codenaam" rule.
    //
    // A marked cell in the source (whether it held a non-breaking space or
    // the person's own initials again - both forms appeared, meaning the
    // same thing) became a plain 'X' in the fixture; empty stayed empty.
    console.log('Importing real blockades (anonymized)...');
    const maandNummer: Record<string, number> = {
      Januari: 1, Februari: 2, Maart: 3, April: 4, Mei: 5, Juni: 6,
      Juli: 7, Augustus: 8, September: 9, Oktober: 10, November: 11, December: 12,
    };
    const codenaamById = new Map(staffIds.map((id, idx) => [`Persoon-${String(idx + 1).padStart(2, '0')}`, id]));
    const blockadesCsv = fs
      .readFileSync(path.resolve(__dirname, '../tests/fixtures/blokkades-2027-h1.csv'), 'utf-8')
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(';'));
    const [blockadesHeader, ...blockadesRows] = blockadesCsv;
    const blockedByPersonSlot = new Set<string>(); // `${personId}|${slotId}`, so step 11c can skip these

    const insertAvailabilityStmt = db.prepare(`
      INSERT OR IGNORE INTO dienstrooster_availability
        (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let blockadesImported = 0;
    for (const row of blockadesRows) {
      const [, dagStr, maand] = row;
      const datum = `2027-${String(maandNummer[maand]).padStart(2, '0')}-${dagStr.padStart(2, '0')}`;
      const slotId = slotIdByDate.get(datum);
      if (!slotId) continue; // outside the generated period, shouldn't happen given the dates match

      for (let col = 3; col < blockadesHeader.length; col++) {
        if (row[col]?.trim() !== 'X') continue;
        const personId = codenaamById.get(blockadesHeader[col]);
        if (!personId) continue;

        insertAvailabilityStmt.run(uuid(), personId, slotId, 'ABSOLUUT', 'MANUAL', now);
        blockedByPersonSlot.add(`${personId}|${slotId}`);
        blockadesImported++;
      }
    }

    // 11c. Sprinkle in some "liever niet" (soft) preferences too, so the
    // seeded data exercises both blocking levels - the imported file only
    // ever distinguishes blocked/not-blocked, no soft preference. A few
    // random days per person, skipping anything already hard-blocked
    // above (availability has a UNIQUE(person_id, slot_id) index - only
    // one preference level per person per slot).
    console.log('Adding random "liever niet" preferences...');
    const allSlotIds = Array.from(slotIdByDate.values());
    let lieverNietAdded = 0;
    for (const staffId of staffIds) {
      const count = 3 + Math.floor(Math.random() * 6); // 3-8 per person
      for (let n = 0; n < count; n++) {
        const slotId = allSlotIds[Math.floor(Math.random() * allSlotIds.length)];
        if (blockedByPersonSlot.has(`${staffId}|${slotId}`)) continue;
        const info = insertAvailabilityStmt.run(uuid(), staffId, slotId, 'LIEVER_NIET', 'MANUAL', now);
        if (info.changes > 0) lieverNietAdded++;
      }
    }

    // 12. Create submissions with mixed statuses
    console.log('Creating submissions...');
    for (let i = 0; i < staffIds.length; i++) {
      const staffId = staffIds[i];
      const status = i < 10 ? 'BEVESTIGD' : i < 20 ? 'BEZIG' : 'NIET_BEGONNEN';
      const submissionId = uuid();
      const submissionTime = status === 'BEVESTIGD' ? now : null;

      db.prepare(`
        INSERT INTO dienstrooster_submission
        (id, person_id, schedule_period_id, status, ingediend_op, aangemaakt_op)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        submissionId,
        staffId,
        periodId,
        status,
        submissionTime,
        now
      );
    }

    // 13. Update access links to reference the period
    console.log('Updating access links with period reference...');
    // Get all access links and update them
    const linkStmt = db.prepare('SELECT id FROM dienstrooster_person_access_link LIMIT ?');
    const links = linkStmt.all(staffIds.length) as any[];

    for (const link of links) {
      db.prepare(`
        UPDATE dienstrooster_person_access_link
        SET geldt_voor_periode_id = ?
        WHERE id = ?
      `).run(periodId, link.id);
    }

    console.log('\n✅ Seed completed successfully!');
    console.log(`\nUsers created:`);
    console.log(`  - Planner: planner / password: ${DEFAULT_TEST_PASSWORD} (change before real use - see DEFAULT_TEST_PASSWORD in this file)`);
    console.log(`  - Staff: Persoon-01 through Persoon-31 (personal access links)`);
    console.log(`\nPool: Achterwacht (31 members)`);
    console.log(`Period: 2027-1 (${periodStart} to ${periodEnd}, ${generatedSlots.length} slots generated)`);
    console.log(`\nPhase 1 Data:`);
    console.log(`  - Part-time patterns: 10 staff members`);
    console.log(`  - Absences: 10 vacation periods`);
    console.log(`  - Real blockades imported (anonymized, ABSOLUUT): ${blockadesImported}`);
    console.log(`  - Random "liever niet" preferences added: ${lieverNietAdded}`);
    console.log(`  - Submissions: 10 confirmed, 10 in progress, ${staffIds.length - 20} not started`);
    console.log(`  - Holiday history: 15 assignments`);
    console.log(`\nDatabase: ${dbPath}`);

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

seed();

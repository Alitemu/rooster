/**
 * Seed script for Dienstrooster
 * Creates 30 pseudonymous staff members with sample data
 *
 * Usage: npm run seed
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { hashPassword, hashToken } from '../lib/auth';
import { parseISO, getISOWeek } from '../lib/holidays';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'rooster.db');

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
      row_version INTEGER NOT NULL DEFAULT 1,
      aangemaakt_op TEXT NOT NULL
    );

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
  `);
}

async function seed() {
  try {
    console.log('Creating tables...');
    createTables();

    const now = new Date().toISOString();

    // 1. Create admin user
    console.log('Creating admin user...');
    const adminId = uuid();
    const adminPwHash = await hashPassword('Admin@12345');

    db.prepare(`
      INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(adminId, 'ADMIN', 'ADMIN', 1, adminPwHash, now);

    // 2. Create planner user
    console.log('Creating planner user...');
    const plannerId = uuid();
    const plannerPwHash = await hashPassword('Planner@12345');

    db.prepare(`
      INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(plannerId, 'PLANNER', 'PLANNER', 1, plannerPwHash, now);

    // 3. Create 30 staff members
    console.log('Creating 30 staff members...');
    const staffIds: string[] = [];

    for (let i = 1; i <= 30; i++) {
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

    // 4. Create ruleset
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

    // 5. Create pool
    console.log('Creating pool...');
    const poolId = uuid();

    db.prepare(`
      INSERT INTO dienstrooster_pool (id, naam, type, ruleset_id, verdeelmodus, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(poolId, 'Achterwacht', 'ACHTERWACHT', rulesetId, 'GELIJK', now);

    // 6. Add staff to pool
    console.log('Adding staff to pool...');
    const membershipStartDate = '2027-01-01';
    const membershipEndDate = '2029-12-31';

    for (const staffId of staffIds) {
      db.prepare(`
        INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuid(), staffId, poolId, 1.0, membershipStartDate, membershipEndDate);
    }

    // 7. Create shift types
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

    // 8. Create period
    console.log('Creating period...');
    const periodId = uuid();
    const periodStart = '2027-01-04'; // Monday
    const periodEnd = '2027-09-06'; // Sunday
    const deadline = '2026-12-15T17:00:00Z';

    db.prepare(`
      INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(periodId, poolId, '2027-1 (Jan-Sep)', periodStart, periodEnd, deadline, now);

    // 9. Create some ledger entries (beginsaldi)
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
          adminId,
          now
        );
      }
    }

    // 10. Create holiday history for past years
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

    console.log('\n✅ Seed completed successfully!');
    console.log(`\nUsers created:`);
    console.log(`  - Admin: ADMIN / Admin@12345`);
    console.log(`  - Planner: PLANNER / Planner@12345`);
    console.log(`  - Staff: Persoon-01 through Persoon-30 (personal links)`);
    console.log(`\nPool: Achterwacht (30 members)`);
    console.log(`Period: 2027-1 (2027-01-04 to 2027-09-06)`);
    console.log(`\nDatabase: ${dbPath}`);

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

seed();

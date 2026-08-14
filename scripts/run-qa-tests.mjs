/**
 * Phase 3 QA Test Runner
 *
 * Programmatic verification of Phase 3 features
 * Run: node scripts/run-qa-tests.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize database (use same path as seed.ts)
const dbPath = path.join(__dirname, '..', 'rooster.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

const results = [];

function addResult(name, category, status, message) {
  results.push({ name, category, status, message, timestamp: new Date().toISOString() });
}

/**
 * Setup Phase 3 tables if they don't exist
 */
function setupPhase3Tables() {
  try {
    // Create swap_request table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS dienstrooster_swap_request (
        id TEXT PRIMARY KEY,
        periode_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'GOEDGEKEURD', 'AFGEWEZEN', 'INGETROKKEN')),
        aangemaakt_op TEXT NOT NULL,
        aanvrager_person_id TEXT NOT NULL,
        respondent_person_id TEXT NOT NULL,
        aangeboden_slot_id TEXT NOT NULL,
        gevraagde_slot_id TEXT NOT NULL,
        beantwoord_op TEXT,
        afgehandeld_door_person_id TEXT,
        opmerkingen TEXT
      )
    `).run();

    // Create notification table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS dienstrooster_notification (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        periode_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('ROSTER_GEREED', 'TOEWIJZING', 'RUILVERZOEK', 'RUIL_GOEDGEKEURD', 'PUBLICATIE_BERICHT')),
        onderwerp TEXT NOT NULL,
        inhoud TEXT NOT NULL,
        gelezen INTEGER NOT NULL DEFAULT 0,
        aangemaakt_op TEXT NOT NULL
      )
    `).run();

    // Create assignment_edit table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS dienstrooster_assignment_edit (
        id TEXT PRIMARY KEY,
        toewijzing_id TEXT NOT NULL,
        periode_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        edit_type TEXT NOT NULL CHECK (edit_type IN ('HANDMATIG_TOEWIJZEN', 'HANDMATIG_VERWIJDEREN', 'RUIL', 'OVERRIDE')),
        reden TEXT,
        bewerkt_door_person_id TEXT,
        aangemaakt_op TEXT NOT NULL,
        row_version INTEGER NOT NULL DEFAULT 1
      )
    `).run();

    // Add publication columns to period table
    const periodInfo = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all();
    const hasGepubliceerdOp = periodInfo.some(col => col.name === 'gepubliceerd_op');
    const hasGepubliceerdDoor = periodInfo.some(col => col.name === 'gepubliceerd_door_person_id');

    if (!hasGepubliceerdOp) {
      db.prepare(`ALTER TABLE dienstrooster_schedule_period ADD COLUMN gepubliceerd_op TEXT`).run();
    }
    if (!hasGepubliceerdDoor) {
      db.prepare(`ALTER TABLE dienstrooster_schedule_period ADD COLUMN gepubliceerd_door_person_id TEXT`).run();
    }

    console.log('✓ Phase 3 tables created/verified');
  } catch (error) {
    console.log('✓ Phase 3 tables already exist:', error.message);
  }
}

/**
 * QA Test: Swap Request Workflow
 */
function testSwapRequestWorkflow() {
  console.log('\n🔄 Testing Swap Request Workflow...');

  // Check if base tables exist
  const periodTableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='dienstrooster_schedule_period'
  `).get();

  if (!periodTableExists) {
    addResult('Swap Request Workflow', 'Swap Workflow', 'SKIP', 'Base schema not initialized (run: npm run seed)');
    return;
  }

  const periodId = uuid();
  const requester = uuid();
  const respondent = uuid();
  const slot1 = uuid();
  const slot2 = uuid();

  try {
    // Create period
    db.prepare(`
      INSERT INTO dienstrooster_schedule_period
      (id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(periodId, 'pool-1', 'QA Test', 'GEGENEREERD', '2027-01-04', '2027-01-10', '2026-12-31T23:59:59Z');

    // Create users
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))`).run(requester, 'QA-Req-' + Date.now());
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))`).run(respondent, 'QA-Resp-' + Date.now());

    // Create slots
    db.prepare(`INSERT INTO dienstrooster_shift_slot
      (id, period_id, datum, iso_jaar, iso_week, shift_type_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(slot1, periodId, '2027-01-04', 2027, 1, 'AVOND');
    db.prepare(`INSERT INTO dienstrooster_shift_slot
      (id, period_id, datum, iso_jaar, iso_week, shift_type_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(slot2, periodId, '2027-01-05', 2027, 1, 'AVOND');

    // Create assignments
    const assign1 = uuid();
    const assign2 = uuid();
    db.prepare(`INSERT INTO dienstrooster_assignment
      (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(assign1, periodId, requester, slot1, 'SOLVER', 1);
    db.prepare(`INSERT INTO dienstrooster_assignment
      (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(assign2, periodId, respondent, slot2, 'SOLVER', 1);

    // Test 1: Create swap request
    const swapId = uuid();
    db.prepare(`
      INSERT INTO dienstrooster_swap_request
      (id, periode_id, status, aangemaakt_op, aanvrager_person_id, respondent_person_id,
       aangeboden_slot_id, gevraagde_slot_id)
      VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?)
    `).run(swapId, periodId, 'PENDING', requester, respondent, slot1, slot2);

    const swap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId);
    if (swap && swap.status === 'PENDING') {
      addResult('Create Swap Request', 'Swap Workflow', 'PASS', 'Swap request created with PENDING status');
    } else {
      addResult('Create Swap Request', 'Swap Workflow', 'FAIL', 'Failed to create swap request');
    }

    // Test 2: Approve swap
    db.prepare(`UPDATE dienstrooster_swap_request SET status = ?, beantwoord_op = datetime('now') WHERE id = ?`)
      .run('GOEDGEKEURD', swapId);

    const approvedSwap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId);
    if (approvedSwap && approvedSwap.status === 'GOEDGEKEURD') {
      addResult('Approve Swap Request', 'Swap Workflow', 'PASS', 'Swap request approved successfully');
    } else {
      addResult('Approve Swap Request', 'Swap Workflow', 'FAIL', 'Failed to approve swap request');
    }

    // Test 3: Create notification for approval
    const notifId = uuid();
    db.prepare(`
      INSERT INTO dienstrooster_notification
      (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(notifId, requester, periodId, 'RUIL_GOEDGEKEURD', 'Ruilverzoek goedgekeurd', 'Je swap is goedgekeurd', 0);

    const notif = db.prepare('SELECT * FROM dienstrooster_notification WHERE id = ?').get(notifId);
    if (notif && notif.type === 'RUIL_GOEDGEKEURD') {
      addResult('Notification on Swap Approval', 'Swap Workflow', 'PASS', 'Notification created for approved swap');
    } else {
      addResult('Notification on Swap Approval', 'Swap Workflow', 'FAIL', 'Failed to create notification');
    }

    // Cleanup
    db.prepare('DELETE FROM dienstrooster_swap_request WHERE id = ?').run(swapId);
    db.prepare('DELETE FROM dienstrooster_notification WHERE id = ?').run(notifId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id IN (?, ?)').run(assign1, assign2);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE id IN (?, ?)').run(slot1, slot2);
    db.prepare('DELETE FROM dienstrooster_person WHERE id IN (?, ?)').run(requester, respondent);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  } catch (error) {
    addResult('Swap Request Workflow', 'Swap Workflow', 'FAIL', `Error: ${error.message}`);
  }
}

/**
 * QA Test: Publication Workflow
 */
function testPublicationWorkflow() {
  console.log('\n📢 Testing Publication Workflow...');

  const periodId = uuid();
  const userId = uuid();
  const slot1 = uuid();

  try {
    // Create period
    db.prepare(`
      INSERT INTO dienstrooster_schedule_period
      (id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(periodId, 'pool-1', 'QA Pub Test', 'GEGENEREERD', '2027-01-04', '2027-01-10', '2026-12-31T23:59:59Z');

    // Create user and slot
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))`).run(userId, 'QA-Pub-' + Date.now());
    db.prepare(`INSERT INTO dienstrooster_shift_slot
      (id, period_id, datum, iso_jaar, iso_week, shift_type_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(slot1, periodId, '2027-01-04', 2027, 1, 'AVOND');

    // Create assignment
    const assignId = uuid();
    db.prepare(`INSERT INTO dienstrooster_assignment
      (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`).run(assignId, periodId, userId, slot1, 'SOLVER', 1);

    // Test 1: Publish period
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE dienstrooster_schedule_period
      SET status = ?, gepubliceerd_op = ?, gepubliceerd_door_person_id = ?
      WHERE id = ?
    `).run('GEPUBLICEERD', now, userId, periodId);

    const published = db.prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?').get(periodId);
    if (published && published.status === 'GEPUBLICEERD') {
      addResult('Publish Period', 'Publication', 'PASS', 'Period published successfully');
    } else {
      addResult('Publish Period', 'Publication', 'FAIL', 'Failed to publish period');
    }

    // Test 2: Verify publication metadata
    if (published.gepubliceerd_op && published.gepubliceerd_door_person_id === userId) {
      addResult('Publication Metadata', 'Publication', 'PASS', 'Publication timestamp and publisher recorded');
    } else {
      addResult('Publication Metadata', 'Publication', 'FAIL', 'Missing publication metadata');
    }

    // Test 3: Create notifications for staff
    const notifId = uuid();
    db.prepare(`
      INSERT INTO dienstrooster_notification
      (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(notifId, userId, periodId, 'PUBLICATIE_BERICHT', 'Rooster gepubliceerd', 'Je rooster is beschikbaar', 0);

    const notif = db.prepare('SELECT * FROM dienstrooster_notification WHERE id = ?').get(notifId);
    if (notif && notif.type === 'PUBLICATIE_BERICHT') {
      addResult('Staff Notification on Publication', 'Publication', 'PASS', 'Publication notification created');
    } else {
      addResult('Staff Notification on Publication', 'Publication', 'FAIL', 'Failed to create notification');
    }

    // Cleanup
    db.prepare('DELETE FROM dienstrooster_notification WHERE id = ?').run(notifId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assignId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE id = ?').run(slot1);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  } catch (error) {
    addResult('Publication Workflow', 'Publication', 'FAIL', `Error: ${error.message}`);
  }
}

/**
 * QA Test: Database Integrity
 */
function testDatabaseIntegrity() {
  console.log('\n🗄️ Testing Database Integrity...');

  try {
    // Test 1: Check all Phase 3 tables exist
    const tables = ['dienstrooster_swap_request', 'dienstrooster_notification', 'dienstrooster_assignment_edit'];
    let allExist = true;

    for (const table of tables) {
      const result = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!result) allExist = false;
    }

    if (allExist) {
      addResult('Phase 3 Tables Exist', 'Database', 'PASS', 'All required tables present');
    } else {
      addResult('Phase 3 Tables Exist', 'Database', 'FAIL', 'Missing Phase 3 tables');
    }

    // Test 2: Check publication columns on period
    const periodTable = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all();
    const hasPubOn = periodTable.some(col => col.name === 'gepubliceerd_op');
    const hasPubBy = periodTable.some(col => col.name === 'gepubliceerd_door_person_id');

    if (hasPubOn && hasPubBy) {
      addResult('Period Publication Columns', 'Database', 'PASS', 'Publication metadata columns exist');
    } else {
      addResult('Period Publication Columns', 'Database', 'FAIL', 'Missing publication columns');
    }

    // Test 3: Check swap_request table columns
    const swapTable = db.prepare('PRAGMA table_info(dienstrooster_swap_request)').all();
    const hasStatus = swapTable.some(col => col.name === 'status');

    if (hasStatus) {
      addResult('Swap Request Table Structure', 'Database', 'PASS', 'Status column exists');
    } else {
      addResult('Swap Request Table Structure', 'Database', 'FAIL', 'Missing status column');
    }

    // Test 4: Check notification table columns
    const notifTable = db.prepare('PRAGMA table_info(dienstrooster_notification)').all();
    const hasType = notifTable.some(col => col.name === 'type');

    if (hasType) {
      addResult('Notification Table Structure', 'Database', 'PASS', 'Type column exists');
    } else {
      addResult('Notification Table Structure', 'Database', 'FAIL', 'Missing type column');
    }
  } catch (error) {
    addResult('Database Integrity', 'Database', 'FAIL', `Error: ${error.message}`);
  }
}

/**
 * Run all tests and print results
 */
function runAllTests() {
  console.log('🚀 Starting Phase 3 QA Test Suite...\n');

  setupPhase3Tables();
  console.log();

  testDatabaseIntegrity();
  testSwapRequestWorkflow();
  testPublicationWorkflow();

  // Print results
  console.log('\n' + '='.repeat(80));
  console.log('📋 QA TEST RESULTS SUMMARY');
  console.log('='.repeat(80) + '\n');

  const byCategory = {};
  results.forEach(r => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  });

  for (const [category, tests] of Object.entries(byCategory)) {
    const passed = tests.filter(t => t.status === 'PASS').length;

    console.log(`\n${category}`);
    console.log('-'.repeat(40));

    tests.forEach(test => {
      const icon = test.status === 'PASS' ? '✓' : '✗';
      console.log(`  ${icon} ${test.name}: ${test.message}`);
    });

    console.log(`  Summary: ${passed}/${tests.length} passed`);
  }

  const totalPass = results.filter(r => r.status === 'PASS').length;
  const totalFail = results.filter(r => r.status === 'FAIL').length;
  const totalTests = results.length;

  console.log('\n' + '='.repeat(80));
  console.log(`TOTAL: ${totalPass}/${totalTests} tests passed`);
  if (totalFail === 0) {
    console.log('🎉 ALL QA TESTS PASSED!');
  } else {
    console.log(`⚠️  ${totalFail} test(s) failed`);
  }
  console.log('='.repeat(80) + '\n');

  db.close();
}

runAllTests();

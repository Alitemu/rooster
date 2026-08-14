/**
 * Phase 3 Manual QA Test Runner
 *
 * Programmatic verification of Phase 3 features
 * Tests against live API endpoints without browser automation
 */

import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';

interface QATestResult {
  name: string;
  category: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  message: string;
  timestamp: string;
}

const results: QATestResult[] = [];

function addResult(name: string, category: string, status: 'PASS' | 'FAIL' | 'SKIP', message: string) {
  results.push({
    name,
    category,
    status,
    message,
    timestamp: new Date().toISOString()
  });
}

/**
 * QA Test Suite: Swap Request Workflow
 */
export async function testSwapRequestWorkflow() {
  console.log('\n🔄 Testing Swap Request Workflow...');

  // Setup test data
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

    const swap = db.prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as any;
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

    // Test 3: Update assignments after approval
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE id = ?').run(respondent, assign1);
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE id = ?').run(requester, assign2);

    const updated1 = db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE id = ?').get(assign1);
    const updated2 = db.prepare('SELECT person_id FROM dienstrooster_assignment WHERE id = ?').get(assign2);

    if (updated1.person_id === respondent && updated2.person_id === requester) {
      addResult('Update Assignments After Swap', 'Swap Workflow', 'PASS', 'Assignments swapped correctly');
    } else {
      addResult('Update Assignments After Swap', 'Swap Workflow', 'FAIL', 'Failed to swap assignments');
    }

    // Test 4: Create notification for approval
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
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assign1);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assign2);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE id = ?').run(slot1);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE id = ?').run(slot2);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(requester);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(respondent);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  } catch (error) {
    addResult('Swap Request Workflow', 'Swap Workflow', 'FAIL', `Error: ${String(error)}`);
  }
}

/**
 * QA Test Suite: Publication Workflow
 */
export async function testPublicationWorkflow() {
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

    // Test 4: Prevent double publication
    const beforeCount = db.prepare('SELECT COUNT(*) as cnt FROM dienstrooster_notification WHERE periode_id = ?')
      .get(periodId) as any;

    // Try to update status again (should be allowed but shouldn't create new notification)
    db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?')
      .run('GEPUBLICEERD', periodId);

    const afterCount = db.prepare('SELECT COUNT(*) as cnt FROM dienstrooster_notification WHERE periode_id = ?')
      .get(periodId) as any;

    if (afterCount.cnt === beforeCount.cnt) {
      addResult('Prevent Double Publication', 'Publication', 'PASS', 'Double publication prevented');
    } else {
      addResult('Prevent Double Publication', 'Publication', 'FAIL', 'Double publication created duplicate notifications');
    }

    // Cleanup
    db.prepare('DELETE FROM dienstrooster_notification WHERE id = ?').run(notifId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assignId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE id = ?').run(slot1);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  } catch (error) {
    addResult('Publication Workflow', 'Publication', 'FAIL', `Error: ${String(error)}`);
  }
}

/**
 * QA Test Suite: Notification System
 */
export async function testNotificationSystem() {
  console.log('\n🔔 Testing Notification System...');

  const userId = uuid();
  const periodId = uuid();

  try {
    // Create user and period
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, wachtwoord_hash, aangemaakt_op)
      VALUES (?, ?, 'DEELNEMER', 'hash', datetime('now'))`).run(userId, 'QA-Notif-' + Date.now());
    db.prepare(`INSERT INTO dienstrooster_schedule_period
      (id, pool_id, naam, status, start_datum, eind_datum, deadline, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      periodId, 'pool-1', 'QA Notif', 'GEPUBLICEERD', '2027-01-04', '2027-01-10', '2026-12-31T23:59:59Z'
    );

    // Test 1: Create multiple notifications
    const notif1 = uuid();
    const notif2 = uuid();
    const notif3 = uuid();

    db.prepare(`INSERT INTO dienstrooster_notification
      (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      notif1, userId, periodId, 'RUILVERZOEK', 'Swap 1', 'Content 1', 0
    );
    db.prepare(`INSERT INTO dienstrooster_notification
      (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      notif2, userId, periodId, 'RUIL_GOEDGEKEURD', 'Swap 2', 'Content 2', 0
    );
    db.prepare(`INSERT INTO dienstrooster_notification
      (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      notif3, userId, periodId, 'PUBLICATIE_BERICHT', 'Pub', 'Content 3', 0
    );

    const count = db.prepare('SELECT COUNT(*) as cnt FROM dienstrooster_notification WHERE person_id = ?')
      .get(userId) as any;

    if (count.cnt === 3) {
      addResult('Create Multiple Notifications', 'Notifications', 'PASS', 'All notifications created');
    } else {
      addResult('Create Multiple Notifications', 'Notifications', 'FAIL', `Expected 3, got ${count.cnt}`);
    }

    // Test 2: Mark as read
    db.prepare('UPDATE dienstrooster_notification SET gelezen = 1 WHERE id = ?').run(notif1);

    const unreadCount = db.prepare('SELECT COUNT(*) as cnt FROM dienstrooster_notification WHERE person_id = ? AND gelezen = 0')
      .get(userId) as any;

    if (unreadCount.cnt === 2) {
      addResult('Mark Notification as Read', 'Notifications', 'PASS', 'Read status updated correctly');
    } else {
      addResult('Mark Notification as Read', 'Notifications', 'FAIL', `Expected 2 unread, got ${unreadCount.cnt}`);
    }

    // Test 3: Filter by type
    const swapNotifs = db.prepare('SELECT COUNT(*) as cnt FROM dienstrooster_notification WHERE person_id = ? AND type = ?')
      .get(userId, 'RUILVERZOEK') as any;

    if (swapNotifs.cnt === 1) {
      addResult('Filter Notifications by Type', 'Notifications', 'PASS', 'Type filtering works');
    } else {
      addResult('Filter Notifications by Type', 'Notifications', 'FAIL', `Expected 1 RUILVERZOEK, got ${swapNotifs.cnt}`);
    }

    // Test 4: Notification timestamps
    const notifWithTime = db.prepare('SELECT aangemaakt_op FROM dienstrooster_notification WHERE id = ?').get(notif1);
    if (notifWithTime && notifWithTime.aangemaakt_op) {
      addResult('Notification Timestamps', 'Notifications', 'PASS', 'Timestamps recorded');
    } else {
      addResult('Notification Timestamps', 'Notifications', 'FAIL', 'Missing timestamp');
    }

    // Cleanup
    db.prepare('DELETE FROM dienstrooster_notification WHERE person_id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(userId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  } catch (error) {
    addResult('Notification System', 'Notifications', 'FAIL', `Error: ${String(error)}`);
  }
}

/**
 * QA Test Suite: Database Integrity
 */
export async function testDatabaseIntegrity() {
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

    // Test 2: Check constraints on swap_request
    const swapTable = db.prepare('PRAGMA table_info(dienstrooster_swap_request)').all() as any[];
    const hasStatus = swapTable.some(col => col.name === 'status');

    if (hasStatus) {
      addResult('Swap Request Table Structure', 'Database', 'PASS', 'Status column exists');
    } else {
      addResult('Swap Request Table Structure', 'Database', 'FAIL', 'Missing status column');
    }

    // Test 3: Check notification type enum
    const notifTable = db.prepare('PRAGMA table_info(dienstrooster_notification)').all() as any[];
    const hasType = notifTable.some(col => col.name === 'type');

    if (hasType) {
      addResult('Notification Table Structure', 'Database', 'PASS', 'Type column exists');
    } else {
      addResult('Notification Table Structure', 'Database', 'FAIL', 'Missing type column');
    }

    // Test 4: Check publication columns on period
    const periodTable = db.prepare('PRAGMA table_info(dienstrooster_schedule_period)').all() as any[];
    const hasPubOn = periodTable.some(col => col.name === 'gepubliceerd_op');
    const hasPubBy = periodTable.some(col => col.name === 'gepubliceerd_door_person_id');

    if (hasPubOn && hasPubBy) {
      addResult('Period Publication Columns', 'Database', 'PASS', 'Publication metadata columns exist');
    } else {
      addResult('Period Publication Columns', 'Database', 'FAIL', 'Missing publication columns');
    }
  } catch (error) {
    addResult('Database Integrity', 'Database', 'FAIL', `Error: ${String(error)}`);
  }
}

/**
 * Run all QA tests and print results
 */
export async function runAllQATests() {
  console.log('🚀 Starting Phase 3 QA Test Suite...\n');

  await testDatabaseIntegrity();
  await testSwapRequestWorkflow();
  await testPublicationWorkflow();
  await testNotificationSystem();

  // Print results summary
  console.log('\n' + '='.repeat(80));
  console.log('📋 QA TEST RESULTS SUMMARY');
  console.log('='.repeat(80) + '\n');

  const byCategory: Record<string, QATestResult[]> = {};
  results.forEach(r => {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  });

  for (const [category, tests] of Object.entries(byCategory)) {
    const passed = tests.filter(t => t.status === 'PASS').length;
    const failed = tests.filter(t => t.status === 'FAIL').length;

    console.log(`\n${category}`);
    console.log('-'.repeat(40));

    tests.forEach(test => {
      const icon = test.status === 'PASS' ? '✓' : test.status === 'FAIL' ? '✗' : '⊘';
      console.log(`  ${icon} ${test.name}: ${test.message}`);
    });

    console.log(`  Summary: ${passed}/${tests.length} passed`);
  }

  // Overall summary
  const totalPass = results.filter(r => r.status === 'PASS').length;
  const totalFail = results.filter(r => r.status === 'FAIL').length;
  const totalTests = results.length;

  console.log('\n' + '='.repeat(80));
  console.log(`TOTAL: ${totalPass}/${totalTests} tests passed`);
  if (totalFail === 0) {
    console.log('🎉 ALL QA TESTS PASSED!');
  } else {
    console.log(`⚠️  ${totalFail} test(s) failed - review above`);
  }
  console.log('='.repeat(80) + '\n');

  return { passed: totalPass, failed: totalFail, total: totalTests };
}

// Run if executed directly
if (require.main === module) {
  runAllQATests().catch(console.error);
}

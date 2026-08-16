/**
 * Live carry-over check: publish period 1, let reality diverge from the
 * published plan, open period 2, and confirm the ledger picks up exactly
 * what the affected person is owed.
 *
 * Requires a freshly seeded DB, a running solver and a running server (see
 * scripts/full-check.mjs header). Run it on a fresh seed - it consumes the
 * seeded period, so it cannot be run twice, or after full-check.mjs,
 * without re-seeding first.
 *
 * Why the scenario looks like this: the publication gate refuses a roster
 * where anyone falls outside their range, and carry-over measures exactly
 * that distance. So a *published* roster owes nobody anything by
 * construction - carry-over exists to capture what happens to a roster
 * after it goes live: swaps, sick-calls, planner corrections. This script
 * therefore publishes a clean roster and then removes one shift the way a
 * planner would when someone calls in sick.
 *
 * windowWeeks is 1 here so the seeded 35-week period is fully coverable;
 * at 2 the solver can only fill 150 of 245 and the roster is correctly
 * unpublishable, which would test the gate rather than the ledger.
 */
import Database from 'better-sqlite3';

const BASE = 'http://localhost:3000';
const db = new Database('/home/user/rooster/rooster.db');

function ch(j) { return Object.entries(j).map(([k, v]) => `${k}=${v}`).join('; '); }
function grab(res, jar) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of sc) { const [p] = c.split(';'); const [k, v] = p.split('='); jar[k] = v; }
}
async function req(method, path, { jar, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers['Cookie'] = ch(jar);
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (jar) grab(res, jar);
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const RULESET = { windowWeeks: 1, distributionMode: 'EVEN' }; // no explicit bands -> derived from real slot counts

async function main() {
  const planner = {};
  await req('POST', '/api/auth/staff-login', { jar: planner, body: { codenaam: 'PLANNER', password: 'Planner@12345' } });

  const p1 = db.prepare('SELECT * FROM dienstrooster_schedule_period LIMIT 1').get();
  console.log('Period 1:', p1.id);

  await req('POST', `/api/periods/${p1.id}/prior-assignments/auto-derive`, { jar: planner });
  await req('PATCH', `/api/periods/${p1.id}/prior-assignments/confirm`, { jar: planner });
  const open1 = await req('POST', `/api/periods/${p1.id}/open`, {
    jar: planner,
    body: { naam: 'P1', start_datum: p1.start_datum, eind_datum: p1.eind_datum, deadline: p1.deadline, ruleset: RULESET },
  });
  console.log('open P1:', open1.status, 'carry_over_entries =', open1.json?.data?.carry_over_entries, '(expect 0, first period)');

  await req('POST', `/api/periods/${p1.id}/close`, { jar: planner });
  const gen = await req('POST', `/api/planner/period/${p1.id}/generate-roster`, { jar: planner });
  console.log('generate P1:', gen.status, gen.json?.data?.assignments_created, 'assigned,', gen.json?.data?.unfilled_slots?.length, 'gaps');

  const check = await req('GET', `/api/planner/period/${p1.id}/publication-check`, { jar: planner });
  const bands = check.json?.data?.bands;
  console.log('publication-check P1:', check.json?.data?.valid, 'bands', JSON.stringify(bands));

  const pub = await req('POST', `/api/planner/period/${p1.id}/publish`, { jar: planner });
  console.log('publish P1:', pub.status);

  // --- reality diverges from the published plan -------------------------
  // Find someone sitting exactly on the lower edge of the evening range,
  // so removing one shift puts them one short and nobody else moves.
  const [avondMin] = bands?.AVOND ?? [];
  const victim = db.prepare(
    `SELECT a.person_id, COUNT(*) n
     FROM dienstrooster_assignment a
     JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
     WHERE a.schedule_version_id = ? AND st.teller = 'AVOND'
     GROUP BY a.person_id HAVING n = ? LIMIT 1`
  ).get(p1.id, avondMin);

  if (!victim) {
    console.log(`\nFATAL: nobody sits on the evening lower edge (${avondMin}); cannot stage a shortfall`);
    process.exit(1);
  }

  const doomed = db.prepare(
    `SELECT a.id FROM dienstrooster_assignment a
     JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
     WHERE a.schedule_version_id = ? AND a.person_id = ? AND st.teller = 'AVOND' LIMIT 1`
  ).get(p1.id, victim.person_id);

  const del = await req('DELETE', `/api/planner/period/${p1.id}/assignments/${doomed.id}/delete`, {
    jar: planner,
    body: { reason: 'Called in sick' },
  });
  console.log('sick-call removal:', del.status, `(person now has ${victim.n - 1} of ${avondMin} evening shifts)`);

  // --- next period ------------------------------------------------------
  const p2 = await req('POST', '/api/planner/periods', {
    jar: planner,
    body: { naam: '2027-2', pool_id: p1.pool_id, start_datum: '2027-09-06', eind_datum: '2027-12-26', deadline: '2027-08-15T17:00:00Z' },
  });
  const p2Id = p2.json?.data?.id;
  console.log('create P2:', p2.status, p2Id);

  const open2 = await req('POST', `/api/periods/${p2Id}/open`, {
    jar: planner,
    body: { naam: 'P2', start_datum: '2027-09-06', eind_datum: '2027-12-26', deadline: '2027-08-15T17:00:00Z', ruleset: RULESET },
  });
  console.log('open P2:', open2.status, 'carry_over_entries =', open2.json?.data?.carry_over_entries);

  const rows = db.prepare(
    `SELECT p.codenaam, l.person_id, l.teller, l.delta, l.reden
     FROM dienstrooster_ledger_entry l
     JOIN dienstrooster_person p ON p.id = l.person_id
     WHERE l.geldt_voor_periode_id = ? AND l.categorie = 'CARRY_OVER'
     ORDER BY l.delta DESC`
  ).all(p2Id);

  console.log('\nCARRY_OVER rows booked against P2:');
  for (const r of rows) console.log(`  ${r.codenaam} ${r.teller}: ${r.delta > 0 ? '+' : ''}${r.delta} — ${r.reden}`);

  const onOldPeriod = db.prepare(
    `SELECT COUNT(*) c FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ? AND categorie='CARRY_OVER'`
  ).get(p1.id).c;
  console.log(`\nCARRY_OVER wrongly booked against P1: ${onOldPeriod} (must be 0)`);

  const victimRow = rows.find((r) => r.person_id === victim.person_id && r.teller === 'AVOND');

  const checks = [
    ['first period carries nothing', open1.json?.data?.carry_over_entries === 0],
    ['a fully covered, in-band roster is publishable', gen.json?.data?.fully_covered === true && pub.status === 200],
    ['the shift removed after publication is carried forward as +1', victimRow?.delta === 1],
    ['nobody else is charged for it', rows.length === 1],
    ['carry-over booked against the new period only', onOldPeriod === 0],
  ];

  console.log('');
  for (const [name, pass] of checks) console.log(`${pass ? '✓' : '✗'} ${name}`);

  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? '\n=== CARRY-OVER WORKS END-TO-END ===' : '\n*** FAIL ***');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

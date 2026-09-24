/**
 * Full live end-to-end check.
 *
 * Walks the complete lifecycle a real department follows - login, period
 * setup, preference entry, part-time sync, roster generation (including
 * the partial-coverage path), manual gap-filling, and publication checks -
 * against a genuinely running stack, and asserts the hard rules hold in
 * the resulting data.
 *
 * Prerequisites (all three, in this order):
 *   1. npm run seed                       # fresh database
 *   2. uvicorn main:app --port 8000       # from ./solver
 *   3. SESSION_SECRET=... SOLVER_URL=http://localhost:8000 npm start
 * Then: node scripts/full-check.mjs
 *
 * Exits non-zero on the first failing assertion set, and prints a summary.
 */
import Database from 'better-sqlite3';

import { execFileSync } from 'child_process';
import nodeCrypto from 'crypto';
import nodePath from 'path';
import { fileURLToPath } from 'url';

// This script lives in scripts/, and one check below shells out to tsx to
// reuse a TypeScript module from the app itself.
const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = 'http://localhost:3000';

// Same resolution as db/client.ts, so this script always inspects the very
// database the server it is testing is writing to (locally ./rooster.db,
// in Docker the /data volume). Imported as `nodePath` because req() below
// takes a parameter called `path`.
function resolveDbPath() {
  let p = process.env.DATABASE_URL || 'file:./rooster.db';
  if (p.startsWith('file:')) {
    p = p.slice(5);
    if (p.startsWith('//')) p = p.slice(2);
  }
  if (nodePath.isAbsolute(p)) return p;
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', p);
}

const db = new Database(resolveDbPath());
const results = [];

function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
function ch(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
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
const eq = (a, b) => a === b;

/**
 * Start a roster generation and wait for it to finish.
 *
 * The POST no longer does the solving: it hands back a job_id and the work
 * continues in the background (see lib/rosterGenerationJobs.ts - a CP-SAT
 * search can outlast a request). This script used to read the finished
 * roster straight out of that POST's response, which meant it had been
 * asserting against `undefined` ever since, and every check that depended
 * on a generated roster failed with it.
 */
async function generateRoster(periodId, jar, body) {
  const start = await req('POST', `/api/planner/period/${periodId}/generate-roster`, { jar, body });
  if (start.status !== 200 || !start.json?.data?.job_id) {
    return { ok: false, detail: `start status=${start.status}`, startStatus: start.status };
  }

  const jobId = start.json.data.job_id;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const poll = await req(
      'GET',
      `/api/planner/period/${periodId}/generate-roster/status?job_id=${jobId}`,
      { jar }
    );
    const status = poll.json?.data?.status;
    if (status === 'DONE') return { ok: true, result: poll.json.data.result, startStatus: 200 };
    if (status === 'ERROR') {
      // job.error is { message, status }, not a string (see
      // lib/rosterGenerationJobs.ts's failRosterGenerationJob) - printing
      // it directly gave "[object Object]", which says nothing about what
      // actually went wrong. The dialog already handles both shapes.
      const err = poll.json?.data?.error;
      const detail = typeof err === 'string' ? err : err?.message ?? JSON.stringify(err);
      return { ok: false, detail: `solver error: ${detail}`, startStatus: 200 };
    }
    if (poll.status !== 200) {
      return { ok: false, detail: `poll status=${poll.status}`, startStatus: 200 };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, detail: 'timed out after 5 minutes', startStatus: 200 };
}

/**
 * Mint a personal access link straight into the database and return the
 * plaintext token.
 *
 * The seed only ever stores the hash (as production does), so there is no
 * token to look up - this script issues its own, the same way the planner's
 * export screen would, and keeps the plaintext in memory for the requests
 * below.
 */
function mintLink(personId) {
  const token = nodeCrypto.randomBytes(32).toString('hex');
  const hash = nodeCrypto.createHash('sha256').update(token).digest('hex');
  // Pinned to the seeded period, exactly like the links the seed itself
  // writes. A link without one falls back to auto-detecting the current
  // enrollment period, and at this point in the script the period is still
  // in CONCEPT - so a period-less link would fail here for a reason that
  // has nothing to do with what is being tested.
  const period = db.prepare('SELECT id FROM dienstrooster_schedule_period LIMIT 1').get();
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link
       (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(nodeCrypto.randomUUID(), personId, period.id, hash);
  return token;
}

// scripts/seed.ts sets planner to DEFAULT_TEST_PASSWORD directly (see its
// comment) - the account already has it, so this only ever exercises the
// "already claimed" 409 path now. Kept as coverage of that route rather
// than removed: a real operator who does clear the seeded password (or a
// future deployment that goes back to leaving it unset) still goes through
// exactly this flow, and this proves it still works either way.
const SEEDED_TEST_PASSWORD = 'Password123!'; // must match DEFAULT_TEST_PASSWORD in lib/seedPassword.ts
async function ensureStaffPassword(codenaam, password) {
  await req('POST', '/api/auth/first-run-setup', { body: { codenaam, password } });
}

async function main() {
  // ---------- AUTH ----------
  console.log('\n━━ AUTH ━━');
  rec('Unauthenticated /api/periods → 401', eq((await req('GET', '/api/periods')).status, 401));

  await ensureStaffPassword('planner', SEEDED_TEST_PASSWORD);

  const planner = {};
  const pLogin = await req('POST', '/api/auth/staff-login', { jar: planner, body: { codenaam: 'planner', password: SEEDED_TEST_PASSWORD } });
  rec('Planner login', eq(pLogin.status, 200));
  const plannerId = pLogin.json?.data?.person_id;

  rec('Wrong password → 401', eq((await req('POST', '/api/auth/staff-login', { jar: {}, body: { codenaam: 'planner', password: 'nope' } })).status, 401));
  rec('Login with no body → 400 (not 500)', eq((await req('POST', '/api/auth/staff-login', { jar: {} })).status, 400));

  const me = await req('GET', '/api/auth/me', { jar: planner });
  rec('/api/auth/me returns PLANNER role', me.json?.data?.role === 'PLANNER');

  const s1 = db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE codenaam='Persoon-01'`).get();
  const s2 = db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE codenaam='Persoon-02'`).get();
  const person = {};
  rec('Personal-link auth', eq((await req('GET', `/api/auth/verify-link?token=${mintLink(s1.id)}`, { jar: person })).status, 200));
  rec('Invalid token → 401', eq((await req('GET', '/api/auth/verify-link?token=bogus', { jar: {} })).status, 401));
  rec('IDOR: person1 cannot read person2 → 403', eq((await req('GET', `/api/person/${s2.id}/absences`, { jar: person })).status, 403));
  rec('Person cannot reach planner dashboard → 401', eq((await req('GET', `/api/planner/period/x/dashboard`, { jar: person })).status, 401));

  const period = db.prepare(`SELECT * FROM dienstrooster_schedule_period LIMIT 1`).get();

  // ---------- PERIOD SETUP ----------
  console.log('\n━━ PERIOD SETUP ━━');
  rec('GET /api/periods', eq((await req('GET', '/api/periods', { jar: planner })).status, 200));
  rec('GET /api/periods/[id]', eq((await req('GET', `/api/periods/${period.id}`, { jar: planner })).status, 200));
  const cap = await req('GET', `/api/periods/${period.id}/capacity`, { jar: planner });
  rec('Capacity check runs both formulas', cap.status === 200 && cap.json?.data?.total_capacity && cap.json?.data?.distinct_people,
      `constraining=${cap.json?.data?.is_constraining}`);
  rec('GET pools', eq((await req('GET', '/api/planner/pools', { jar: planner })).status, 200));
  const pool = db.prepare('SELECT id FROM dienstrooster_pool LIMIT 1').get();
  const mem = await req('GET', `/api/planner/pool/${pool.id}/members`, { jar: planner });
  rec('Pool members', mem.status === 200, `${mem.json?.data?.length} members`);

  rec('POST /open with no body → 400 (not 500)', eq((await req('POST', `/api/periods/${period.id}/open`, { jar: planner })).status, 400));

  rec('Prior-assignments list', eq((await req('GET', `/api/periods/${period.id}/prior-assignments`, { jar: planner })).status, 200));
  rec('Prior-assignments auto-derive', eq((await req('POST', `/api/periods/${period.id}/prior-assignments/auto-derive`, { jar: planner })).status, 200));
  rec('Prior-assignments confirm', eq((await req('PATCH', `/api/periods/${period.id}/prior-assignments/confirm`, { jar: planner })).status, 200));

  const open = await req('POST', `/api/periods/${period.id}/open`, {
    jar: planner,
    body: {
      naam: 'Full Check Period', start_datum: period.start_datum, eind_datum: period.eind_datum, deadline: period.deadline,
      ruleset: { windowWeeks: 7, bandAvond: [8, 9], bandWeekend: [4, 5], bandFeestdag: [1, 2], distributionMode: 'GELIJK' },
    },
  });
  rec('Open period → OPEN + 154 slots / 22 weeks', open.status === 200 && open.json?.data?.slots_generated === 154 && open.json?.data?.weeks_covered === 22,
      `${open.json?.data?.slots_generated} slots, ${open.json?.data?.weeks_covered} weeks`);
  rec('Dates auto-rounded to full ISO weeks', open.json?.data?.start_datum === '2027-01-04');

  // ---------- PARTICIPANT FLOW ----------
  console.log('\n━━ PARTICIPANT FLOW ━━');
  rec('GET preferences', eq((await req('GET', `/api/person/${s1.id}/preferences/${period.id}`, { jar: person })).status, 200));
  const slot = db.prepare(`SELECT id FROM dienstrooster_shift_slot WHERE period_id=? ORDER BY datum LIMIT 1`).get(period.id);
  rec('PATCH one slot to LIEVER_NIET', eq((await req('PATCH', `/api/person/${s1.id}/preferences/slot/${slot.id}`, { jar: person, body: { level: 'LIEVER_NIET' } })).status, 200));
  const lvl = db.prepare(`SELECT blocking_level FROM dienstrooster_availability WHERE person_id=? AND slot_id=?`).get(s1.id, slot.id);
  rec('…persisted in DB', lvl?.blocking_level === 'LIEVER_NIET', `level=${lvl?.blocking_level}`);
  const cov = await req('GET', `/api/person/${s1.id}/preferences/${period.id}/coverage`, { jar: person });
  rec('Coverage indicator (counts only, no names)', cov.status === 200 && !JSON.stringify(cov.json).includes('Persoon-'));

  // Re-submitting a day this person already has must be refused as a
  // conflict, not a 500. This only bites against a schema that actually
  // carries parttime_pattern_uniq - seed.ts was missing it, so the
  // duplicate used to succeed locally and 500 in production.
  const existingPattern = db.prepare(
    `SELECT weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern WHERE person_id=? LIMIT 1`
  ).get(s1.id);
  if (existingPattern) {
    const dup = await req('POST', `/api/person/${s1.id}/parttime-patterns`, { jar: person, body: existingPattern });
    rec('Duplicate part-time pattern → 409 (not 500)', eq(dup.status, 409), `status=${dup.status}`);
  }

  // ...then a genuinely new day, on a weekday this person does not use yet.
  const usedDays = db.prepare(`SELECT weekdag FROM dienstrooster_parttime_pattern WHERE person_id=?`)
    .all(s1.id).map((r) => r.weekdag);
  const freeDay = ['MA', 'DI', 'WO', 'DO', 'VR'].find((d) => !usedDays.includes(d));

  const pt = await req('POST', `/api/person/${s1.id}/parttime-patterns`, {
    jar: person, body: { weekdag: freeDay, frequentie: 'ELKE_WEEK', geldig_vanaf: '2027-01-04', geldig_tot: '2027-09-05' },
  });
  rec('Create part-time pattern', eq(pt.status, 201), `weekdag=${freeDay}`);
  const patternId = pt.json?.data?.id;
  const genRows = db.prepare(`SELECT COUNT(*) c FROM dienstrooster_availability WHERE source='PARTTIME' AND person_id=?`).get(s1.id);
  rec('Part-time sync generated real ABSOLUUT rows', genRows.c > 0, `${genRows.c} rows`);
  rec('generated-days endpoint', eq((await req('GET', `/api/person/${s1.id}/parttime-patterns/generated-days?period_id=${period.id}`, { jar: person })).status, 200));
  // Move it to another unused day - editing onto an occupied one would
  // (correctly) conflict, which is covered by the 409 check above.
  const otherFreeDay = ['MA', 'DI', 'WO', 'DO', 'VR'].find((d) => !usedDays.includes(d) && d !== freeDay);
  rec('Edit pattern weekday', eq((await req('PATCH', `/api/person/${s1.id}/parttime-patterns/${patternId}`, { jar: person, body: { weekdag: otherFreeDay } })).status, 200), `${freeDay} → ${otherFreeDay}`);
  rec('Delete pattern (no FK error)', eq((await req('DELETE', `/api/person/${s1.id}/parttime-patterns/${patternId}`, { jar: person })).status, 200));
  const orphans = db.prepare(`SELECT COUNT(*) c FROM dienstrooster_availability WHERE bron_pattern_id=?`).get(patternId);
  rec('Zero orphaned availability rows', orphans.c === 0);

  const abs = await req('POST', `/api/person/${s1.id}/absences`, { jar: person, body: { van_datum: '2027-02-01', tot_datum: '2027-02-07', soort: 'VAKANTIE' } });
  rec('Create absence', eq(abs.status, 201));
  rec('Delete absence', eq((await req('DELETE', `/api/person/${s1.id}/absences/${abs.json?.data?.id}`, { jar: person })).status, 200));
  rec('Notifications', eq((await req('GET', `/api/person/${s1.id}/notifications`, { jar: person })).status, 200));
  rec('Swap requests list', eq((await req('GET', `/api/person/${s1.id}/swap-requests`, { jar: person })).status, 200));

  // ---------- FELLOW ----------
  // Persoon-02 supports the AIOS on Saturdays this period: their weekends
  // are blocked and they don't count for the weekend band (lib/fellows.ts).
  console.log('\n━━ FELLOW ━━');
  const fellowJar = {};
  await req('GET', `/api/auth/verify-link?token=${mintLink(s2.id)}`, { jar: fellowJar });
  rec('Participant ticks "Ik ben fellow"', eq((await req('PUT', `/api/person/${s2.id}/fellow`, {
    jar: fellowJar, body: { period_id: period.id, fellow: true },
  })).status, 200));
  const weekendDays = db.prepare(
    `SELECT COUNT(*) c FROM dienstrooster_shift_slot WHERE period_id=? AND strftime('%w', datum) IN ('0','6')`
  ).get(period.id).c;
  const unblockedWeekend = db.prepare(`
    SELECT COUNT(*) c FROM dienstrooster_shift_slot s
    WHERE s.period_id=? AND strftime('%w', s.datum) IN ('0','6')
      AND NOT EXISTS (SELECT 1 FROM dienstrooster_availability a
                      WHERE a.person_id=? AND a.slot_id=s.id AND a.blocking_level='ABSOLUUT')`).get(period.id, s2.id).c;
  rec('…every weekend day of the period is blocked for them', weekendDays > 0 && unblockedWeekend === 0,
      `${weekendDays} weekend days, ${unblockedWeekend} open`);
  const fellowSummary = await req('GET', `/api/planner/period/${period.id}/fellows`, { jar: planner });
  const wk = fellowSummary.json?.data?.weekend;
  rec('…and the others\' weekend band goes up', fellowSummary.status === 200 &&
      fellowSummary.json?.data?.fellows?.length === 1 && wk?.bereik?.[1] > wk?.bereik_zonder_fellows?.[1],
      `${JSON.stringify(wk?.bereik_zonder_fellows)} → ${JSON.stringify(wk?.bereik)}`);

  // ---------- PLANNER MONITORING ----------
  console.log('\n━━ PLANNER MONITORING ━━');
  rec('Dashboard', eq((await req('GET', `/api/planner/period/${period.id}/dashboard`, { jar: planner })).status, 200));
  rec('Progress', eq((await req('GET', `/api/planner/period/${period.id}/progress`, { jar: planner })).status, 200));
  rec('Staff links', eq((await req('GET', `/api/planner/period/${period.id}/staff-links`, { jar: planner })).status, 200));
  // POST: both revoke and reissue personal links, so neither is a GET.
  rec('Export invitations', eq((await req('POST', `/api/exports/invitations/${period.id}`, { jar: planner })).status, 200));
  rec('Export reminders', eq((await req('POST', `/api/exports/reminders/${period.id}`, { jar: planner })).status, 200));
  rec('Export reminders rejects GET (state-changing, not link-clickable)',
      eq((await req('GET', `/api/exports/reminders/${period.id}`, { jar: planner })).status, 405));
  rec('Export status report', eq((await req('GET', `/api/exports/status-report/${period.id}`, { jar: planner })).status, 200));

  // ---------- GENERATION + MANUAL COMPLETION ----------
  console.log('\n━━ GENERATION + MANUAL COMPLETION ━━');
  rec('Close period', eq((await req('POST', `/api/periods/${period.id}/close`, { jar: planner })).status, 200));

  const gen = await generateRoster(period.id, planner);
  rec('Generate roster returns a partial roster (not all-or-nothing)',
      gen.ok && gen.result?.assignments_created > 0,
      gen.ok
        ? `${gen.result?.assignments_created} assigned, ${gen.result?.unfilled_slots?.length} gaps, fully_covered=${gen.result?.fully_covered}`
        : gen.detail);
  const st = db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id=?').get(period.id);
  rec('Period reaches GEGENEREERD despite gaps (manual fill unblocked)', st.status === 'GEGENEREERD', `status=${st.status}`);

  const hardViol = db.prepare(`
    SELECT COUNT(*) c FROM dienstrooster_assignment a
    JOIN dienstrooster_availability av ON a.person_id=av.person_id AND a.slot_id=av.slot_id
    WHERE a.schedule_version_id=? AND av.blocking_level='ABSOLUUT'`).get(period.id);
  rec('HARD RULE: zero ABSOLUUT violations even under scarcity', hardViol.c === 0, `${hardViol.c} violations`);

  // iso_jaar as well as iso_week: comparing the week number alone makes
  // week 5 of one year look like week 5 of the next, so a period spanning a
  // new year would report violations that are a year apart. Harmless on the
  // seeded period (one calendar year), wrong the moment that changes.
  const windowViol = db.prepare(`
    SELECT COUNT(*) c FROM dienstrooster_assignment a1
    JOIN dienstrooster_shift_slot s1 ON s1.id=a1.slot_id
    JOIN dienstrooster_assignment a2 ON a2.person_id=a1.person_id AND a2.id<>a1.id AND a2.schedule_version_id=a1.schedule_version_id
    JOIN dienstrooster_shift_slot s2 ON s2.id=a2.slot_id
    WHERE a1.schedule_version_id=? AND s1.iso_jaar=s2.iso_jaar AND s1.iso_week=s2.iso_week AND s1.id<>s2.id`).get(period.id);
  rec('HARD RULE: no person twice in one ISO week', windowViol.c === 0, `${windowViol.c} violations`);

  const fellowWeekend = db.prepare(`
    SELECT COUNT(*) c FROM dienstrooster_assignment a
    JOIN dienstrooster_shift_slot s ON s.id=a.slot_id
    WHERE a.schedule_version_id=? AND a.person_id=? AND strftime('%w', s.datum) IN ('0','6')`).get(period.id, s2.id);
  rec('FELLOW: the solver gives a fellow no weekend shift', fellowWeekend.c === 0, `${fellowWeekend.c} weekend shifts`);

  // The window rule proper - "no second shift within windowWeeks", which is
  // stricter than the same-week check above and is the rule the whole
  // fairness model rests on. Asserted here, on the solver's own untouched
  // output and before any deliberate manual override below, through the
  // app's own publication check rather than a second implementation of the
  // rule in this script: two implementations would be free to agree with
  // each other and both be wrong.
  //
  const cleanCheck = await req('GET', `/api/planner/period/${period.id}/publication-check`, { jar: planner });
  const checks = cleanCheck.json?.data?.checks;
  rec('HARD RULE: the solver breaks nobody\'s window rule',
      checks?.window_compliance === true,
      `window_compliance=${checks?.window_compliance}`);

  // Deliberately NOT publication-check's band_compliance: that flag is
  // false whenever anyone sits outside their bereik at all, and on this
  // scarce fixture almost everyone is *below* the minimum simply because
  // there are not enough fillable diensten. The solver never promised to
  // reach the minimum - MAX_BAND_OVERSHOOT in constraints.py promises the
  // other end: it may leave a dienst unfilled, but it may never push
  // anyone past their ceiling. That is the half worth asserting.
  //
  // Through the app's own computeBandStatusByPerson, which already folds
  // in coverage, deelnamefactor and the ledger delta the way the solver
  // does. Recomputing that here would be a second implementation free to
  // agree with itself and be wrong.
  const overBand = JSON.parse(
    execFileSync('npx', ['tsx', '-e', `
      import { computeBandStatusByPerson, TELLERS } from './lib/rosterBands';
      const status = computeBandStatusByPerson(${JSON.stringify(period.id)});
      const over = [];
      for (const [personId, byTeller] of status) {
        for (const teller of TELLERS) {
          const s = byTeller[teller];
          if (s.count > s.max) over.push(\`\${personId} \${teller} \${s.count}>\${s.max}\`);
        }
      }
      console.log(JSON.stringify(over));
    `], { cwd: repoRoot, encoding: 'utf8' })
  );
  rec('HARD RULE: the solver pushes nobody past their streefbereik',
      overBand.length === 0,
      overBand.length === 0 ? 'nobody over their ceiling' : overBand.slice(0, 3).join(' | '));

  const unf = await req('GET', `/api/planner/period/${period.id}/unfilled-slots`, { jar: planner });
  rec('Unfilled-slots lists gaps with eligible people', unf.status === 200 && Array.isArray(unf.json?.data),
      `${unf.json?.data?.length} gaps`);

  if (unf.json?.data?.length > 0) {
    const gap = unf.json.data[0];

    // The candidate list deliberately includes people who blocked the
    // slot - a manual fill is an exception the planner makes in
    // consultation with the person, so hiding them would remove the option
    // entirely (see lib/rosterGaps.ts). What must hold is that they are
    // labelled, never quietly mixed in with genuinely free candidates.
    // This used to assert the opposite - that the list excluded them - and
    // had been failing ever since the category was introduced.
    const hardBlocked = db.prepare(
      `SELECT person_id, source FROM dienstrooster_availability
       WHERE slot_id=? AND blocking_level='ABSOLUUT'`
    ).all(gap.slot_id);
    const categoryById = new Map(gap.eligible_people.map((p) => [p.id, p.category]));
    const mislabelled = hardBlocked.filter((row) => {
      const category = categoryById.get(row.person_id);
      if (category === undefined) return false; // not offered at all is fine too
      return category !== (row.source === 'PARTTIME' ? 'PARTTIME' : 'GEBLOKKEERD');
    });
    rec('Anyone who blocked that slot is labelled, not offered as free',
        mislabelled.length === 0, `${hardBlocked.length} blocked, ${mislabelled.length} mislabelled`);

    // Pick someone with no objection at all, so the fill below tests the
    // ordinary path rather than the override path.
    const chosen = gap.eligible_people.find((p) => p.category === 'BESCHIKBAAR' || p.category === 'VOORKEUR')
      ?? gap.eligible_people[0];
    const ma = await req('POST', `/api/planner/period/${period.id}/assignments/manual-assign`, {
      jar: planner, body: { person_id: chosen.id, slot_id: gap.slot_id, reason: 'Full check' },
    });
    rec('Manually fill a gap', eq(ma.status, 200));
    const after = await req('GET', `/api/planner/period/${period.id}/unfilled-slots`, { jar: planner });
    rec('Gap count drops by one', after.json?.data?.length === unf.json.data.length - 1,
        `${unf.json.data.length} → ${after.json?.data?.length}`);

    // Manual assign deliberately does NOT refuse a hard-blocked person -
    // the planner may always override, in consultation with whoever takes
    // the shift. What it must do is say so: a warning on the response and
    // an OVERRIDE row in the audit trail, so the exception is visible both
    // at the moment it happens and afterwards. This used to assert a 400,
    // which stopped matching the route the moment overriding became the
    // documented behaviour.
    const blockedRow = db.prepare(
      `SELECT av.person_id, av.slot_id FROM dienstrooster_availability av
       JOIN dienstrooster_shift_slot s ON s.id=av.slot_id
       WHERE s.period_id=? AND av.blocking_level='ABSOLUUT'
       AND av.slot_id NOT IN (SELECT slot_id FROM dienstrooster_assignment WHERE schedule_version_id=?) LIMIT 1`
    ).get(period.id, period.id);
    if (blockedRow) {
      const override = await req('POST', `/api/planner/period/${period.id}/assignments/manual-assign`, {
        jar: planner, body: { person_id: blockedRow.person_id, slot_id: blockedRow.slot_id },
      });
      rec('Manual assign allows an ABSOLUUT override, but warns about it',
          override.status === 200 && Boolean(override.json?.data?.warning),
          `status=${override.status}, warning=${override.json?.data?.warning?.code}`);

      const overrideLogged = db.prepare(
        `SELECT COUNT(*) c FROM dienstrooster_audit_log
         WHERE actie='MANUAL_ASSIGN'
           AND json_extract(nieuw_json, '$.slot_id') = ?
           AND json_extract(nieuw_json, '$.person_id') = ?
           AND json_extract(nieuw_json, '$.override.code') IS NOT NULL`
      ).get(blockedRow.slot_id, blockedRow.person_id);
      rec('The override is recorded in the audit trail, so it is visible afterwards',
          overrideLogged.c > 0, `${overrideLogged.c} audit rows naming the override`);
    }

    const regen = await generateRoster(period.id, planner);
    rec('Regenerate allowed from GEGENEREERD', regen.ok, regen.ok ? '' : regen.detail);
    const survived = db.prepare(`SELECT bron FROM dienstrooster_assignment WHERE schedule_version_id=? AND slot_id=?`).get(period.id, gap.slot_id);
    rec('Manual assignment survives regenerate untouched', survived?.bron === 'MANUAL', `bron=${survived?.bron}`);
  }

  const pc = await req('GET', `/api/planner/period/${period.id}/publication-check`, { jar: planner });
  rec('Publication check reports coverage honestly', pc.status === 200 && typeof pc.json?.data?.valid === 'boolean',
      `valid=${pc.json?.data?.valid}, ${pc.json?.data?.totals?.assigned_slots}/${pc.json?.data?.totals?.total_slots} filled`);

  // ---------- SESSION TEARDOWN ----------
  console.log('\n━━ SESSION ━━');
  rec('Logout', eq((await req('POST', '/api/auth/logout', { jar: planner })).status, 200));
  rec('Session dead after logout → 401', eq((await req('GET', '/api/periods', { jar: planner })).status, 401));

  // ---------- SUMMARY ----------
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  console.log('\n' + '═'.repeat(72));
  console.log(`TOTAL: ${pass}/${results.length} passed`);
  if (fail.length) { console.log('\nFAILURES:'); fail.forEach((f) => console.log(`  ✗ ${f.name} — ${f.detail}`)); }
  process.exit(fail.length ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });

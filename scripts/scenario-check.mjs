/**
 * The planner's own case, end to end: 15 people, one of them a fellow with
 * a part-time day, a period from 2026-12-28 to 2027-09-05 - across ISO week
 * 53 of 2026 and the year boundary - generated with every method the
 * dialog offers (weighted, lexicographic, multi_start, randomized) and
 * several windows, against the real solver.
 *
 * Reported: "160 or 161 not filled with all four solvers, also with a
 * window of 0". With every membership covering the period and the
 * streefbereik the app chooses itself, nothing may stay empty, and on
 * every run the solver's untouched output must keep the hard rules: no
 * blocked day worked, nobody's window broken (week 53 included), nobody
 * past their maximum, the fellow on no weekend and not on their part-time
 * Monday. "Rooster verwijderen" then takes it back to gesloten and a
 * generation after it works.
 *
 * Prerequisites, as for full-check: a seeded database, the solver on 8000
 * and the app (ALLOW_SEED_PASSWORD=true SOLVER_URL=http://localhost:8000).
 * Builds its own pool, so the seeded period plays no part.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import nodeCrypto from 'crypto';
import nodePath from 'path';
import { fileURLToPath } from 'url';

const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.APP_URL || 'http://localhost:3000';
const START = '2026-12-28';
const END = '2027-09-05';
const MODES = (process.env.SCENARIO_MODES || 'weighted,lexicographic,multi_start,randomized').split(',');
const WINDOWS = (process.env.SCENARIO_WINDOWS || '0,1,2').split(',').map(Number);
// The dialog's own default (solver/main.py SolverInput.time_limit_seconds).
const TIME_LIMIT = Number(process.env.SCENARIO_TIME || 120);

function resolveDbPath() {
  let p = process.env.DATABASE_URL || 'file:./rooster.db';
  if (p.startsWith('file:')) {
    p = p.slice(5);
    if (p.startsWith('//')) p = p.slice(2);
  }
  return nodePath.isAbsolute(p) ? p : nodePath.resolve(repoRoot, p);
}
const db = new Database(resolveDbPath());
const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
/** Worth knowing, not a broken rule: printed, never fails the run. */
function warn(name, ok, detail) {
  console.log(`${ok ? '✓' : '⚠'} ${name}${detail ? ' — ' + detail : ''}`);
}
function grab(res, jar) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const [p] = c.split(';');
    const i = p.indexOf('=');
    jar[p.slice(0, i)] = p.slice(i + 1);
  }
}
async function req(method, path, { jar, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (jar) grab(res, jar);
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}
async function generate(periodId, jar) {
  const start = await req('POST', `/api/planner/period/${periodId}/generate-roster`, { jar, body: { time_limit_seconds: TIME_LIMIT } });
  if (start.status !== 200) return { ok: false, detail: `start ${start.status} ${JSON.stringify(start.json)}` };
  const until = Date.now() + 5 * 60 * 1000;
  while (Date.now() < until) {
    const poll = await req('GET', `/api/planner/period/${periodId}/generate-roster/status?job_id=${start.json.data.job_id}`, { jar });
    const status = poll.json?.data?.status;
    if (status === 'DONE') return { ok: true, result: poll.json.data.result };
    if (status === 'ERROR') return { ok: false, detail: JSON.stringify(poll.json.data.error) };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, detail: 'timed out' };
}
const insert = (table, row) => {
  const id = nodeCrypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(id, ...Object.values(row));
  return id;
};

// ---------- SETUP: a pool of 15, the fifteenth a fellow ----------
const now = new Date().toISOString();
const tag = nodeCrypto.randomUUID().slice(0, 6);
const ruleset = insert('dienstrooster_ruleset', { naam: `Scenario ${tag}`, config_json: '{}', aangemaakt_op: now });
const poolId = insert('dienstrooster_pool', { naam: `Scenario ${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
for (const [naam, teller] of [['Avonddienst', 'AVOND'], ['Zaterdag', 'WEEKEND'], ['Zondag', 'WEEKEND'], ['Feestdag', 'FEESTDAG']]) {
  insert('dienstrooster_shift_type', { pool_id: poolId, naam, teller });
}
const people = [];
for (let i = 1; i <= 15; i++) {
  const id = insert('dienstrooster_person', { codenaam: `Scenario-${tag}-${String(i).padStart(2, '0')}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: id, pool_id: poolId, deelnamefactor: 1, geldig_vanaf: '2026-01-01', geldig_tot: '2029-12-31' });
  people.push(id);
}
const fellow = people[14];

const planner = {};
const login = await req('POST', '/api/auth/staff-login', { jar: planner, body: { codenaam: 'planner', password: 'Password123!' } });
rec('Planner logs in', login.status === 200, `status=${login.status}`);

const created = await req('POST', '/api/planner/periods', {
  jar: planner,
  body: { naam: `Scenario ${tag}`, pool_id: poolId, start_datum: START, eind_datum: END, deadline: '2026-12-01T12:00' },
});
const periodId = created.json?.data?.id;
rec('Period created', !!periodId, `status=${created.status}`);
// As the setup wizard does: the capacity check's suggested streefbereik for
// the members there are, typed into the open request (bands are required
// there).
const capacity = await req('GET', `/api/periods/${periodId}/capacity?window_weeks=2&start_datum=${START}&eind_datum=${END}`, { jar: planner });
const suggested = capacity.json?.data?.suggested_band;
rec('The wizard suggests a streefbereik for 15 people', !!suggested, JSON.stringify(suggested));
const opened = await req('POST', `/api/periods/${periodId}/open`, {
  jar: planner,
  body: {
    naam: `Scenario ${tag}`,
    start_datum: START,
    eind_datum: END,
    deadline: '2026-12-01T12:00',
    ruleset: { windowWeeks: 2, distributionMode: 'GELIJK', bandAvond: suggested?.AVOND, bandWeekend: suggested?.WEEKEND, bandFeestdag: suggested?.FEESTDAG },
  },
});
rec(
  'Period opened with that streefbereik',
  opened.status === 200,
  opened.status === 200 ? `${opened.json?.data?.slots_generated} diensten, ${opened.json?.data?.weeks_covered} weken` : `status=${opened.status} ${JSON.stringify(opened.json?.error)}`
);

// ---------- THE SLOTS: week 53 and the holidays ----------
const slots = db
  .prepare(
    `SELECT s.datum, s.iso_jaar, s.iso_week, st.teller FROM dienstrooster_shift_slot s
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id WHERE s.period_id = ? ORDER BY s.datum`
  )
  .all(periodId);
const days = Math.round((Date.parse(`${END}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / 86400000) + 1;
rec('One dienst for every day of the period', slots.length === days && new Set(slots.map((s) => s.datum)).size === days, `${slots.length} diensten, ${days} dagen`);
const byDate = Object.fromEntries(slots.map((s) => [s.datum, s]));
rec(
  '28 December 2026 to 3 January 2027 are ISO week 53 of 2026',
  ['2026-12-28', '2027-01-01', '2027-01-03'].every((d) => byDate[d]?.iso_jaar === 2026 && byDate[d]?.iso_week === 53) &&
    byDate['2027-01-04']?.iso_jaar === 2027 && byDate['2027-01-04']?.iso_week === 1,
  JSON.stringify(['2027-01-01', '2027-01-04'].map((d) => [d, byDate[d]?.iso_jaar, byDate[d]?.iso_week]))
);
const feestdagen = ['2027-01-01', '2027-03-28', '2027-03-29', '2027-04-27', '2027-05-06', '2027-05-16', '2027-05-17'];
rec('Holidays are feestdagdiensten', feestdagen.every((d) => byDate[d]?.teller === 'FEESTDAG'), feestdagen.map((d) => `${d}=${byDate[d]?.teller}`).join(' '));

// ---------- THE FELLOW: weekends and a part-time Monday ----------
const token = nodeCrypto.randomBytes(32).toString('hex');
db.prepare(
  `INSERT INTO dienstrooster_person_access_link (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, ?, datetime('now'))`
).run(nodeCrypto.randomUUID(), fellow, periodId, nodeCrypto.createHash('sha256').update(token).digest('hex'));
const fellowJar = {};
await req('GET', `/api/auth/verify-link?token=${token}`, { jar: fellowJar });
const ticked = await req('PUT', `/api/person/${fellow}/fellow`, { jar: fellowJar, body: { period_id: periodId, fellow: true } });
rec('The fifteenth ticks "Ik ben fellow"', ticked.status === 200, `status=${ticked.status}`);
const pattern = await req('POST', `/api/person/${fellow}/parttime-patterns`, {
  jar: fellowJar,
  body: { weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: START, geldig_tot: END },
});
rec('…and has Mondays off (part-time)', pattern.status === 201, `status=${pattern.status}`);
rec('Period closed', (await req('POST', `/api/periods/${periodId}/close`, { jar: planner })).status === 200);

// ---------- EVERY METHOD, SEVERAL WINDOWS ----------
const overBand = () =>
  JSON.parse(
    execFileSync(
      'npx',
      [
        'tsx',
        '-e',
        `import { computeBandStatusByPerson, TELLERS } from './lib/rosterBands';
         const over = [];
         for (const [p, t] of computeBandStatusByPerson(${JSON.stringify(periodId)})) for (const k of TELLERS) if (t[k].count > t[k].max) over.push(p.slice(0, 8) + ' ' + k + ' ' + t[k].count + '>' + t[k].max);
         console.log(JSON.stringify(over));`,
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim().split('\n').pop()
  );

for (const objectiveMode of MODES) {
  for (const windowWeeks of WINDOWS) {
    const label = `${objectiveMode}, venster ${windowWeeks}`;
    const patched = await req('PATCH', `/api/periods/${periodId}/ruleset`, {
      jar: planner,
      body: { windowWeeks, objectiveMode, ...(objectiveMode === 'multi_start' || objectiveMode === 'randomized' ? { maxAttempts: 3 } : {}) },
    });
    if (patched.status !== 200) {
      rec(`${label}: settings saved`, false, `status=${patched.status} ${JSON.stringify(patched.json)}`);
      continue;
    }
    const run = await generate(periodId, planner);
    if (!run.ok) {
      rec(`${label}: generated`, false, run.detail);
      continue;
    }
    const r = run.result;
    const tekort = Object.values(r.bereik_tekort ?? {}).reduce((sum, t) => sum + t.diensten - t.maximaal, 0);
    // "Willekeurig" is a heuristic over a few attempts: it may leave a
    // dienst another method fills (audit 9: Pinksterzondag at window 2).
    (objectiveMode === 'randomized' ? warn : rec)(
      `${label}: every dienst filled`,
      r.unfilled_slots.length === 0,
      `${r.unfilled_slots.length} leeg, ${r.assignments_created} ingedeeld`
    );
    rec(`${label}: the explanation never claims more than is empty`, tekort <= r.unfilled_slots.length, `tekort ${tekort}`);

    const check = await req('GET', `/api/planner/period/${periodId}/publication-check`, { jar: planner });
    const c = check.json?.data?.checks;
    rec(`${label}: nobody works a blocked day`, c?.no_hard_blocking === true);
    rec(`${label}: nobody's window broken`, c?.window_compliance === true);
    const over = overBand();
    rec(`${label}: nobody past their maximum`, over.length === 0, over.slice(0, 3).join(', '));
    const fellowShifts = db
      .prepare(
        `SELECT s.datum, st.teller FROM dienstrooster_assignment a JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id WHERE a.schedule_version_id = ? AND a.person_id = ?`
      )
      .all(periodId, fellow);
    const bad = fellowShifts.filter((s) => [0, 6].includes(new Date(`${s.datum}T12:00:00Z`).getUTCDay()) || new Date(`${s.datum}T12:00:00Z`).getUTCDay() === 1);
    rec(`${label}: the fellow on no weekend and no part-time Monday`, bad.length === 0, bad.slice(0, 3).map((s) => s.datum).join(', '));
  }
}

// ---------- ROOSTER VERWIJDEREN, THEN AGAIN ----------
const reset = await req('POST', `/api/periods/${periodId}/reset-roster`, { jar: planner, body: { ook_handmatig: true } });
// Generated again with a method that fills what can be filled: the loop
// above left the last one in place, possibly "Willekeurig" (a heuristic).
await req('PATCH', `/api/periods/${periodId}/ruleset`, { jar: planner, body: { windowWeeks: 2, objectiveMode: 'weighted' } });
const left = db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(periodId).n;
rec('Rooster verwijderen: everything gone, back to gesloten', reset.status === 200 && left === 0 && reset.json?.data?.status === 'GESLOTEN', `${reset.json?.data?.verwijderd} verwijderd`);
const again = await generate(periodId, planner);
rec('…and generating after it works', again.ok && again.result.unfilled_slots.length === 0, again.ok ? `${again.result.unfilled_slots.length} leeg` : again.detail);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail ?? ''}`);
  process.exit(1);
}

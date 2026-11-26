import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { readFirstSheet, readPart } from '@/lib/xlsx';
import { writeWorkbook } from '@/lib/xlsxWrite';
import { GET } from '@/app/api/exports/audit-trail/[period-id]/route';
import { inWoorden, periodeLogRijen, watGebeurde } from './periodeLogboek';

/**
 * The rules (1.13.0, the planner's wish): the wijzigingsgeschiedenis has a second tab, "Periode en
 * instellingen", with what the audit log holds about the period. The first tab had only the changes by
 * hand to the roster, and a planner who had changed the deadline, closed and published found it empty.
 *
 * Only this period's rows; in words, never raw codes or ids; only what the log holds (no "was" invented).
 */

const gemaakt: { periodes: string[]; pools: string[]; rulesets: string[]; personen: string[]; logs: string[]; leden: string[] } = {
  periodes: [],
  pools: [],
  rulesets: [],
  personen: [],
  logs: [],
  leden: [],
};

afterEach(() => {
  for (const id of gemaakt.logs.splice(0)) db.prepare('DELETE FROM dienstrooster_audit_log WHERE id = ?').run(id);
  for (const id of gemaakt.leden.splice(0)) db.prepare('DELETE FROM dienstrooster_pool_membership WHERE id = ?').run(id);
  for (const id of gemaakt.periodes.splice(0)) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  for (const id of gemaakt.pools.splice(0)) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of gemaakt.rulesets.splice(0)) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of gemaakt.personen.splice(0)) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
});

function pool(): string {
  const ruleset = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'T', '{}', datetime('now'))`).run(ruleset);
  gemaakt.rulesets.push(ruleset);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'T', ?, datetime('now'))`).run(id, ruleset);
  gemaakt.pools.push(id);
  return id;
}
function persoon(rol: 'PLANNER' | 'DEELNEMER' = 'PLANNER'): { id: string; codenaam: string } {
  const id = crypto.randomUUID();
  const codenaam = `Log-${id.slice(0, 8)}`;
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(id, codenaam, rol);
  gemaakt.personen.push(id);
  return { id, codenaam };
}
function periode(poolId: string, aangemaakt = '2026-10-01T00:00:00Z'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Log', '2027-01-04', '2027-06-06', '2026-12-15T16:00:00Z', 'OPEN', ?)`
  ).run(id, poolId, aangemaakt);
  gemaakt.periodes.push(id);
  return id;
}
function log(actor: string, entiteit: string, entiteitId: string, actie: string, oud: unknown, nieuw: unknown, tijdstip: string): void {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, actor, entiteit, entiteitId, actie, oud === null ? null : JSON.stringify(oud), nieuw === null ? null : JSON.stringify(nieuw), tijdstip);
  gemaakt.logs.push(id);
}

/** The cells of a tab of the workbook by its place (1 = the first), one string per row, tab-separated. */
function tabblad(buf: Buffer, nummer: number): string[] {
  const shared = [...(readPart(buf, 'xl/sharedStrings.xml') ?? '').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) =>
    m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  );
  const xml = readPart(buf, `xl/worksheets/sheet${nummer}.xml`) ?? '';
  // An empty cell is not written: each cell goes to its own column (r="D2").
  return [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
    const cellen: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)\/?>(?:<v>([^<]*)<\/v><\/c>)?/g)) {
      const kolom = (/r="([A-Z]+)\d+"/.exec(c[1])?.[1] ?? 'A').charCodeAt(0) - 65;
      while (cellen.length < kolom) cellen.push('');
      cellen[kolom] = /t="s"/.test(c[1]) ? shared[Number(c[2])] : (c[2] ?? '');
    }
    return cellen.join('\t');
  });
}

async function download(periodId: string, planner: string): Promise<Buffer> {
  const token = createSessionToken({ kind: 'staff', personId: planner, sessionVersion: getSessionVersion(planner)! }, STAFF_SESSION_MAX_AGE_SECONDS);
  const res = await GET(new NextRequest(`http://localhost/api/exports/audit-trail/${periodId}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } }), {
    params: Promise.resolve({ 'period-id': periodId }),
  });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe('the second tab of the wijzigingsgeschiedenis', () => {
  it('has two tabs, the changes to the roster first, as it always was', async () => {
    const planner = persoon();
    const p = periode(pool());
    const buf = await download(p, planner.id);
    const workbook = readPart(buf, 'xl/workbook.xml') ?? '';
    expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(['Wijzigingsgeschiedenis', 'Periode en instellingen']);
    expect(readFirstSheet(buf)[0]).toContain('Aangepast door');
    expect(tabblad(buf, 2)[0]).toBe('Datum wijziging\tWat\tIs nu\tWas\tDoor');
  });

  it('holds what the planner changed about the period, in words, with who did it', async () => {
    const planner = persoon();
    const p = periode(pool());
    log(planner.id, 'period', p, 'UPDATE', { deadline: '2026-12-15T16:00:00Z' }, { wijziging: 'deadline gewijzigd', deadline: '2026-12-22T16:00:00Z' }, '2026-11-01T09:00:00Z');
    log(planner.id, 'period', p, 'UPDATE', { status: 'OPEN' }, { wijziging: 'periode gesloten', status: 'GESLOTEN' }, '2026-11-02T09:00:00Z');
    log(planner.id, 'schedule_period', p, 'GENERATE_ROSTER', { status: 'GESLOTEN' }, { status: 'GEGENEREERD', assignments_created: 150, unfilled_slots: 4, cost: 99 }, '2026-11-03T09:00:00Z');
    log(planner.id, 'schedule_period', p, 'PUBLISH', { status: 'GEGENEREERD' }, { status: 'GEPUBLICEERD', publicatie: 'voorlopig', notifications_sent: 31 }, '2026-11-04T09:00:00Z');
    log(planner.id, 'schedule_period', p, 'UPDATE', { publicatie: 'voorlopig' }, { publicatie: 'definitief', notifications_sent: 31 }, '2026-11-05T09:00:00Z');

    const rijen = tabblad(await download(p, planner.id), 2).slice(1);
    expect(rijen).toHaveLength(5);
    const kol = (i: number) => rijen.map((r) => r.split('\t')[i]);
    expect(kol(1)).toEqual(['Deadline gewijzigd', 'Periode gesloten', 'Rooster gegenereerd', 'Rooster voorlopig gepubliceerd', 'Rooster definitief gemaakt']);
    // Dutch time, dd-mm-jjjj; a status in words; the solver's own cost is no business of the reader.
    expect(rijen[0]).toContain('deadline: 22-12-2026 17:00');
    expect(rijen[0]).toContain('deadline: 15-12-2026 17:00');
    expect(rijen[1]).toContain('status: gesloten');
    expect(rijen[1]).toContain('status: open');
    expect(rijen[2]).toContain('diensten ingedeeld: 150; lege diensten: 4');
    expect(rijen[2]).not.toContain('cost');
    expect(kol(4).every((d) => d === planner.codenaam)).toBe(true);
    // No raw codes anywhere.
    expect(rijen.join('\n')).not.toMatch(/GESLOTEN|GEPUBLICEERD|GENERATE_ROSTER|notifications_sent|_/);
  });

  it('leaves "Was" empty where the log did not keep it, and invents nothing', async () => {
    const planner = persoon();
    const p = periode(pool());
    log(planner.id, 'period', p, 'UPDATE', null, { wijziging: 'automatische herinneringen uit', auto_herinneren: false }, '2026-11-01T09:00:00Z');
    const [rij] = tabblad(await download(p, planner.id), 2).slice(1);
    const cellen = rij.split('\t');
    expect(cellen[1]).toBe('Automatische herinneringen uit');
    expect(cellen[2]).toBe('automatische herinneringen: nee');
    expect(cellen[3]).toBe('');
  });

  it('names a person by codenaam, never by id', async () => {
    const planner = persoon();
    const lid = persoon('DEELNEMER');
    const poolId = pool();
    const p = periode(poolId);
    const membership = crypto.randomUUID();
    log(planner.id, 'pool_membership', membership, 'CREATE', null, { wijziging: 'lid toegevoegd', pool_id: poolId, person_id: lid.id }, '2026-11-01T09:00:00Z');
    const [rij] = tabblad(await download(p, planner.id), 2).slice(1);
    expect(rij).toContain(`persoon: ${lid.codenaam}`);
    expect(rij).not.toContain(lid.id);
    expect(rij).not.toContain(poolId);
  });

  it('holds only this period: not another period, not an account, not the roster changes of the first tab', () => {
    const planner = persoon();
    const poolId = pool();
    const p = periode(poolId);
    const ander = periode(poolId);
    log(planner.id, 'period', p, 'UPDATE', null, { wijziging: 'deadline gewijzigd' }, '2026-11-01T09:00:00Z');
    log(planner.id, 'period', ander, 'UPDATE', null, { wijziging: 'deadline gewijzigd' }, '2026-11-01T09:00:00Z');
    log(planner.id, 'person', planner.id, 'UPDATE', null, { wijziging: 'account aangemaakt' }, '2026-11-01T09:00:00Z');
    log(planner.id, 'assignment', crypto.randomUUID(), 'MANUAL_ASSIGN', null, { person_id: planner.id }, '2026-11-01T09:00:00Z');
    // A link revoked names its period in the row.
    log(planner.id, 'person_access_link', crypto.randomUUID(), 'UPDATE', null, { wijziging: 'persoonlijke link ingetrokken', periode: p }, '2026-11-02T09:00:00Z');
    log(planner.id, 'person_access_link', crypto.randomUUID(), 'UPDATE', null, { wijziging: 'persoonlijke link ingetrokken', periode: ander }, '2026-11-02T09:00:00Z');
    // A change in the pool before this period was made is not about it.
    log(planner.id, 'pool_membership', crypto.randomUUID(), 'CREATE', null, { wijziging: 'lid toegevoegd', pool_id: poolId }, '2026-09-01T09:00:00Z');
    expect(periodeLogRijen(p).map((r) => watGebeurde(r))).toEqual(['Deadline gewijzigd', 'Persoonlijke link ingetrokken']);
  });

  it('gives a row without words of its own a name, and drops the "(test)" the import had while on trial', () => {
    expect(watGebeurde({ entiteit: 'pool_membership', actie: 'DELETE', nieuw_json: null })).toBe('Lid verwijderd');
    expect(watGebeurde({ entiteit: 'period', actie: 'CREATE', nieuw_json: '{"naam":"x"}' })).toBe('Periode aangemaakt');
    expect(watGebeurde({ entiteit: 'period', actie: 'UPDATE', nieuw_json: '{"wijziging":"voorkeuren geïmporteerd (test)"}' })).toBe('Voorkeuren geïmporteerd');
    expect(watGebeurde({ entiteit: 'schedule_period', actie: 'UPDATE', nieuw_json: '{"wijziging":"publicatie_ingetrokken"}' })).toBe('Publicatie ingetrokken');
    expect(inWoorden('{"wijziging":"x","id":"y"}', new Map())).toBeNull();
    expect(inWoorden('niet te lezen', new Map())).toBeNull();
  });
});

describe('the workbook with more tabs', () => {
  it('writes each tab, and one tab gives the file it always did', () => {
    const een = { name: 'Een', columns: [{ header: 'A' }], rows: [['x']] };
    expect(Buffer.compare(writeWorkbook(een), writeWorkbook([een]))).toBe(0);
    const buf = writeWorkbook([een, { name: 'Twee', columns: [{ header: 'B' }], rows: [['y']] }]);
    expect(tabblad(buf, 1)).toEqual(['A', 'x']);
    expect(tabblad(buf, 2)).toEqual(['B', 'y']);
    expect(() => writeWorkbook([een, { ...een, name: 'een' }])).toThrow();
  });
});

describe('the AIOS', () => {
  const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
  it('has its own copy, word for word, and its download has the tab too', () => {
    const kern = (s: string) => s.slice(s.indexOf("import { db } from '@/db/client';"));
    expect(kern(lees('lib/aiosPeriodeLogboek.ts'))).toBe(kern(lees('lib/periodeLogboek.ts')));
    expect(lees('app/api/aios/periode/[id]/download-wijzigingen/route.ts')).toContain(
      'xlsxDownload([aiosWijzigingenGeschiedenis(period), periodeLogboekSheet(period.id)]'
    );
    expect(lees('app/api/aios/periode/[id]/download-wijzigingen/route.ts')).toContain("from '@/lib/aiosPeriodeLogboek'");
  });
});

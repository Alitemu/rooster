import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { readFirstSheet } from '@/lib/xlsx';
import { writeWorkbook } from '@/lib/xlsxWrite';
import { priorRowsInWindow } from '@/lib/priorAssignmentUpload';
import { GET as priorLijst } from '@/app/api/periods/[id]/prior-assignments/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staffCookie, tag, type World } from '../tests/fixtures/dienstWorlds';
import { EERDERE_KOP, SALDO_KOP, kopFout } from './importSjablonen';
import { eerdereToewijzingenSjabloon, eerdereVenster, laadSjabloonPeriode, saldoSjabloon } from './importSjabloonBouwen';

/**
 * The two sjablonen of the achterwacht's imports (lib/importSjabloonBouwen.ts):
 * the beginsaldi with a row per person who takes part, "Eerdere toewijzingen"
 * with a row per day of the window. Filled in, saved and read back they go
 * through the same checks the upload makes.
 */

let snapshot: Map<string, number>;
let w: World;
const periode = () => laadSjabloonPeriode(w.period)!;
const terug = (sheet: Parameters<typeof writeWorkbook>[0]) => readFirstSheet(writeWorkbook(sheet));

beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('ACHTERWACHT');
});
afterAll(() => deleteRowsAfter(snapshot));

describe('the beginsaldo sjabloon', () => {
  it('has the sjabloon\'s header and a row per active member whose membership overlaps the period, by codenaam', () => {
    const rows = terug(saldoSjabloon(periode()));
    expect(kopFout(rows, SALDO_KOP)).toBeNull();
    expect(rows[0]).toEqual([...SALDO_KOP]);
    expect(rows.slice(1).map((r) => r[0])).toEqual([w.xCodenaam, w.yCodenaam].sort((a, b) => a.localeCompare(b, 'nl', { sensitivity: 'base' })));
    expect(rows.slice(1).every((r) => (r[1] ?? '') === '' && (r[2] ?? '') === '')).toBe(true);
  });

  it('leaves out someone deactivated or whose membership ended before the period', () => {
    const weg = insert('dienstrooster_person', { codenaam: `sjabloon-weg-${tag}`, rol: 'DEELNEMER', actief: 0, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: weg, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2098-01-01', geldig_tot: '2098-12-31' });
    const eerder = insert('dienstrooster_person', { codenaam: `sjabloon-eerder-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: eerder, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2098-02-28' });
    const namen = terug(saldoSjabloon(periode())).slice(1).map((r) => r[0]);
    expect(namen).not.toContain(`sjabloon-weg-${tag}`);
    expect(namen).not.toContain(`sjabloon-eerder-${tag}`);
  });

  it('shows what an earlier import gave them, and nothing of a correction made by hand', () => {
    const ledger = (teller: string, delta: number, reden: string, categorie: string) =>
      insert('dienstrooster_ledger_entry', {
        person_id: w.x, pool_id: w.pool, teller, geldt_voor_periode_id: w.period, delta, reden, categorie, aangemaakt_door: w.planner, aangemaakt_op: now,
      });
    ledger('AVOND', -2, 'Geïmporteerd beginsaldo', 'BEGINSALDO');
    ledger('WEEKEND', 1, 'Geïmporteerd beginsaldo', 'BEGINSALDO');
    ledger('AVOND', 5, 'Handmatig', 'CORRECTIE');
    const rij = terug(saldoSjabloon(periode())).find((r) => r[0] === w.xCodenaam)!;
    expect(rij.slice(1)).toEqual(['-2', '1']);
  });
});

describe('the eerdere toewijzingen sjabloon', () => {
  it('has the roster download\'s header, so that file and this one are read the same way', () => {
    const rows = terug(eerdereToewijzingenSjabloon(periode()));
    expect(kopFout(rows, EERDERE_KOP)).toBeNull();
    expect(rows[0]).toEqual([...EERDERE_KOP]);
  });

  it('has a row per day of the window GET .../prior-assignments names, with the right diensttype', async () => {
    const res = await priorLijst(new NextRequest(`http://localhost/api/periods/${w.period}/prior-assignments`, { headers: { cookie: staffCookie(w.planner) } }), {
      params: Promise.resolve({ id: w.period }),
    });
    const [van, tot] = (await res.json()).data.date_range as [string, string];
    expect(eerdereVenster(periode())).toEqual([van, tot]);
    const sheet = eerdereToewijzingenSjabloon(periode());
    const dagen = sheet.rows.map((r) => (r[0] as { date: string }).date);
    const verwacht: string[] = [];
    for (let d = new Date(`${van}T12:00:00Z`); d <= new Date(`${tot}T12:00:00Z`); d = new Date(d.getTime() + 86400000)) verwacht.push(d.toISOString().slice(0, 10));
    expect(dagen).toEqual(verwacht);
    expect(dagen.length).toBeGreaterThan(0);
    // 2098-03-01 and 02 fall in a window of one week before 2098-03-03: a Saturday and a Sunday.
    const type = (datum: string) => sheet.rows.find((r) => (r[0] as { date: string }).date === datum)![2];
    expect(type('2098-03-01')).toBe('Weekend');
    expect(type('2098-02-27')).toBe('Avond');
    // Week numbers are the date's ISO week.
    expect(sheet.rows.find((r) => (r[0] as { date: string }).date === '2098-03-01')![1]).toBe(9);
  });

  it('writes a feestdag as Feestdag (Nieuwjaarsdag is a weekday in 2100)', () => {
    // A pool without an earlier period: the window is the week right before the start.
    const ruleset = insert('dienstrooster_ruleset', { naam: `Sjabloon-${tag}`, config_json: '{}', aangemaakt_op: now });
    const pool = insert('dienstrooster_pool', { naam: `Sjabloon-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
    const sheet = eerdereToewijzingenSjabloon({ ...periode(), pool_id: pool, start_datum: '2100-01-04', eind_datum: '2100-01-17', bevroren_ruleset_json: '{"windowWeeks":1}' });
    const rij = sheet.rows.find((r) => (r[0] as { date: string }).date === '2100-01-01')!;
    expect(rij[2]).toBe('Feestdag');
    expect(sheet.rows.find((r) => (r[0] as { date: string }).date === '2100-01-02')![2]).toBe('Weekend');
  });

  it('writes both days of a weekend feestdag as Feestdag (Kerstmis 2100 is a Saturday and a Sunday)', () => {
    const ruleset = insert('dienstrooster_ruleset', { naam: `Sjabloon-kerst-${tag}`, config_json: '{}', aangemaakt_op: now });
    const pool = insert('dienstrooster_pool', { naam: `Sjabloon-kerst-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
    const sheet = eerdereToewijzingenSjabloon({ ...periode(), pool_id: pool, start_datum: '2100-12-27', eind_datum: '2101-01-09', bevroren_ruleset_json: '{"windowWeeks":1}' });
    const type = (datum: string) => sheet.rows.find((r) => (r[0] as { date: string }).date === datum)![2];
    expect([type('2100-12-24'), type('2100-12-25'), type('2100-12-26')]).toEqual(['Avond', 'Feestdag', 'Feestdag']);
  });

  it('starts from the end of the period before it when that is published, not from its own start', () => {
    const ruleset = insert('dienstrooster_ruleset', { naam: `Sjabloon-vorige-${tag}`, config_json: '{}', aangemaakt_op: now });
    const pool = insert('dienstrooster_pool', { naam: `Sjabloon-vorige-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
    insert('dienstrooster_schedule_period', {
      pool_id: pool, naam: `Vorige-${tag}`, start_datum: '2099-01-05', eind_datum: '2099-02-14', deadline: '2098-12-01T12:00', status: 'GEPUBLICEERD', aangemaakt_op: now,
    });
    // Two weeks after it ended: the window is the week before 2099-02-14, not the week before the new start.
    const nieuw = { ...periode(), pool_id: pool, start_datum: '2099-03-01', eind_datum: '2099-03-14', bevroren_ruleset_json: '{"windowWeeks":1}' };
    expect(eerdereVenster(nieuw)).toEqual(['2099-02-08', '2099-02-14']);
    const dagen = eerdereToewijzingenSjabloon(nieuw).rows.map((r) => (r[0] as { date: string }).date);
    expect(dagen[0]).toBe('2099-02-08');
    expect(dagen.at(-1)).toBe('2099-02-14');
  });

  it('is empty (header only) when the window is switched off', () => {
    const sheet = eerdereToewijzingenSjabloon({ ...periode(), bevroren_ruleset_json: '{"windowWeeks":0}' });
    expect(sheet.rows).toEqual([]);
  });

  it('shows who is entered already, and filled in and read back only those rows import', () => {
    const [van] = eerdereVenster(periode());
    insert('dienstrooster_prior_assignment', {
      period_id: w.period, datum: van, iso_jaar: 2098, iso_week: 9, person_id: w.x, teller: 'AVOND', bron: 'HANDMATIG', aangemaakt_door: w.planner, aangemaakt_op: now,
    });
    const sheet = eerdereToewijzingenSjabloon(periode());
    const ingevuld = sheet.rows.filter((r) => r[3] !== null);
    expect(ingevuld.map((r) => [(r[0] as { date: string }).date, r[3]])).toEqual([[van, w.xCodenaam]]);
    // The planner fills in one more row; the rest stays empty.
    const gekozen = sheet.rows[2];
    gekozen[3] = w.yCodenaam;
    const gelezen = priorRowsInWindow(terug(sheet), eerdereVenster(periode()));
    expect(gelezen.warnings).toEqual([]);
    expect(gelezen.outOfRange).toBe(0);
    expect(gelezen.rows).toHaveLength(2);
    expect(gelezen.rows.map((r) => r.codenaam).sort()).toEqual([w.xCodenaam, w.yCodenaam].sort());
  });
});

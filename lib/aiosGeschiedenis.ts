/**
 * The AIOS's history from before the app (docs/aios-rooster.md,
 * "Eerlijkheid"; G9, O3, O4), read in by the planner from the old Excel:
 * per AIOS the diensten per soort, the feestdagdiensten among them, the fte
 * and the months it covers (the user's choice in October 2026: "aantallen
 * per soort"). lib/aiosSaldo.ts turns it into the saldo of their first
 * quarter in the app.
 *
 * As the achterwacht's imports: a template to download (a row per AIOS of
 * the pool, what was read in before filled in), the file back as base64,
 * first checked (`toepassen` false: what it would mean per AIOS, in words,
 * and every problem), then saved. The file is the whole history of the
 * pool: saving replaces what was there, and an AIOS left out has none.
 */

import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { readFirstSheet, XlsxError } from '@/lib/xlsx';
import { beginstandPunten, beginstandSaldi, aiosSaldoWoorden, laadBeginstand, type Beginstand } from '@/lib/aiosSaldo';
import type { XlsxSheet } from '@/lib/xlsxWrite';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

const KOLOMMEN = [
  { kop: 'Codenaam', veld: null },
  { kop: 'Nachten', veld: 'nachten' },
  { kop: 'Avonden door de week', veld: 'avonden' },
  { kop: 'Avonden in het weekend', veld: 'avonden_weekend' },
  { kop: 'Dagdiensten', veld: 'dagdiensten' },
  { kop: 'Uitloopdiensten', veld: 'uitloopdiensten' },
  { kop: 'Feestdagdiensten (ook bij de soort geteld)', veld: 'feestdagdiensten' },
  { kop: 'Fte', veld: 'fte' },
  { kop: 'Maanden', veld: 'maanden' },
] as const;

type Veld = Exclude<(typeof KOLOMMEN)[number]['veld'], null>;
const AANTALLEN: Veld[] = ['nachten', 'avonden', 'avonden_weekend', 'dagdiensten', 'uitloopdiensten', 'feestdagdiensten'];

/** Everyone of the pool, whenever they were in it: the history is theirs. */
function poolLeden(poolId: string): Array<{ id: string; codenaam: string }> {
  return db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam FROM dienstrooster_pool_membership pm JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? ORDER BY p.codenaam COLLATE NOCASE`
    )
    .all(poolId) as Array<{ id: string; codenaam: string }>;
}

export function aiosGeschiedenisSjabloon(period: AiosUitnodigPeriode): XlsxSheet {
  const al = new Map(laadBeginstand(period.pool_id).map((b) => [b.person_id, b]));
  return {
    name: 'Geschiedenis AIOS',
    columns: KOLOMMEN.map((k) => ({ header: k.kop, width: k.veld === null ? 16 : Math.max(10, k.kop.length) })),
    rows: poolLeden(period.pool_id).map((p) => {
      const b = al.get(p.id);
      return [p.codenaam, ...KOLOMMEN.slice(1).map((k) => (b ? b[k.veld as Veld] : null))];
    }),
    frozenColumns: 1,
  };
}

export interface GeschiedenisRij {
  codenaam: string;
  punten: number;
  feestdagdiensten: number;
  fte: number;
  maanden: number;
  // What it means for their first quarter in the app, in words.
  gevolg: string;
}

export interface GeschiedenisPlan {
  rijen: GeschiedenisRij[];
  problemen: string[];
}

const getal = (cel: string | undefined): number | null => {
  const t = (cel ?? '').trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

function plan(poolId: string, rows: string[][]): { plan: GeschiedenisPlan; rijen: Beginstand[] } {
  const problemen: string[] = [];
  const [kop, ...data] = rows;
  if (!kop || kop.length < KOLOMMEN.length || KOLOMMEN.some((k, i) => (kop[i] ?? '').trim() !== k.kop)) {
    return {
      plan: { rijen: [], problemen: ['De kolommen kloppen niet. Gebruik het sjabloon van "Sjabloon downloaden" en laat de eerste rij staan.'] },
      rijen: [],
    };
  }
  const leden = new Map(poolLeden(poolId).map((p) => [p.codenaam.toLowerCase(), p]));
  const gezien = new Set<string>();
  const rijen: Beginstand[] = [];
  const codenaam = new Map<string, string>();
  data.forEach((r, i) => {
    const regel = i + 2;
    const naam = (r[0] ?? '').trim();
    if (naam === '' && r.slice(1).every((c) => (c ?? '').trim() === '')) return;
    const lid = leden.get(naam.toLowerCase());
    if (!lid) {
      problemen.push(`Rij ${regel}: "${naam}" is geen AIOS van deze pool.`);
      return;
    }
    if (gezien.has(lid.id)) {
      problemen.push(`Rij ${regel}: ${lid.codenaam} staat er twee keer in.`);
      return;
    }
    // A row with only the codenaam: nothing read in for them.
    if (r.slice(1).every((c) => (c ?? '').trim() === '')) return;
    gezien.add(lid.id);
    const waarde: Partial<Record<Veld, number>> = {};
    for (const [j, k] of KOLOMMEN.entries()) {
      if (k.veld === null) continue;
      const n = getal(r[j]);
      if (AANTALLEN.includes(k.veld)) {
        if (n === null) waarde[k.veld] = 0;
        else if (!Number.isInteger(n) || n < 0 || n > 10_000) problemen.push(`Rij ${regel}, ${k.kop}: vul een heel aantal in, 0 of meer.`);
        else waarde[k.veld] = n;
      } else if (k.veld === 'fte') {
        if (n === null || !(n > 0 && n <= 1)) problemen.push(`Rij ${regel}, Fte: vul een getal in groter dan 0 en hoogstens 1, zoals 0,8.`);
        else waarde.fte = n;
      } else if (n === null || !(n > 0 && n <= 240)) {
        problemen.push(`Rij ${regel}, Maanden: vul het aantal maanden in waar de aantallen over gaan, hoogstens 240.`);
      } else waarde.maanden = n;
    }
    const diensten = AANTALLEN.filter((k) => k !== 'feestdagdiensten').reduce((som, k) => som + (waarde[k] ?? 0), 0);
    if (waarde.feestdagdiensten !== undefined && waarde.feestdagdiensten > diensten) {
      // Each is also counted at its soort: more than all of them together is a typing error.
      problemen.push(`Rij ${regel}, Feestdagdiensten: hoogstens zoveel als de diensten samen, want een feestdagdienst is ook bij zijn soort geteld.`);
      return;
    }
    if (Object.keys(waarde).length === KOLOMMEN.length - 1) {
      rijen.push({ person_id: lid.id, ...(waarde as Record<Veld, number>) });
      codenaam.set(lid.id, lid.codenaam);
    }
  });
  const saldi = beginstandSaldi(rijen);
  return {
    plan: {
      problemen,
      rijen: rijen.map((b) => ({
        codenaam: codenaam.get(b.person_id)!,
        punten: Math.round(beginstandPunten(b) * 10) / 10,
        feestdagdiensten: b.feestdagdiensten,
        fte: b.fte,
        maanden: b.maanden,
        gevolg: aiosSaldoWoorden(saldi.get(b.person_id)!),
      })),
    },
    rijen,
  };
}

export type GeschiedenisUitkomst =
  | { ok: true; plan: GeschiedenisPlan; toegepast: boolean }
  | { ok: false; status: number; code: string; message: string; plan?: GeschiedenisPlan };

/** `bestand`: the .xlsx as base64, as the panel sends it. */
export function importeerAiosGeschiedenis(period: AiosUitnodigPeriode, bestand: unknown, toepassen: boolean): GeschiedenisUitkomst {
  if (typeof bestand !== 'string' || bestand.trim() === '') {
    return { ok: false, status: 400, code: 'NO_FILE', message: 'Kies eerst een Excel-bestand.' };
  }
  let rows: string[][];
  try {
    rows = readFirstSheet(Buffer.from(bestand, 'base64'));
  } catch (error) {
    if (error instanceof XlsxError) return { ok: false, status: 400, code: 'NOT_XLSX', message: error.message };
    throw error;
  }
  const { plan: uitkomst, rijen } = plan(period.pool_id, rows);
  if (!toepassen) return { ok: true, plan: uitkomst, toegepast: false };
  if (uitkomst.problemen.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'IMPORT_PROBLEMS',
      message: 'Het bestand heeft nog problemen. Er is niets veranderd. Los ze eerst op en controleer opnieuw.',
      plan: uitkomst,
    };
  }
  const op = new Date().toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM dienstrooster_aios_beginstand WHERE pool_id = ?').run(period.pool_id);
    const insert = db.prepare(
      `INSERT INTO dienstrooster_aios_beginstand
         (id, pool_id, person_id, nachten, avonden, avonden_weekend, dagdiensten, uitloopdiensten, feestdagdiensten, fte, maanden, ingelezen_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const b of rijen) {
      insert.run(randomUUID(), period.pool_id, b.person_id, b.nachten, b.avonden, b.avonden_weekend, b.dagdiensten, b.uitloopdiensten, b.feestdagdiensten, b.fte, b.maanden, op);
    }
  })();
  return { ok: true, plan: uitkomst, toegepast: true };
}

/** What is read in now, with what it means per AIOS. */
export function aiosGeschiedenisStand(period: AiosUitnodigPeriode): { rijen: GeschiedenisRij[]; ingelezen_op: string | null } {
  const rijen = laadBeginstand(period.pool_id);
  const saldi = beginstandSaldi(rijen);
  const naam = new Map(poolLeden(period.pool_id).map((p) => [p.id, p.codenaam]));
  const op = db.prepare('SELECT MAX(ingelezen_op) AS op FROM dienstrooster_aios_beginstand WHERE pool_id = ?').get(period.pool_id) as { op: string | null };
  return {
    ingelezen_op: op.op,
    rijen: rijen
      .map((b) => ({
        codenaam: naam.get(b.person_id) ?? b.person_id,
        punten: Math.round(beginstandPunten(b) * 10) / 10,
        feestdagdiensten: b.feestdagdiensten,
        fte: b.fte,
        maanden: b.maanden,
        gevolg: aiosSaldoWoorden(saldi.get(b.person_id)!),
      }))
      .sort((x, y) => x.codenaam.localeCompare(y.codenaam, 'nl')),
  };
}

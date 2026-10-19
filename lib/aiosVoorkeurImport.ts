/**
 * Bulk import of the AIOS's voorkeurenoverzicht ("Voorkeuren per dienst",
 * lib/aiosDownloads.ts) after it was filled in and saved in Excel: one row
 * per dienst, one column per AIOS, read from the .xlsx (lib/xlsx.ts). A
 * copy of what lib/preferencesImport.ts does for the achterwacht, on the
 * AIOS's own rules (docs/development/diensten.md, "Copied, not changed").
 * A test tool for the beheerder only (POST /api/aios/periode/[id]/
 * voorkeuren-import).
 *
 * - A cell is what the AIOS's own screen sets: "geblokkeerd", "liever niet"
 *   or "voorkeur", set as setAiosVoorkeur sets it (a block as a whole, the
 *   rules of a feestdag and of leave kept). An empty cell takes a hand mark
 *   away. A cell the export wrote with a reason, "(parttime)" or
 *   "(afwezig)", comes from a part-time day or an absence, which keep it in
 *   step themselves: it is skipped, and an empty cell never clears one.
 * - After a geblokkeerd or liever niet comes the AIOS's own toelichting of
 *   that day, as the export writes it: "geblokkeerd: ziek kind"
 *   (lib/aiosReden.ts). A day has one: a different text on two diensten of
 *   a day is a problem, and none takes the toelichting away.
 * - Checking (`toepassen` false) changes nothing and lists every change and
 *   every row, column or cell that can't be read. It is the very same work
 *   as applying, in a transaction that is rolled back, so what it says is
 *   what applying does. Applying refuses a file with problems: half an
 *   import is worse than none.
 * - Only before the roster is made: a roster rests on the preferences.
 */

import { db } from '@/db/client';
import { readFirstSheet, XlsxError } from '@/lib/xlsx';
import { parseSheetDate } from '@/lib/isoDate';
import { withoutFormulaGuard } from '@/lib/csv';
import { aiosDeelnemers, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { loadAiosPeriode, setAiosVoorkeur, type Niveau } from '@/lib/aiosPreferences';
import { loadAiosRedenen, saveAiosReden } from '@/lib/aiosReden';
import { schrijfAiosVoorkeurBackup } from '@/lib/aiosVoorkeurBackup';

const NIVEAU_VAN_WOORD: Record<string, Niveau> = {
  geblokkeerd: 'ABSOLUUT',
  'liever niet': 'LIEVER_NIET',
  voorkeur: 'VOORKEUR',
};
const WOORD_VAN_NIVEAU: Record<Niveau, string> = {
  ABSOLUUT: 'geblokkeerd',
  LIEVER_NIET: 'liever niet',
  VOORKEUR: 'voorkeur',
};
const CEL = /^(geblokkeerd|liever niet|voorkeur)(?::\s*(.+))?$/;
const AUTOMATISCH = /^(geblokkeerd|liever niet|voorkeur) \((parttime|afwezig)\)$/;

/** Statuses in which the preferences can still change; after them a roster rests on them. */
const INVOER_STATUSSEN = ['OPEN', 'GESLOTEN'];

export interface ImportWijziging {
  codenaam: string;
  datum: string;
  dienst: string;
  van: string;
  naar: string;
}

export interface ImportPlan {
  wijzigingen: ImportWijziging[];
  problemen: string[];
  overgeslagen: number;
  personen: number;
}

export type ImportUitkomst =
  | { ok: true; plan: ImportPlan; toegepast: boolean }
  | { ok: false; status: number; code: string; message: string };

interface Cel {
  personId: string;
  codenaam: string;
  slotId: string;
  datum: string;
  dienst: string;
  regel: number;
  doel: Niveau | null;
  tekst: string | null;
}

interface Gelezen {
  cellen: Cel[];
  problemen: string[];
  overgeslagen: number;
}

/** What the person has now: per `${person}|${slot}` the level and where it came from. */
function huidigeMarkeringen(periodId: string): Map<string, { level: Niveau | null; bron: string }> {
  const rijen = db
    .prepare(
      `SELECT av.person_id, av.slot_id, av.blocking_level AS level, av.source AS bron
       FROM dienstrooster_availability av JOIN dienstrooster_shift_slot sl ON sl.id = av.slot_id
       WHERE sl.period_id = ?`
    )
    .all(periodId) as Array<{ person_id: string; slot_id: string; level: Niveau | null; bron: string }>;
  return new Map(rijen.map((r) => [`${r.person_id}|${r.slot_id}`, { level: r.level, bron: r.bron }]));
}

function lees(period: AiosUitnodigPeriode, rows: string[][]): Gelezen {
  const problemen: string[] = [];
  const cellen: Cel[] = [];
  let overgeslagen = 0;

  const kop = rows[0] ?? [];
  const klein = kop.map((h) => h.toLowerCase());
  const datumKol = klein.indexOf('datum');
  const dienstKol = klein.indexOf('dienst');
  if (datumKol === -1 || dienstKol === -1) {
    return {
      cellen,
      problemen: ['De kolommen Datum en Dienst ontbreken. Gebruik het bestand van "Voorkeurenoverzicht downloaden".'],
      overgeslagen,
    };
  }
  const eerstePersoonKol = Math.max(datumKol, dienstKol, klein.indexOf('dag'), klein.indexOf('week'), klein.indexOf('tijd'), klein.indexOf('blok'), klein.indexOf('feestdag')) + 1;

  const deelnemers = aiosDeelnemers(period);
  const exact = new Map(deelnemers.map((p) => [p.codenaam, p]));
  const hoofdletterloos = new Map(deelnemers.map((p) => [p.codenaam.toLowerCase(), p]));
  const alle = db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE rol = 'DEELNEMER'`).all() as Array<{ id: string; codenaam: string }>;
  const bekend = new Set(alle.map((p) => p.codenaam.toLowerCase()));

  const kolommen: Array<{ kol: number; id: string; codenaam: string }> = [];
  for (let kol = eerstePersoonKol; kol < kop.length; kol++) {
    const naam = kop[kol];
    if (!naam) continue;
    const zonderGuard = withoutFormulaGuard(naam);
    const persoon = exact.get(naam) ?? hoofdletterloos.get(naam.toLowerCase()) ?? exact.get(zonderGuard) ?? hoofdletterloos.get(zonderGuard.toLowerCase());
    if (!persoon) {
      problemen.push(
        bekend.has(naam.toLowerCase()) || bekend.has(zonderGuard.toLowerCase())
          ? `Kolom "${naam}": doet niet mee aan deze periode.`
          : `Kolom "${naam}": geen deelnemer met deze codenaam.`
      );
      continue;
    }
    if (kolommen.some((k) => k.id === persoon.id)) {
      problemen.push(`Kolom "${naam}" staat twee keer in het bestand.`);
      continue;
    }
    kolommen.push({ kol, id: persoon.id, codenaam: persoon.codenaam });
  }

  const slots = db
    .prepare(
      `SELECT sl.id, sl.datum, st.code FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id WHERE sl.period_id = ?`
    )
    .all(period.id) as Array<{ id: string; datum: string; code: string }>;
  const slotVan = new Map(slots.map((s) => [`${s.datum}|${s.code}`, s.id]));
  const huidig = huidigeMarkeringen(period.id);

  const gezienOp = new Map<string, number>();
  for (let r = 1; r < rows.length; r++) {
    const rij = rows[r];
    const regel = r + 1;
    const datum = parseSheetDate(rij[datumKol] ?? '');
    const dienstWoord = rij[dienstKol] ?? '';
    const code = dienstWoord.split(' ')[0]?.toUpperCase() ?? '';
    if (!datum || !code) {
      problemen.push(`Regel ${regel}: datum "${rij[datumKol] ?? ''}" of dienst "${dienstWoord}" is niet te lezen.`);
      continue;
    }
    const slotId = slotVan.get(`${datum}|${code}`);
    if (!slotId) {
      problemen.push(`Regel ${regel}: geen ${dienstWoord.toLowerCase()} op ${datum} in deze periode.`);
      continue;
    }
    const eerder = gezienOp.get(slotId);
    if (eerder !== undefined) {
      problemen.push(`Regel ${regel}: de ${dienstWoord.toLowerCase()} op ${datum} staat ook op regel ${eerder}.`);
      continue;
    }
    gezienOp.set(slotId, regel);

    for (const { kol, id, codenaam } of kolommen) {
      const ruw = (rij[kol] ?? '').trim();
      const cel = ruw.toLowerCase();
      const nu = huidig.get(`${id}|${slotId}`);
      const automatisch = nu && nu.level && nu.bron !== 'MANUAL';
      if (AUTOMATISCH.test(cel)) {
        overgeslagen++;
        continue;
      }
      if (cel === '') {
        // Never clears a part-time or absence mark.
        if (automatisch) continue;
        cellen.push({ personId: id, codenaam, slotId, datum, dienst: dienstWoord, regel, doel: null, tekst: null });
        continue;
      }
      const gevonden = CEL.exec(cel);
      if (!gevonden) {
        problemen.push(`Regel ${regel}, ${codenaam}: "${ruw}" is geen geblokkeerd, liever niet of voorkeur.`);
        continue;
      }
      const niveau = NIVEAU_VAN_WOORD[gevonden[1]];
      // The text as typed, not lowercased: the part after the colon of the cell itself.
      const tekst = gevonden[2] ? ruw.slice(ruw.indexOf(':') + 1).trim() : null;
      if (tekst && niveau === 'VOORKEUR') {
        problemen.push(`Regel ${regel}, ${codenaam}: een toelichting kan alleen bij geblokkeerd of liever niet.`);
        continue;
      }
      if (automatisch) {
        // A mark of a part-time day or an absence stays as it is.
        overgeslagen++;
        continue;
      }
      cellen.push({ personId: id, codenaam, slotId, datum, dienst: dienstWoord, regel, doel: niveau, tekst: tekst || null });
    }
  }
  return { cellen, problemen, overgeslagen };
}

/** Thrown to roll a transaction back after it was run to see what it does. */
class TerugDraaien extends Error {}

/**
 * Does what the file says, in a transaction; with `terug` it is rolled back
 * after the work, so checking and applying are the same work.
 */
function voerUit(period: AiosUitnodigPeriode, gelezen: Gelezen, terug: boolean): { plan: ImportPlan; aangeraakt: Set<string> } {
  const problemen = [...gelezen.problemen];
  const wijzigingen: ImportWijziging[] = [];
  const aangeraakt = new Set<string>();
  const aiosPeriode = loadAiosPeriode(period.id)!;
  const voor = huidigeMarkeringen(period.id);
  const redenVoor = new Map<string, Map<string, string>>();
  for (const id of new Set(gelezen.cellen.map((c) => c.personId))) {
    redenVoor.set(id, new Map(loadAiosRedenen(id, period.id).map((r) => [r.datum, r.tekst])));
  }

  const werk = () => {
    // The marks first.
    const gevraagd = new Set<string>();
    for (const cel of gelezen.cellen) {
      const nu = voor.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      if (nu === cel.doel) continue;
      const uitkomst = setAiosVoorkeur(cel.personId, period.id, cel.slotId, cel.doel);
      if (!uitkomst.ok) {
        problemen.push(`Regel ${cel.regel}, ${cel.codenaam}: ${uitkomst.message}`);
        continue;
      }
      gevraagd.add(`${cel.personId}|${cel.slotId}`);
    }
    // A block is one choice: what the file says per dienst has to agree with what the block ended as.
    const na = huidigeMarkeringen(period.id);
    const gemeld = new Set<string>();
    for (const cel of gelezen.cellen) {
      if (!gevraagd.has(`${cel.personId}|${cel.slotId}`) && (voor.get(`${cel.personId}|${cel.slotId}`)?.level ?? null) !== cel.doel) continue;
      const nu = na.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      if (nu === cel.doel) continue;
      const sleutel = `${cel.personId}|${cel.datum}|${cel.dienst}`;
      if (gemeld.has(sleutel)) continue;
      gemeld.add(sleutel);
      problemen.push(`Regel ${cel.regel}, ${cel.codenaam}: de keuze voor de ${cel.dienst.toLowerCase()} op ${cel.datum} past niet bij de rest van het blok.`);
    }
    for (const cel of gelezen.cellen) {
      const was = voor.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      const wordt = na.get(`${cel.personId}|${cel.slotId}`)?.level ?? null;
      if (was === wordt) continue;
      aangeraakt.add(cel.personId);
      wijzigingen.push({
        codenaam: cel.codenaam,
        datum: cel.datum,
        dienst: cel.dienst.toLowerCase(),
        van: was ? WOORD_VAN_NIVEAU[was] : 'leeg',
        naar: wordt ? WOORD_VAN_NIVEAU[wordt] : 'leeg',
      });
    }

    // Then the toelichting per day: one text a day, from the cells that are geblokkeerd or liever niet.
    const perDag = new Map<string, { cel: Cel; teksten: Set<string> }>();
    for (const cel of gelezen.cellen) {
      if (cel.doel !== 'ABSOLUUT' && cel.doel !== 'LIEVER_NIET') continue;
      const sleutel = `${cel.personId}|${cel.datum}`;
      const groep = perDag.get(sleutel) ?? { cel, teksten: new Set<string>() };
      if (cel.tekst) groep.teksten.add(cel.tekst);
      perDag.set(sleutel, groep);
    }
    for (const { cel, teksten } of perDag.values()) {
      if (teksten.size > 1) {
        problemen.push(`${cel.codenaam}, ${cel.datum}: twee verschillende toelichtingen op één dag. Een dag heeft er één.`);
        continue;
      }
      const eerder = redenVoor.get(cel.personId)?.get(cel.datum) ?? null;
      const nieuw = [...teksten][0] ?? null;
      if (eerder === nieuw) continue;
      const uitkomst = saveAiosReden(cel.personId, aiosPeriode, cel.datum, nieuw);
      if (!uitkomst.ok) {
        problemen.push(`${cel.codenaam}, ${cel.datum}: ${uitkomst.message}`);
        continue;
      }
      aangeraakt.add(cel.personId);
      wijzigingen.push({ codenaam: cel.codenaam, datum: cel.datum, dienst: 'toelichting', van: eerder ?? 'leeg', naar: nieuw ?? 'leeg' });
    }
    if (terug) throw new TerugDraaien();
  };

  try {
    db.transaction(werk)();
  } catch (error) {
    if (!(error instanceof TerugDraaien)) throw error;
  }
  return {
    plan: { wijzigingen, problemen, overgeslagen: gelezen.overgeslagen, personen: aangeraakt.size },
    aangeraakt,
  };
}

/** `bestand`: the .xlsx as base64, as the dialog sends it. */
export function importeerAiosVoorkeuren(period: AiosUitnodigPeriode, bestand: unknown, toepassen: boolean): ImportUitkomst {
  if (typeof bestand !== 'string' || bestand.trim() === '') {
    return { ok: false, status: 400, code: 'NO_FILE', message: 'Kies eerst een Excel-bestand.' };
  }
  if (!INVOER_STATUSSEN.includes(period.status)) {
    return {
      ok: false,
      status: 409,
      code: 'INVALID_STATUS',
      message:
        period.status === 'CONCEPT'
          ? 'Open de periode eerst. Dan pas kunnen voorkeuren worden ingelezen.'
          : 'Het rooster van deze periode is al gemaakt. Voorkeuren importeren kan alleen daarvoor.',
    };
  }
  let rows: string[][];
  try {
    rows = readFirstSheet(Buffer.from(bestand, 'base64'));
  } catch (error) {
    if (error instanceof XlsxError) return { ok: false, status: 400, code: 'NOT_XLSX', message: error.message };
    throw error;
  }
  const gelezen = lees(period, rows);
  // Always done once to see what it does; applying does it again, for real.
  const controle = voerUit(period, gelezen, true);
  if (!toepassen) return { ok: true, plan: controle.plan, toegepast: false };
  if (controle.plan.problemen.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'IMPORT_PROBLEMS',
      message: 'Het bestand heeft nog problemen. Er is niets veranderd. Los ze eerst op en controleer opnieuw.',
    };
  }
  const echt = voerUit(period, gelezen, false);
  for (const personId of echt.aangeraakt) {
    try {
      schrijfAiosVoorkeurBackup(personId, period.id);
    } catch (backupError) {
      console.error('aios-voorkeur-backup-write-failed', backupError);
    }
  }
  return { ok: true, plan: echt.plan, toegepast: true };
}
